using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

// This process owns the input hooks and the always-visible controls together. If it
// exits or stops publishing its heartbeat, native input refuses to continue.
class ComputerOverlay : ApplicationContext
{
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MouseEvent { public Point pt; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KeyEvent { public uint key, scan, flags, time; public UIntPtr extra; }
    delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int type, Hook callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder title, int size);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, out bool value, uint flags);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect value, int size);

    public class Policy { public string epoch, stop; public bool paused; public string[] allowed; }
    public class Presentation { public string id, epoch, session, windowId, action, theme, effects; public int pid, processId; public double at; public int? x, y; public bool reducedMotion; }
    // The design effects are drawn by the app's own window. This process still owns the hooks,
    // the heartbeat and the decision to show them: only while that window has loaded, and an
    // action is acknowledged only after that window reports the visual for it as shown.
    volatile bool designReady;
    volatile string shownId;
    bool designMode;
    string ackedId, lastState, stateTitle;
    bool stateDark;
    public Action<string> Output = line => { lock (Console.Out) { Console.Out.WriteLine(line); Console.Out.Flush(); } };
    readonly string directory;
    readonly int parent;
    readonly JavaScriptSerializer json = new JavaScriptSerializer();
    readonly Timer timer = new Timer();
    readonly Surface outline = new Surface(true);
    readonly Surface pill = new Surface(false);
    readonly Button pause = new Button(), stop = new Button();
    readonly Label title = new Label(), detail = new Label();
    readonly Hook mouseCallback, keyCallback;
    IntPtr mouseHook, keyHook;
    Presentation current;
    Policy policy;
    bool watching, paused, handedOff, stopping;
    string lastId, dismissed;
    double changedAt;
    double heartbeat;
    Point lastPointer;
    bool hasPointer;
    string lastError;
    public static double Now { get { return (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; } }
    static bool Alive(int pid) { try { using (var p = Process.GetProcessById(pid)) return !p.HasExited; } catch { return false; } }

    public ComputerOverlay(string folder, int owner)
    {
        directory = folder; parent = owner;
        mouseCallback = Mouse; keyCallback = Keyboard;
        mouseHook = SetWindowsHookEx(14, mouseCallback, GetModuleHandle(null), 0);
        keyHook = SetWindowsHookEx(13, keyCallback, GetModuleHandle(null), 0);
        if (mouseHook == IntPtr.Zero || keyHook == IntPtr.Zero) { Dispose(); throw new Exception("Windows could not install the handoff hooks."); }
        pill.ClientSize = new Size(486, 72);
        title.SetBounds(28, 13, 265, 22); title.Font = new Font("Segoe UI", 10, FontStyle.Bold); title.UseMnemonic = false;
        detail.SetBounds(28, 37, 265, 22); detail.Font = new Font("Segoe UI", 8); detail.AutoEllipsis = true;
        pause.SetBounds(306, 18, 84, 36); stop.SetBounds(398, 18, 64, 36);
        foreach (var button in new[] { pause, stop }) { button.FlatStyle = FlatStyle.Flat; button.FlatAppearance.BorderSize = 0; button.Font = new Font("Segoe UI", 9, FontStyle.Bold); button.Cursor = Cursors.Hand; }
        stop.Text = "Stop"; stop.AccessibleName = "Stop Computer Use across all projects";
        pause.Click += delegate { if (paused) { Console.WriteLine("resume"); Console.Out.Flush(); } else Pause(false, false); };
        stop.Click += delegate { Pause(false, true); };
        pill.Controls.AddRange(new Control[] { title, detail, pause, stop });
        timer.Interval = 40; timer.Tick += delegate { Tick(); }; timer.Start();
    }
    string ReadText(string name) {
        using (var stream = new FileStream(Path.Combine(directory, name), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
            if (stream.Length > 65536) throw new Exception("Oversized Computer Use state.");
            using (var reader = new StreamReader(stream)) return reader.ReadToEnd();
        }
    }
    T Read<T>(string name) { return json.Deserialize<T>(ReadText(name)); }
    string StopToken() { var file = Path.Combine(directory, "stop"); return File.Exists(file) ? ReadText("stop") : ""; }
    void Atomic(string name, string text) {
        var file = Path.Combine(directory, name); var temp = Path.Combine(directory, Guid.NewGuid() + ".tmp");
        try { File.WriteAllText(temp, text, new UTF8Encoding(false)); if (File.Exists(file)) File.Replace(temp, file, null); else File.Move(temp, file); }
        finally { if (File.Exists(temp)) File.Delete(temp); }
    }
    public void Pause(bool user, bool end) {
        if (current == null && !end) return;
        watching = false; paused = true; handedOff = user;
        try { Atomic("stop", (end ? "stop:" : user ? "handoff:" : "pause:") + Guid.NewGuid().ToString()); } catch { stopping = true; }
        outline.Conceal();
        if (end) { dismissed = current == null ? null : current.id; current = null; pill.Conceal(); }
        else PaintPill();
        Emit();
    }
    IntPtr Mouse(int code, IntPtr message, IntPtr data) {
        if (code >= 0 && watching) {
            var e = (MouseEvent)Marshal.PtrToStructure(data, typeof(MouseEvent));
            if ((e.flags & 1) == 0) {
                bool moved = !hasPointer || Math.Abs(e.pt.X - lastPointer.X) + Math.Abs(e.pt.Y - lastPointer.Y) >= 3;
                if (message.ToInt32() != 0x200 || moved) Pause(true, false);
            }
            if ((e.flags & 1) != 0) { lastPointer = e.pt; hasPointer = true; }
        }
        return CallNextHookEx(mouseHook, code, message, data);
    }
    IntPtr Keyboard(int code, IntPtr message, IntPtr data) {
        if (code >= 0 && watching) {
            var e = (KeyEvent)Marshal.PtrToStructure(data, typeof(KeyEvent));
            if ((e.flags & 0x10) == 0) Pause(true, false);
        }
        return CallNextHookEx(keyHook, code, message, data);
    }
    void Tick() {
        try {
            if (stopping || !Alive(parent)) { ExitThread(); return; }
            policy = Read<Policy>("permissions.json");
            var p = Read<Presentation>("presentation.json");
            if (p != null && p.id == dismissed) { Clear(); return; }
            if (p == null || String.IsNullOrEmpty(p.id) || !Alive(p.pid) || Now - p.at > 300000 || p.at > Now + 1000) { Clear(); return; }
            long handle; uint pid;
            if (!long.TryParse(p.windowId, out handle) || handle <= 0 || !IsWindow(new IntPtr(handle)) || GetWindowThreadProcessId(new IntPtr(handle), out pid) == 0 || pid != p.processId) { Clear(); return; }
            current = p;
            timer.Interval = 40;
            bool animation; SystemParametersInfo(0x1042, 0, out animation, 0);
            bool reduced = p.reducedMotion || !animation || SystemInformation.HighContrast;
            designMode = p.effects == "design" && designReady && !reduced;
            bool ready = policy != null && !policy.paused && policy.epoch == p.epoch && (policy.stop ?? "") == StopToken();
            if (!ready) {
                if (StopToken().StartsWith("stop:") || policy == null || policy.allowed == null || policy.allowed.Length == 0) { dismissed = p.id; paused = false; Clear(); return; }
                if (watching) { paused = true; handedOff = false; }
                watching = false; outline.Conceal(); if (paused) PaintPill(); else pill.Conceal(); Emit(); return;
            }
            paused = false; handedOff = false;
            Rect bounds;
            var target = new IntPtr(handle);
            if (!IsWindowVisible(target) || IsIconic(target) || !GetWindowRect(target, out bounds) || bounds.Right <= bounds.Left || bounds.Bottom <= bounds.Top) { Clear(); return; }
            var screen = Screen.PrimaryScreen.Bounds;
            var rect = Rectangle.Intersect(Rectangle.FromLTRB(bounds.Left, bounds.Top, bounds.Right, bounds.Bottom), screen);
            if (rect.IsEmpty) { Clear(); return; }
            outline.ReducedMotion = reduced;
            outline.Bounds = rect; outline.Current = p;
            bool changed = lastId != p.id;
            if (changed) { outline.FromX = outline.ToX ?? p.x; outline.FromY = outline.ToY ?? p.y; outline.ToX = p.x; outline.ToY = p.y; lastId = p.id; changedAt = Now; }
            outline.Elapsed = Now - changedAt;
            // Controls sit outside the captured window when space permits. All surfaces
            // are excluded from capture and the outline never intercepts target clicks.
            var work = Screen.PrimaryScreen.WorkingArea;
            int y = rect.Top >= work.Top + 90 ? rect.Top - 82 : work.Top + 12;
            int left = Math.Max(work.Left + 8, Math.Min(work.Right - pill.Width - 8, rect.Left + (rect.Width - pill.Width) / 2));
            var controls = new Rectangle(left - 20, y - 20, pill.Width + 40, pill.Height + 40);
            if (p.x.HasValue && p.y.HasValue && controls.Contains(p.x.Value, p.y.Value)) y = work.Bottom - pill.Height - 12;
            pill.Location = new System.Drawing.Point(left, y);
            if (!watching) hasPointer = GetCursorPos(out lastPointer);
            watching = p.action != "approval";
            PaintPill();
            if (!designMode && GetForegroundWindow() == target) { if (!outline.IsShown) outline.Present(); outline.Invalidate(); } else outline.Conceal();
            Emit();
            if ((!designMode || shownId == p.id) && (Now - heartbeat > 200 || changed || ackedId != p.id)) { Atomic("monitor-ready.json", json.Serialize(new { pid = Process.GetCurrentProcess().Id, epoch = p.epoch, id = p.id, at = Now })); heartbeat = Now; ackedId = p.id; }
        } catch (Exception error) {
            lastError = error.Message;
            try { if (StopToken().StartsWith("stop:")) { paused = false; Clear(); return; } } catch { Clear(); return; }
            if (paused && current != null) { watching = false; outline.Conceal(); PaintPill(); Emit(); timer.Interval = 200; } else Clear();
        }
    }
    // One line per change of what the design window should show, in physical screen pixels.
    void Emit() {
        string text;
        var p = current; long handle;
        if (p == null || !long.TryParse(p.windowId, out handle)) text = json.Serialize(new { t = "state", mode = "hidden" });
        else {
            var window = new IntPtr(handle);
            var r = Rectangle.Intersect(Visible(window), Screen.PrimaryScreen.Bounds);
            text = json.Serialize(new { t = "state", mode = paused ? "paused" : "active", design = designMode, effects = p.effects == "design" ? "design" : "classic", id = p.id, window = p.windowId, action = p.action, x = p.x, y = p.y, rect = new { x = r.X, y = r.Y, w = r.Width, h = r.Height }, focused = GetForegroundWindow() == window, title = stateTitle ?? "", dark = stateDark, handoff = handedOff });
        }
        if (text == lastState) return;
        lastState = text; Output(text);
    }
    // The visible frame: Windows 10 and 11 report invisible resize borders in GetWindowRect.
    static Rectangle Visible(IntPtr window) {
        Rect r;
        if (DwmGetWindowAttribute(window, 9, out r, Marshal.SizeOf(typeof(Rect))) != 0 && !GetWindowRect(window, out r)) return Rectangle.Empty;
        return Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom);
    }
    public void Shown(string id) { shownId = id; }
    public void SetDesign(bool on) { designReady = on; }
    public void Command(string line) {
        try {
            if (line == "effects on") designReady = true;
            else if (line == "effects off") designReady = false;
            else if (line.StartsWith("shown ")) shownId = line.Substring(6).Trim();
            else if (line.StartsWith("capture ")) Capture(line.Substring(8).Trim());
        } catch (Exception error) { Output(new JavaScriptSerializer().Serialize(new { t = "capture", ok = false, error = error.Message })); }
    }
    // Pixels of the presented window only, for the design window to redraw; written inside this
    // folder, which the app reads and deletes at once.
    void Capture(string file) {
        var serializer = new JavaScriptSerializer();
        var full = Path.GetFullPath(file);
        var root = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var p = current; long handle; Rect outer;
        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !full.EndsWith(".png", StringComparison.OrdinalIgnoreCase) || p == null || paused || !long.TryParse(p.windowId, out handle)) { Output(serializer.Serialize(new { t = "capture", ok = false })); return; }
        var window = new IntPtr(handle);
        if (IsIconic(window) || !GetWindowRect(window, out outer)) { Output(serializer.Serialize(new { t = "capture", ok = false })); return; }
        var whole = Rectangle.FromLTRB(outer.Left, outer.Top, outer.Right, outer.Bottom);
        var part = Rectangle.Intersect(Rectangle.Intersect(Visible(window), Screen.PrimaryScreen.Bounds), whole);
        if (part.Width < 8 || part.Height < 8) { Output(serializer.Serialize(new { t = "capture", ok = false })); return; }
        using (var image = new Bitmap(whole.Width, whole.Height, System.Drawing.Imaging.PixelFormat.Format32bppArgb)) {
            using (var g = Graphics.FromImage(image)) { var dc = g.GetHdc(); try { PrintWindow(window, dc, 2); } finally { g.ReleaseHdc(dc); } }
            using (var crop = image.Clone(new Rectangle(part.X - whole.X, part.Y - whole.Y, part.Width, part.Height), System.Drawing.Imaging.PixelFormat.Format24bppRgb)) crop.Save(full, System.Drawing.Imaging.ImageFormat.Png);
        }
        Output(serializer.Serialize(new { t = "capture", ok = true, file = full, rect = new { x = part.X, y = part.Y, w = part.Width, h = part.Height } }));
    }
    void PaintPill() {
        if (current == null) return;
        bool dark = current.theme == "dark";
        if (current.theme != "dark" && current.theme != "light") {
            using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")) dark = key == null || Convert.ToInt32(key.GetValue("AppsUseLightTheme", 0)) == 0;
        }
        pill.Dark = outline.Dark = dark;
        pill.Accent = paused ? Color.FromArgb(222, 158, 58) : Color.FromArgb(96, 165, 250);
        var bg = dark ? Color.FromArgb(20, 28, 43) : Color.FromArgb(244, 248, 255);
        pill.BackColor = bg;
        title.BackColor = detail.BackColor = bg;
        title.ForeColor = dark ? Color.FromArgb(229, 239, 255) : Color.FromArgb(22, 43, 72);
        detail.ForeColor = dark ? Color.FromArgb(155, 177, 206) : Color.FromArgb(67, 88, 115);
        var name = new StringBuilder(180); long handle;
        if (long.TryParse(current.windowId, out handle)) GetWindowText(new IntPtr(handle), name, name.Capacity);
        title.Text = paused ? (handedOff ? "You're in control" : "Computer Use paused") : "zer0ne controls " + (name.Length > 0 ? name.ToString() : "this app");
        string fullTitle = title.Text;
        stateTitle = name.Length > 0 ? name.ToString() : "this app"; stateDark = dark;
        while (title.Text.Length > 2 && TextRenderer.MeasureText(title.Text, title.Font).Width > title.Width) title.Text = title.Text.Substring(0, title.Text.Length - 2) + "\u2026";
        title.AccessibleName = fullTitle;
        detail.Text = paused ? "Resume explicitly in app permissions" : ActionName(current.action) + "  |  Ctrl + Alt + Esc to stop";
        pause.Text = paused ? "Resume..." : "Pause"; pause.AccessibleName = paused ? "Open Computer Use permissions to resume" : "Pause Computer Use";
        pause.BackColor = dark ? Color.FromArgb(39, 56, 79) : Color.FromArgb(220, 232, 251); pause.ForeColor = title.ForeColor;
        stop.BackColor = dark ? Color.FromArgb(67, 35, 42) : Color.FromArgb(253, 227, 230); stop.ForeColor = dark ? Color.FromArgb(255, 155, 160) : Color.FromArgb(159, 42, 55);
        if (designMode) { pill.Conceal(); return; }
        if (!pill.IsShown) pill.Present(); pill.Invalidate();
    }
    public static string ActionName(string action) {
        switch (action) {
            case "approval": return "Waiting for approval";
            case "click": return "Clicking"; case "double_click": return "Double-clicking"; case "right_click": return "Right-clicking";
            case "move": return "Moving pointer"; case "scroll": return "Scrolling"; case "type": return "Typing"; case "key": return "Pressing keys";
            default: return "Checking the screen";
        }
    }
    void Clear() { watching = false; current = null; outline.Conceal(); pill.Conceal(); timer.Interval = 200; Emit(); }
    protected override void Dispose(bool disposing) {
        watching = false; timer.Stop();
        if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
        if (keyHook != IntPtr.Zero) UnhookWindowsHookEx(keyHook);
        if (disposing) { timer.Dispose(); outline.Dispose(); pill.Dispose(); }
        base.Dispose(disposing);
    }
    [STAThread] static int Main(string[] args) {
        try {
            SetProcessDPIAware(); Application.EnableVisualStyles(); Console.InputEncoding = Encoding.UTF8;
            using (var context = new ComputerOverlay(args[0], int.Parse(args[1]))) {
                System.Threading.Tasks.Task.Run(delegate { string line; while ((line = Console.ReadLine()) != null) context.Command(line); context.stopping = true; });
                Application.Run(context);
            }
            return 0;
        }
        catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }

    class Surface : Form {
        [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr window, uint affinity);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
        readonly bool passThrough;
        public bool Dark = true, ReducedMotion;
        public Color Accent = Color.FromArgb(96, 165, 250);
        public Presentation Current;
        public double Elapsed;
        public int? FromX, FromY, ToX, ToY;
        public Surface(bool passthrough) {
            passThrough = passthrough; FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
            // A decoration must never become the foreground window, including when
            // WinForms processes queued mouse/activation messages during a show.
            Enabled = !passthrough;
            if (passthrough && Region != null) { var old = Region; Region = null; old.Dispose(); }
            BackColor = Color.Fuchsia; TransparencyKey = passthrough ? Color.Fuchsia : Color.Empty; DoubleBuffered = true;
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        public bool IsShown { get { return IsHandleCreated && IsWindowVisible(Handle); } }
        public void Present() {
            var window = Handle;
            foreach (Control control in Controls) { var child = control.Handle; }
            // Form.Show can activate an owned WinForms target's newest top-level
            // window. Native NOACTIVATE is required even inside the same UI thread.
            ShowWindow(window, 4);
            SetWindowPos(window, new IntPtr(-1), Left, Top, Width, Height, 0x10 | 0x40);
        }
        public void Conceal() { if (IsHandleCreated) ShowWindow(Handle, 0); }
        protected override void WndProc(ref Message message) {
            if (message.Msg == 0x21) { message.Result = new IntPtr(3); return; }
            if (passThrough && message.Msg == 0x84) { message.Result = new IntPtr(-1); return; }
            base.WndProc(ref message);
        }
        protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x80 | (passThrough ? 0x20 : 0); return p; } }
        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); SetWindowDisplayAffinity(Handle, 0x11); }
        protected override void OnResize(EventArgs e) {
            base.OnResize(e);
            if (!passThrough && Width > 28 && Height > 28) {
                using (var shape = RoundedDrawing.Shape(new Rectangle(0, 0, Width, Height), 14)) { var old = Region; Region = new Region(shape); if (old != null) old.Dispose(); }
            }
        }
        protected override void OnPaint(PaintEventArgs e) {
            base.OnPaint(e); var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
            if (!passThrough) {
                using (var b = new SolidBrush(Dark ? Color.FromArgb(20, 28, 43) : Color.FromArgb(244, 248, 255))) g.FillRoundedRectangle(b, new Rectangle(1, 1, Width - 3, Height - 3), 14);
                using (var pen = new Pen(Accent, 1)) g.DrawRoundedRectangle(pen, new Rectangle(1, 1, Width - 3, Height - 3), 14);
                using (var b = new SolidBrush(Accent)) g.FillEllipse(b, 13, 22, 7, 7);
                return;
            }
            g.SmoothingMode = SmoothingMode.None;
            for (int i = 5; i >= 1; i--) using (var pen = new Pen(Color.FromArgb(60 + (5 - i) * 9, 108 + (5 - i) * 14, 182 + (5 - i) * 17), i == 1 ? 2 : 1)) g.DrawRectangle(pen, i, i, Math.Max(0, Width - i * 2 - 1), Math.Max(0, Height - i * 2 - 1));
            if (Current == null || !Current.x.HasValue || !Current.y.HasValue || Elapsed > 1400) return;
            int x = Current.x.Value - Left, y = Current.y.Value - Top;
            if (!ReducedMotion && FromX.HasValue && FromY.HasValue) { double t = Math.Min(1, Elapsed / 180); t = 1 - Math.Pow(1 - t, 3); x = (int)(FromX.Value + (Current.x.Value - FromX.Value) * t) - Left; y = (int)(FromY.Value + (Current.y.Value - FromY.Value) * t) - Top; }
            if (x < 0 || y < 0 || x >= Width || y >= Height) return;
            using (var pen = new Pen(Accent, 2)) {
                g.DrawEllipse(pen, x - 12, y - 12, 24, 24);
                if (!ReducedMotion && Current.action.Contains("click")) { int radius = 14 + (int)(Math.Min(650, Elapsed) / 30); if (Elapsed < 650) g.DrawEllipse(pen, x - radius, y - radius, radius * 2, radius * 2); }
            }
            using (var font = new Font("Segoe UI", 8, FontStyle.Bold)) {
                string text = "z  " + ActionName(Current.action); var size = TextRenderer.MeasureText(text, font);
                var box = new Rectangle(Math.Max(8, Math.Min(Width - size.Width - 24, x + 20)), Math.Max(12, Math.Min(Height - 35, y + 18)), size.Width + 16, 26);
                using (var b = new SolidBrush(Dark ? Color.FromArgb(20, 28, 43) : Color.FromArgb(244, 248, 255))) g.FillRoundedRectangle(b, box, 7);
                TextRenderer.DrawText(g, text, font, box, Dark ? Color.FromArgb(219, 234, 254) : Color.FromArgb(22, 43, 72), TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            }
        }
    }
}
static class RoundedDrawing {
    public static GraphicsPath Shape(Rectangle r, int radius) { int d = radius * 2; var p = new GraphicsPath(); p.AddArc(r.Left, r.Top, d, d, 180, 90); p.AddArc(r.Right - d, r.Top, d, d, 270, 90); p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); p.AddArc(r.Left, r.Bottom - d, d, d, 90, 90); p.CloseFigure(); return p; }
    public static void FillRoundedRectangle(this Graphics g, Brush b, Rectangle r, int radius) { using (var p = Shape(r, radius)) g.FillPath(b, p); }
    public static void DrawRoundedRectangle(this Graphics g, Pen pen, Rectangle r, int radius) { using (var p = Shape(r, radius)) g.DrawPath(pen, p); }
}
