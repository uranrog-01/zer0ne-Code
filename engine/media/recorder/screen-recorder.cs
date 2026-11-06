// Local Windows workflow recorder. Screenshots and shortcut metadata only:
// character text, clipboard contents and raw audio are never logged.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

class ScreenRecorder {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, Hook callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr window, uint affinity);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    delegate IntPtr Hook(int code, IntPtr w, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] struct MouseData { public Point point; public uint data, flags, time; public IntPtr extra; }
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly Stopwatch Clock = new Stopwatch();
    static Hook mouseCallback, keyCallback;
    static IntPtr mouseHook, keyHook;
    static Form panel;
    static Label label;
    static Button pauseButton;
    static bool paused, cancelled;
    static long lastTyping, lastFrame;
    static int frames, display;
    static string folder;
    static Rectangle bounds;

    static void Emit(object item) { Console.WriteLine(Json.Serialize(item)); Console.Out.Flush(); }
    static string App() {
        uint pid;
        GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        try { return pid == (uint)Process.GetCurrentProcess().Id ? "recorder" : Process.GetProcessById((int)pid).ProcessName; }
        catch { return "application"; }
    }
    static bool Down(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }
    static void Pause() {
        paused = !paused;
        pauseButton.Text = paused ? "Resume" : "Pause";
        Emit(new { type = "state", state = paused ? "paused" : "recording", at = Clock.ElapsedMilliseconds });
    }
    static void Capture() {
        if (paused || frames >= 300) return;
        // Ignore the first three seconds, giving the user time to switch apps.
        if (Clock.ElapsedMilliseconds < 3000) return;
        using (var full = new Bitmap(bounds.Width, bounds.Height)) {
            using (var g = Graphics.FromImage(full)) g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
            int width = Math.Min(1280, full.Width);
            int height = Math.Max(1, full.Height * width / full.Width);
            using (var small = new Bitmap(width, height)) {
                using (var g = Graphics.FromImage(small)) {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    g.DrawImage(full, 0, 0, width, height);
                }
                string file = Path.Combine(folder, (++frames).ToString("D6") + ".jpg");
                var codec = Array.Find(ImageCodecInfo.GetImageEncoders(), x => x.MimeType == "image/jpeg");
                using (var quality = new EncoderParameters(1)) {
                    quality.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 70L);
                    small.Save(file, codec, quality);
                }
                Emit(new { type = "frame", index = frames, at = Clock.ElapsedMilliseconds, width = width, height = height });
            }
        }
        lastFrame = Clock.ElapsedMilliseconds;
    }
    static IntPtr Mouse(int code, IntPtr w, IntPtr l) {
        if (code >= 0 && !paused && Clock.ElapsedMilliseconds >= 3000 && ((int)w == 0x201 || (int)w == 0x204 || (int)w == 0x20A)) {
            var data = (MouseData)Marshal.PtrToStructure(l, typeof(MouseData));
            string app = App();
            if (app != "recorder" && bounds.Contains(data.point)) {
                Emit(new { type = "event", at = Clock.ElapsedMilliseconds, action = (int)w == 0x20A ? "scroll" : (int)w == 0x204 ? "right-click" : "click", x = data.point.X - bounds.X, y = data.point.Y - bounds.Y, app = app });
            }
        }
        return CallNextHookEx(mouseHook, code, w, l);
    }
    static IntPtr Key(int code, IntPtr w, IntPtr l) {
        if (code >= 0 && !paused && Clock.ElapsedMilliseconds >= 3000 && ((int)w == 0x100 || (int)w == 0x104)) {
            int key = Marshal.ReadInt32(l);
            string app = App();
            if (app != "recorder" && Screen.FromHandle(GetForegroundWindow()).Bounds == bounds && key != 16 && key != 17 && key != 18 && key != 91 && key != 92 && !(key >= 160 && key <= 165)) {
                bool ctrl = Down(17), alt = Down(18), win = Down(91) || Down(92);
                bool special = key == 9 || key == 13 || key == 27 || (key >= 33 && key <= 40) || key == 8 || key == 46 || (key >= 112 && key <= 123);
                // AltGr produces ordinary characters on many keyboard layouts.
                if (!Down(165) && (ctrl || alt || win || special)) {
                    string shortcut = (ctrl ? "Ctrl+" : "") + (alt ? "Alt+" : "") + (win ? "Win+" : "") + (Down(16) ? "Shift+" : "") + ((Keys)key).ToString();
                    Emit(new { type = "event", at = Clock.ElapsedMilliseconds, action = "shortcut", shortcut = shortcut, app = app });
                } else if (Clock.ElapsedMilliseconds - lastTyping > 1000) {
                    lastTyping = Clock.ElapsedMilliseconds;
                    Emit(new { type = "event", at = Clock.ElapsedMilliseconds, action = "typing", app = app });
                }
            }
        }
        return CallNextHookEx(keyHook, code, w, l);
    }
    [STAThread] static int Main(string[] args) {
        try {
            SetProcessDPIAware();
            if (args.Length > 0 && args[0] == "--displays") {
                for (int i = 0; i < Screen.AllScreens.Length; i++) {
                    var s = Screen.AllScreens[i];
                    Emit(new { index = i, width = s.Bounds.Width, height = s.Bounds.Height, primary = s.Primary });
                }
                return 0;
            }
            if (args.Length < 1) throw new Exception("Missing recording folder.");
            folder = Path.GetFullPath(args[0]);
            display = args.Length > 1 ? int.Parse(args[1]) : 0;
            if (display < 0 || display >= Screen.AllScreens.Length) throw new Exception("That display is no longer available.");
            bounds = Screen.AllScreens[display].Bounds;
            Directory.CreateDirectory(folder);
            Application.EnableVisualStyles();
            panel = new Form { Text = "zer0ne · Recording", TopMost = true, FormBorderStyle = FormBorderStyle.FixedToolWindow, StartPosition = FormStartPosition.Manual, Size = new Size(440, 90), Location = new Point(bounds.Right - 460, bounds.Top + 20), BackColor = Color.FromArgb(28, 28, 30), ForeColor = Color.White };
            label = new Label { Text = "Starting in 3 seconds…", Location = new Point(12, 10), Size = new Size(400, 20) };
            pauseButton = new Button { Text = "Pause", Location = new Point(12, 34), Width = 90 };
            var finish = new Button { Text = "Finish", Location = new Point(112, 34), Width = 90 };
            var discard = new Button { Text = "Discard", Location = new Point(212, 34), Width = 90 };
            pauseButton.Click += (s, e) => Pause();
            finish.Click += (s, e) => panel.Close();
            discard.Click += (s, e) => { cancelled = true; panel.Close(); };
            panel.Controls.AddRange(new Control[] { label, pauseButton, finish, discard });
            mouseCallback = Mouse; keyCallback = Key;
            mouseHook = SetWindowsHookEx(14, mouseCallback, GetModuleHandle(null), 0);
            keyHook = SetWindowsHookEx(13, keyCallback, GetModuleHandle(null), 0);
            if (mouseHook == IntPtr.Zero || keyHook == IntPtr.Zero) throw new Exception("Windows refused the input observation hooks.");
            Clock.Start();
            Emit(new { type = "state", state = "recording", width = bounds.Width, height = bounds.Height, display = display });
            var timer = new System.Windows.Forms.Timer { Interval = 250 };
            timer.Tick += (s, e) => {
                try {
                    label.Text = (paused ? "Paused · " : "Recording · ") + (Clock.ElapsedMilliseconds / 1000) + "s · " + frames + " frames";
                    if (Clock.ElapsedMilliseconds - lastFrame >= 1000) Capture();
                    if (Clock.ElapsedMilliseconds >= 300000) panel.Close();
                } catch (Exception ex) { Emit(new { type = "error", error = ex.Message }); cancelled = true; panel.Close(); }
            };
            timer.Start();
            var input = new Thread(() => {
                string line;
                while ((line = Console.ReadLine()) != null) {
                    string command = line;
                    try { panel.BeginInvoke(new Action(() => {
                        if (command == "pause" && !paused || command == "resume" && paused) Pause();
                        if (command == "stop" || command == "cancel") { cancelled = command == "cancel"; panel.Close(); }
                    })); } catch { break; }
                }
                // Losing the extension host stops capture rather than leaving an orphan.
                try { panel.BeginInvoke(new Action(() => { cancelled = true; panel.Close(); })); } catch { }
            });
            input.IsBackground = true;
            panel.Shown += (s, e) => { SetWindowDisplayAffinity(panel.Handle, 0x11); input.Start(); };
            Application.Run(panel);
            timer.Dispose();
            Emit(new { type = "done", cancelled = cancelled, frames = frames, durationMs = Clock.ElapsedMilliseconds });
            return 0;
        } catch (Exception ex) { Emit(new { type = "error", error = ex.Message }); return 1; }
        finally { if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook); if (keyHook != IntPtr.Zero) UnhookWindowsHookEx(keyHook); }
    }
}
