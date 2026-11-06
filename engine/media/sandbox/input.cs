// zer0ne computer-use helper for Windows: screenshots and mouse / keyboard
// input for the agent's `computer` tool. Actions require approval unless the
// chat uses Full access. Compiled on first use with the
// C# compiler that ships with Windows.
//
//   input screenshot <out.jpg> <maxWidth>   → prints JSON display/image bounds
//   input click <x> <y> [left|right|middle] [count]
//   input move <x> <y>
//   input scroll <x> <y> <clicks>            (positive = up)
//   input type                               (text on stdin)
//   input key <combo>                        e.g. ctrl+s, alt+tab, enter
//   input cursor                             → prints "<x> <y>"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using System.Web.Script.Serialization;

static class Input
{
	[StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public int mouseData; public uint dwFlags, time; public IntPtr dwExtraInfo; }
	[StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
	[StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
	[StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
	[StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
	[StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
	[StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; public uint privateData; }

	[DllImport("user32.dll")] static extern bool SetProcessDPIAware();
	[DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
	[DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
	[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
	[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
	[DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
	[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
	[DllImport("user32.dll")] static extern bool IsIconic(IntPtr handle);
	[DllImport("user32.dll")] static extern IntPtr GetShellWindow();
	[DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int count);
	[DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
	[DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
	[DllImport("user32.dll")] static extern bool PeekMessage(out MSG message, IntPtr window, uint min, uint max, uint remove);
	[DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
	[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
	[DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
	[DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
	[DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
	delegate bool EnumWindow(IntPtr window, IntPtr param);
	[DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr param);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
	[DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
	[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
	static IntPtr inputWindow;
	static uint inputProcess;
	static string policyFile, policyEpoch;
	static bool pointer;
	static POINT pointerPosition;
	class Policy { public string epoch; public bool paused; public string[] allowed; public string stop; }
	static string ReadShared(string file)
	{
		// Permission edits and Stop replace files atomically while input is running.
		using (var stream = new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.ReadWrite | FileShare.Delete)) {
			if (stream.Length > 65536) throw new ArgumentException("Computer Use permission file is too large.");
			using (var reader = new StreamReader(stream)) return reader.ReadToEnd();
		}
	}
	static string AppPath(uint pid)
	{
		IntPtr process = OpenProcess(0x1000, false, pid);
		if (process == IntPtr.Zero) throw new ArgumentException("Cannot identify this app. Choose another app in Computer Use permissions.");
		try { uint size = 32768; var text = new StringBuilder((int)size); if (!QueryFullProcessImageName(process, 0, text, ref size)) throw new ArgumentException("Cannot identify this app."); return text.ToString(); }
		finally { CloseHandle(process); }
	}
	static void Permit(IntPtr window, uint pid)
	{
		if (String.IsNullOrEmpty(policyFile) || String.IsNullOrEmpty(policyEpoch)) throw new ArgumentException("Computer Use requires app permissions.");
		if (!SameWindow(window, pid)) throw new ArgumentException("The screenshot window changed or closed. Take a new screenshot.");
		Policy policy;
		try { policy = new JavaScriptSerializer().Deserialize<Policy>(ReadShared(policyFile)); }
		catch { throw new ArgumentException("Computer Use permissions are unavailable. No input was sent."); }
		if (policy == null || policy.paused || policy.epoch != policyEpoch || policy.allowed == null) throw new ArgumentException("Computer Use stopped or permissions changed. Resume and take a new screenshot.");
		string stopFile = Path.Combine(Path.GetDirectoryName(policyFile),"stop"), stop = File.Exists(stopFile) ? ReadShared(stopFile) : "";
		if ((policy.stop ?? "") != stop) throw new ArgumentException("Computer Use stopped. Resume and take a new screenshot.");
		string app = AppPath(pid);
		if (!Array.Exists(policy.allowed, value => String.Equals(value, app, StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("This app is not allowed. Open Computer Use permissions to allow it.");
	}
	static Rectangle Bounds(IntPtr window)
	{
		RECT r; if (!GetWindowRect(window, out r)) throw new ArgumentException("The app window is unavailable.");
		var bounds = Rectangle.Intersect(Rectangle.FromLTRB(r.Left, r.Top, r.Right, r.Bottom), Screen.PrimaryScreen.Bounds);
		if (bounds.Width < 1 || bounds.Height < 1) throw new ArgumentException("Move this app to the primary display and take a new screenshot.");
		return bounds;
	}

	static bool SameWindow(IntPtr window, uint process)
	{
		uint owner;
		if (window == IntPtr.Zero || window == GetShellWindow() || window == GetDesktopWindow() || GetWindowThreadProcessId(window, out owner) == 0 || owner != process || !IsWindowVisible(window) || IsIconic(window)) return false;
		int cloaked; if (DwmGetWindowAttribute(window,14,out cloaked,sizeof(int)) == 0 && cloaked != 0) return false;
		var name = new StringBuilder(128); GetClassName(window,name,name.Capacity);
		return !Array.Exists(new[] {"Progman","WorkerW","Shell_TrayWnd","Shell_SecondaryTrayWnd"}, value => value == name.ToString());
	}

	static void Focus(string value, bool keyboard)
	{
		var parts = value.Split(',');
		long handle; uint process;
		if (parts.Length != 2 || !long.TryParse(parts[0], out handle) || !uint.TryParse(parts[1], out process) || handle <= 0 || process == 0)
			throw new ArgumentException("Invalid screenshot window. Take a new screenshot.");
		var window = new IntPtr(handle);
		Permit(window, process);
		if (GetForegroundWindow() != window)
		{
			// Approval can activate zer0ne; return to the window observed before approval.
			MSG message; PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
			uint ignored, current = GetCurrentThreadId(), foreground = GetWindowThreadProcessId(GetForegroundWindow(), out ignored);
			bool attached = foreground != 0 && foreground != current && AttachThreadInput(current, foreground, true);
			try { SetForegroundWindow(window); }
			finally { if (attached) AttachThreadInput(current, foreground, false); }
		}
		if (GetForegroundWindow() != window || !SameWindow(window, process)) throw new ArgumentException("Windows could not restore the screenshot window. Take a new screenshot; no input was sent.");
		inputWindow = window; inputProcess = process;
	}

	const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
	const uint KEYUP = 0x2, UNICODE = 0x4;
	const uint LDOWN = 0x2, LUP = 0x4, RDOWN = 0x8, RUP = 0x10, MDOWN = 0x20, MUP = 0x40, WHEEL = 0x800;

	static void Send(INPUT[] inputs)
	{
		Permit(inputWindow, inputProcess);
		CheckMonitor();
		if (inputWindow != IntPtr.Zero && (GetForegroundWindow() != inputWindow || !SameWindow(inputWindow, inputProcess)))
			throw new ArgumentException("Keyboard focus changed. Take a new screenshot; input stopped.");
		if (pointer) {
			POINT actual;
			if (!GetCursorPos(out actual) || actual.X != pointerPosition.X || actual.Y != pointerPosition.Y || GetAncestor(WindowFromPoint(actual), 2) != inputWindow) throw new ArgumentException("The pointer moved or another window covers this location. Take a new screenshot.");
			// SendInput inserts one batch without interleaving physical input: bind the click/wheel to its reviewed point.
			var desktop = SystemInformation.VirtualScreen;
			var move = MouseInput(0x0001 | 0x8000 | 0x4000);
			move.u.mi.dx = (int)(((long)(pointerPosition.X-desktop.Left)*65536+32768)/desktop.Width);
			move.u.mi.dy = (int)(((long)(pointerPosition.Y-desktop.Top)*65536+32768)/desktop.Height);
			var batch = new INPUT[inputs.Length+1]; batch[0] = move; inputs.CopyTo(batch,1); inputs = batch;
		}
		if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length)
			throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows rejected input. The target may be elevated or the desktop locked.");
	}

	static void Move(string x, string y)
	{
		int px = int.Parse(x), py = int.Parse(y);
		if (!Screen.PrimaryScreen.Bounds.Contains(px, py)) throw new ArgumentException("Coordinates are outside the primary display. Take a new screenshot.");
		Permit(inputWindow, inputProcess);
		CheckMonitor();
		pointerPosition = new POINT { X = px, Y = py };
		if (!Bounds(inputWindow).Contains(px, py) || GetAncestor(WindowFromPoint(pointerPosition), 2) != inputWindow) throw new ArgumentException("This location is outside the screenshot app or covered by another window. Take a new screenshot.");
		pointer = true;
		// SendInput marks this move as injected so the handoff hook cannot mistake
		// the agent's own pointer movement for the user's physical mouse.
		var desktop = SystemInformation.VirtualScreen;
		var move = MouseInput(0x0001 | 0x8000 | 0x4000);
		move.u.mi.dx = (int)(((long)(px-desktop.Left)*65536+32768)/desktop.Width);
		move.u.mi.dy = (int)(((long)(py-desktop.Top)*65536+32768)/desktop.Height);
		if (SendInput(1, new[] {move}, Marshal.SizeOf(typeof(INPUT))) != 1) throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows rejected the pointer move.");
		// Injected pointer moves are queued; do not check the click location until
		// Windows has consumed the move. A physical takeover still invalidates Permit.
		for (int attempt = 0; attempt < 50; attempt++) {
			POINT actual; Permit(inputWindow, inputProcess);
			if (GetCursorPos(out actual) && actual.X == px && actual.Y == py) return;
			System.Threading.Thread.Sleep(2);
		}
		throw new ArgumentException("The pointer moved before input. Take a new screenshot.");
	}
	class Monitor { public int pid; public string epoch, id; public double at; }
	static void CheckMonitor()
	{
		string dir = Path.GetDirectoryName(policyFile);
		if (!File.Exists(Path.Combine(dir, "monitor-required.json"))) return;
		try {
			var serializer = new JavaScriptSerializer();
			var ready = serializer.Deserialize<Monitor>(ReadShared(Path.Combine(dir, "monitor-ready.json")));
			var shown = serializer.Deserialize<Monitor>(ReadShared(Path.Combine(dir, "presentation.json")));
			double now = (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
			if (ready == null || shown == null || ready.epoch != policyEpoch || ready.id != shown.id || ready.pid <= 0 || Math.Abs(now-ready.at) > 1500) throw new Exception();
			using (var monitor = Process.GetProcessById(ready.pid)) if (monitor.HasExited) throw new Exception();
		} catch { throw new ArgumentException("Computer Use controls or handoff monitoring stopped. Resume in app permissions; no input was sent."); }
	}

	static INPUT MouseInput(uint flags, int data = 0)
	{
		var i = new INPUT { type = INPUT_MOUSE };
		i.u.mi = new MOUSEINPUT { dwFlags = flags, mouseData = data };
		return i;
	}

	static INPUT KeyInput(ushort vk, bool up)
	{
		var i = new INPUT { type = INPUT_KEYBOARD };
		i.u.ki = new KEYBDINPUT { wVk = vk, dwFlags = up ? KEYUP : 0 };
		return i;
	}

	static void Unicode(List<INPUT> inputs, char c)
	{
		var down = new INPUT { type = INPUT_KEYBOARD };
		down.u.ki = new KEYBDINPUT { wScan = c, dwFlags = UNICODE };
		var up = new INPUT { type = INPUT_KEYBOARD };
		up.u.ki = new KEYBDINPUT { wScan = c, dwFlags = UNICODE | KEYUP };
		inputs.Add(down); inputs.Add(up);
	}

	static readonly Dictionary<string, ushort> Keys = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
	{
		{ "ctrl", 0x11 }, { "control", 0x11 }, { "shift", 0x10 }, { "alt", 0x12 }, { "win", 0x5B }, { "meta", 0x5B }, { "cmd", 0x5B },
		{ "enter", 0x0D }, { "return", 0x0D }, { "tab", 0x09 }, { "esc", 0x1B }, { "escape", 0x1B }, { "space", 0x20 }, { "backspace", 0x08 },
		{ "delete", 0x2E }, { "del", 0x2E }, { "insert", 0x2D }, { "home", 0x24 }, { "end", 0x23 }, { "pageup", 0x21 }, { "pagedown", 0x22 },
		{ "left", 0x25 }, { "up", 0x26 }, { "right", 0x27 }, { "down", 0x28 }, { "printscreen", 0x2C },
		{ "f1", 0x70 }, { "f2", 0x71 }, { "f3", 0x72 }, { "f4", 0x73 }, { "f5", 0x74 }, { "f6", 0x75 }, { "f7", 0x76 }, { "f8", 0x77 }, { "f9", 0x78 }, { "f10", 0x79 }, { "f11", 0x7A }, { "f12", 0x7B }
	};

	static ushort Vk(string name)
	{
		ushort vk;
		if (Keys.TryGetValue(name, out vk)) return vk;
		if (name.Length == 1)
		{
			char c = char.ToUpperInvariant(name[0]);
			if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c;
		}
		throw new ArgumentException("unknown key: " + name);
	}

	static int Main(string[] args)
	{
		SetProcessDPIAware();
		Console.InputEncoding = new UTF8Encoding(false);
		Console.OutputEncoding = new UTF8Encoding(false);
		try
		{
			if (args.Length > 0 && args[0] == "windows") {
				var apps = new List<object>();
				EnumWindows(delegate(IntPtr window, IntPtr param) {
					uint pid; GetWindowThreadProcessId(window, out pid);
					if (!SameWindow(window, pid) || apps.Count >= 100) return true;
					var text = new StringBuilder(161); GetWindowText(window, text, text.Capacity); if (text.Length == 0) return true;
					try { string app = AppPath(pid); apps.Add(new {path=app, name=Path.GetFileNameWithoutExtension(app), title=text.ToString(), windowId=window.ToInt64().ToString(), processId=pid}); } catch { }
					return true;
				}, IntPtr.Zero);
				Console.WriteLine(new JavaScriptSerializer().Serialize(apps)); return 0;
			}
			int policyIndex = Array.IndexOf(args, "--policy"), epochIndex = Array.IndexOf(args, "--epoch");
			if (policyIndex >= 0 && policyIndex + 1 < args.Length) policyFile = args[policyIndex + 1];
			if (epochIndex >= 0 && epochIndex + 1 < args.Length) policyEpoch = args[epochIndex + 1];
			int focusIndex = Array.IndexOf(args, "--focus");
			if (focusIndex >= 0)
			{
				if (focusIndex + 1 >= args.Length) throw new ArgumentException("Missing screenshot window.");
				Focus(args[focusIndex + 1], args[0] == "type" || args[0] == "key");
			}
			int boundsIndex = Array.IndexOf(args, "--bounds");
			if (boundsIndex >= 0) {
				var bounds = Bounds(inputWindow);
				string actual = bounds.Left + "," + bounds.Top + "," + bounds.Width + "," + bounds.Height;
				if (boundsIndex + 1 >= args.Length || args[boundsIndex + 1] != actual) throw new ArgumentException("App layout changed. Take a new screenshot before acting.");
			}
			switch (args.Length > 0 ? args[0] : "")
			{
				case "screenshot":
				{
					IntPtr window = GetForegroundWindow(); uint process;
					if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out process) == 0) throw new ArgumentException("No active desktop window. Unlock the desktop and take a new screenshot.");
					Permit(window, process);
					var b = Bounds(window); RECT frame; GetWindowRect(window, out frame);
					if (frame.Right-frame.Left > 20000 || frame.Bottom-frame.Top > 20000 || (long)(frame.Right-frame.Left)*(frame.Bottom-frame.Top) > 100000000) throw new ArgumentException("App window is too large to capture.");
					using (var full = new Bitmap(frame.Right-frame.Left, frame.Bottom-frame.Top))
					{
						using (var g = Graphics.FromImage(full)) {
							IntPtr dc = g.GetHdc(); bool captured;
							try { captured = PrintWindow(window, dc, 2); } finally { g.ReleaseHdc(dc); }
							if (!captured) throw new ArgumentException("This app cannot provide a window capture. Use browser or file tools instead.");
						}
						int maxW = args.Length > 2 ? int.Parse(args[2]) : 1280;
						double scale = Math.Min(1.0, (double)maxW / b.Width);
						int w = (int)Math.Round(b.Width * scale), h = (int)Math.Round(b.Height * scale);
						using (var small = new Bitmap(w, h))
						{
							using (var g = Graphics.FromImage(small))
							{
								g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
								g.DrawImage(full, new Rectangle(0,0,w,h), new Rectangle(b.Left-frame.Left,b.Top-frame.Top,b.Width,b.Height), GraphicsUnit.Pixel);
							}
							var codec = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
							var p = new EncoderParameters(1);
							p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 80L);
							small.Save(args[1], codec, p);
						}
						if (GetForegroundWindow() != window || !SameWindow(window, process) || Bounds(window) != b) throw new ArgumentException("The active window changed during capture. Take a new screenshot.");
						Permit(window, process);
						Console.WriteLine("{\"width\":" + w + ",\"height\":" + h + ",\"screenWidth\":" + b.Width + ",\"screenHeight\":" + b.Height + ",\"left\":" + b.Left + ",\"top\":" + b.Top + ",\"windowId\":\"" + window.ToInt64() + "\",\"processId\":" + process + "}");
					}
					return 0;
				}
				case "move":
					Move(args[1], args[2]);
					return 0;
				case "click":
				{
					Move(args[1], args[2]);
					string button = args.Length > 3 ? args[3] : "left";
					int count = args.Length > 4 ? int.Parse(args[4]) : 1;
					uint down = button == "right" ? RDOWN : button == "middle" ? MDOWN : LDOWN;
					uint up = button == "right" ? RUP : button == "middle" ? MUP : LUP;
					for (int i = 0; i < count; i++) { Send(new[] { MouseInput(down), MouseInput(up) }); System.Threading.Thread.Sleep(40); }
					return 0;
				}
				case "scroll":
					Move(args[1], args[2]);
					Send(new[] { MouseInput(WHEEL, int.Parse(args[3]) * 120) });
					return 0;
				case "type":
				{
					string text = Console.In.ReadToEnd();
					if (text.Length > 20000 || text.IndexOf('\0') >= 0) throw new ArgumentException("Invalid text length or NUL character.");
					text = text.Replace("\r\n", "\n").Replace('\r', '\n');
					var inputs = new List<INPUT>();
					foreach (char c in text)
					{
						if (c == '\n') { inputs.Add(KeyInput(0x0D, false)); inputs.Add(KeyInput(0x0D, true)); }
						else if (c == '\t') { inputs.Add(KeyInput(0x09, false)); inputs.Add(KeyInput(0x09, true)); }
						else Unicode(inputs, c);
						if (inputs.Count >= 128) { Send(inputs.ToArray()); inputs.Clear(); }
					}
					if (inputs.Count > 0) Send(inputs.ToArray());
					return 0;
				}
				case "key":
				{
					var parts = args[1].Split('+');
					var vks = new List<ushort>();
					foreach (var p in parts) vks.Add(Vk(p.Trim()));
					var inputs = new List<INPUT>();
					foreach (var vk in vks) inputs.Add(KeyInput(vk, false));
					for (int i = vks.Count - 1; i >= 0; i--) inputs.Add(KeyInput(vks[i], true));
					Send(inputs.ToArray());
					return 0;
				}
				case "cursor":
				{
					POINT pt;
					GetCursorPos(out pt);
					Console.WriteLine(pt.X + " " + pt.Y);
					return 0;
				}
			}
			Console.Error.WriteLine("usage: input screenshot|click|move|scroll|type|key|cursor");
			return 2;
		}
		catch (Exception e)
		{
			Console.Error.WriteLine(e.Message);
			return 1;
		}
	}
}
