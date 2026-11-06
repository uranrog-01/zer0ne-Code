// A temporary, owned window receives every real input in the Computer Use integration test.
using System;
using System.Drawing;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.IO;
using System.Web.Script.Serialization;

class FixtureTextBox : RichTextBox
{
	public int Wheel;
	protected override bool ProcessCmdKey(ref Message message, Keys keyData)
	{
		// Define the owned target's shortcut independently of the installed RichEdit version.
		if (keyData == (Keys.Control | Keys.A)) { SelectAll(); return true; }
		return base.ProcessCmdKey(ref message, keyData);
	}
	protected override void WndProc(ref Message message)
	{
		if (message.Msg == 0x020A) Wheel += (short)((message.WParam.ToInt64() >> 16) & 0xffff);
		base.WndProc(ref message);
	}
}

static class ComputerFixture
{
	[DllImport("user32.dll")] static extern bool SetProcessDPIAware();
	[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
	[DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
	[DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
	[DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int process);
	[DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
	[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
	[DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
	[DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
	[DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
	[DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, System.Text.StringBuilder text, int count);
	[DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr window);
	[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RectangleNative rect);
	[DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
	[StructLayout(LayoutKind.Sequential)] struct RectangleNative { public int Left, Top, Right, Bottom; public override string ToString() { return Left + "," + Top + "," + Right + "," + Bottom; } }
	static string helper;
	static string policy;
	static string Policy(bool paused, bool allowed) { return new JavaScriptSerializer().Serialize(new {epoch="native-test", paused=paused, allowed=allowed ? new[] {Application.ExecutablePath} : new string[0]}); }
	static string Guard(Form form) { return " --policy \"" + policy + "\" --epoch native-test --focus \"" + form.Handle.ToInt64() + "," + Process.GetCurrentProcess().Id + "\""; }
	static int result = 1;
	static IntPtr approvalWindow;
	/**
	 * A background process cannot take the foreground while another app owns it, and the
	 * helper that follows needs the foreground too. An ALT keystroke releases the previous
	 * owner's lock; ASFW_ANY passes the right on to the helpers this fixture starts.
	 */
	static void TakeForeground(Form form)
	{
		if (GetForegroundWindow() != form.Handle)
		{
			keybd_event(0x12, 0, 0, UIntPtr.Zero);
			keybd_event(0x12, 0, 2, UIntPtr.Zero);
			for (int i = 0; i < 50 && !SetForegroundWindow(form.Handle); i++) System.Threading.Thread.Sleep(20);
		}
		form.Activate();
		AllowSetForegroundWindow(-1 /* ASFW_ANY */);
	}
	static void Check(bool value, string message) { if (!value) throw new Exception(message); }
	static async Task Eventually(Func<bool> condition, Func<string> message)
	{
		// SendInput queues events; the target may still be processing them when the helper exits.
		var elapsed = Stopwatch.StartNew();
		while (!condition() && elapsed.ElapsedMilliseconds < 3000) await Task.Delay(20);
		Check(condition(), message());
	}

	static async Task Send(Form form, string input, params string[] args)
	{
		// If the user switches away, stop before any input can reach their window.
		IntPtr foreground = IntPtr.Zero;
		// Windows can briefly report no foreground window while input queues settle.
		await Eventually(() => (foreground = GetForegroundWindow()) != IntPtr.Zero, () => "The foreground window did not settle before " + args[0] + "; refusing input.");
		var foregroundTitle = new System.Text.StringBuilder(256); GetWindowText(foreground,foregroundTitle,foregroundTitle.Capacity);
		Check(foreground == form.Handle || (approvalWindow != IntPtr.Zero && foreground == approvalWindow), "The test window lost focus before " + args[0] + "; refusing input (foreground=" + foreground + ", title=" + foregroundTitle + ", fixture=" + form.Handle + ").");
		if (args[0] == "click" || args[0] == "scroll" || args[0] == "move")
		{
			Point target = new Point(int.Parse(args[1]), int.Parse(args[2]));
			IntPtr root = GetAncestor(WindowFromPoint(target), 2);
			var title = new System.Text.StringBuilder(512); GetWindowText(root, title, 512);
			RectangleNative rect; GetWindowRect(form.Handle, out rect);
			Check(root == form.Handle, "Test coordinates do not hit the owned window: " + target + "; bounds=" + form.Bounds + "; native=" + rect + "; dpi=" + GetDpiForWindow(form.Handle) + "; hit=" + title + "; screen=" + Screen.PrimaryScreen.Bounds);
		}
		string guard = Array.IndexOf(args,"--focus") < 0 ? Guard(form) : " --policy \"" + policy + "\" --epoch native-test";
		var start = new ProcessStartInfo(helper, string.Join(" ", Array.ConvertAll(args, a => "\"" + a + "\"")) + guard) {
			UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardError = true, RedirectStandardOutput = true
		};
		using (var process = Process.Start(start))
		{
			using (var writer = new System.IO.StreamWriter(process.StandardInput.BaseStream, new System.Text.UTF8Encoding(false))) writer.Write(input ?? "");
			// Keep the owned window's message loop running while native input arrives.
			if (!await Task.Run(() => process.WaitForExit(5000))) { process.Kill(); throw new Exception("Input helper timed out."); }
			Check(process.ExitCode == 0, "Input helper failed: " + process.StandardError.ReadToEnd());
		}
		await Task.Delay(100);
	}
	static async Task RejectFocus(Form form, string focus)
	{
		Check(GetForegroundWindow() == form.Handle, "The owned target lost focus before the rejection check.");
		var start = new ProcessStartInfo(helper, "type --focus \"" + focus + "\" --policy \"" + policy + "\" --epoch native-test") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardError = true };
		using (var process = Process.Start(start))
		{
			process.StandardInput.Write("must not type"); process.StandardInput.Close();
			if (!await Task.Run(() => process.WaitForExit(5000))) { process.Kill(); throw new Exception("Rejection helper timed out."); }
			Check(process.ExitCode != 0 && process.StandardError.ReadToEnd().Contains("screenshot window"), "A closed or foreign screenshot target was not refused.");
		}
	}
	static async Task Refuse(Form form, string command, string content)
	{
		Check(GetForegroundWindow() == form.Handle, "Owned window lost focus before denial test.");
		File.WriteAllText(policy,content);
		try {
			var start = new ProcessStartInfo(helper, command + Guard(form)) {UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardError=true};
			using(var process = Process.Start(start)) {
				process.StandardInput.Write("must not type"); process.StandardInput.Close();
				if (!await Task.Run(() => process.WaitForExit(5000))) {process.Kill();throw new Exception("Denial helper timed out.");}
				Check(process.ExitCode != 0,"Disallowed input was accepted: " + command);
			}
		} finally {File.WriteAllText(policy,Policy(false,true));}
	}
	static int ApprovalMain()
	{
		SetProcessDPIAware();
		using (var form = new Form { Text = "Computer Use approval fixture", ClientSize = new Size(300, 140), TopMost = true, StartPosition = FormStartPosition.CenterScreen })
		using (var text = new TextBox { Dock = DockStyle.Fill, Multiline = true })
		using (var timeout = new System.Windows.Forms.Timer { Interval = 10000 })
		{
			form.Controls.Add(text);
			timeout.Tick += (s, e) => form.Close();
			form.Shown += (s, e) => {
				form.Activate(); text.Focus(); timeout.Start();
				Console.WriteLine(form.Handle.ToInt64()); Console.Out.Flush();
				Task.Run(() => { Console.ReadLine(); if (!form.IsDisposed) form.BeginInvoke(new Action(form.Close)); });
			};
			Application.Run(form);
			Console.WriteLine(text.TextLength == 0 ? "clean" : "unexpected input");
			return text.TextLength == 0 ? 0 : 1;
		}
	}

	[STAThread] static int Main(string[] args)
	{
		if (args.Length > 0 && args[0] == "approval") return ApprovalMain();
		helper = args[0];
		policy = Path.Combine(Path.GetDirectoryName(helper),"fixture-permissions.json"); File.WriteAllText(policy,Policy(false,true));
		SetProcessDPIAware();
		IntPtr previous = GetForegroundWindow();
		Point cursor = Cursor.Position;
		using (var form = new Form { Text = "zer0ne Computer Use test", ClientSize = new Size(520, 360), StartPosition = FormStartPosition.CenterScreen, TopMost = true })
		using (var text = new FixtureTextBox { Bounds = new Rectangle(20, 20, 480, 180), ScrollBars = RichTextBoxScrollBars.Vertical })
		using (var pad = new Panel { Bounds = new Rectangle(20, 220, 480, 100), BackColor = Color.SteelBlue })
		{
			int left = 0, right = 0, doubles = 0;
			Point? lastMove = null;
			pad.MouseMove += (s, e) => { lastMove = e.Location; };
			pad.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) left++; if (e.Button == MouseButtons.Right) right++; };
			pad.MouseDoubleClick += (s, e) => { doubles++; };
			form.Controls.Add(text); form.Controls.Add(pad);
			form.Shown += async (s, e) => {
				try
				{
					uint pid;
					uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid), currentThread = GetCurrentThreadId();
					bool attached = foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
					try { SetWindowPos(form.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0043); TakeForeground(form); text.Focus(); }
					finally { if (attached) AttachThreadInput(currentThread, foregroundThread, false); }
					// Detaching input queues can change focus; establish it on our own queue before typing.
					form.Activate(); text.Select(); text.Focus();
					await Eventually(() => text.Focused && GetForegroundWindow() == form.Handle, () => "The owned text control did not acquire keyboard focus.");
					string unicode = "Za\u017c\u00f3\u0142\u0107 \u4e2d\u6587 \ud83d\ude00";
					await Send(form, unicode, "type");
					await Eventually(() => text.Text == unicode, () => "Unicode typing did not arrive intact: " + string.Join(" ", Array.ConvertAll(text.Text.ToCharArray(), c => ((int)c).ToString("X4"))) + "; focused=" + text.Focused + "; foreground=" + GetForegroundWindow());
					await Send(form, null, "key", "ctrl+a");
					await Eventually(() => text.SelectionStart == 0 && text.SelectionLength == text.TextLength, () => "Select-all input was not consumed: start=" + text.SelectionStart + "; length=" + text.SelectionLength + "; expected=" + text.TextLength + "; focused=" + text.Focused);
					await Send(form, "replacement\nline", "type");
					await Eventually(() => text.Text.Replace("\r", "") == "replacement\nline", () => "Shortcut or newline typing failed: " + text.Text.Replace("\r", "<CR>").Replace("\n", "<LF>"));
					Point p = text.PointToScreen(new Point(100, 80));
					await Send(form, null, "click", p.X.ToString(), p.Y.ToString(), "left", "1");
					await Send(form, null, "scroll", p.X.ToString(), p.Y.ToString(), "-2");
					await Eventually(() => text.Wheel == -240, () => "Wheel input was not delivered: " + text.Wheel + "; cursor=" + Cursor.Position + "; expected=" + p);
					p = pad.PointToScreen(new Point(100, 40));
					Point origin = pad.PointToScreen(new Point(20, 20));
					await Send(form, null, "move", origin.X.ToString(), origin.Y.ToString());
					await Eventually(() => Cursor.Position == origin, () => "Pointer did not reach the owned starting point: actual=" + Cursor.Position + "; expected=" + origin + "; dpi=" + GetDpiForWindow(form.Handle) + "; bounds=" + form.Bounds);
					lastMove = null;
					await Send(form, null, "move", p.X.ToString(), p.Y.ToString());
					// Mouse events use control coordinates; the helper's contract is the physical screen point.
					await Eventually(() => lastMove.HasValue && pad.ClientRectangle.Contains(lastMove.Value) && Cursor.Position == p, () => "Pointer move was not delivered to the test target: event=" + lastMove + "; cursor=" + Cursor.Position + "; expected=" + p + "; client=" + pad.PointToClient(Cursor.Position) + "; dpi=" + GetDpiForWindow(form.Handle));
					await Send(form, null, "click", p.X.ToString(), p.Y.ToString(), "left", "1");
					await Eventually(() => left == 1, () => "Left click was not delivered.");
					await Task.Delay(SystemInformation.DoubleClickTime + 50);
					await Send(form, null, "click", p.X.ToString(), p.Y.ToString(), "left", "2");
					await Eventually(() => doubles == 1, () => "Double click was not delivered.");
					await Send(form, null, "click", p.X.ToString(), p.Y.ToString(), "right", "1");
					await Eventually(() => right == 1, () => "Right click was not delivered.");
					IntPtr closedWindow;
					using (var approval = Process.Start(new ProcessStartInfo(Application.ExecutablePath, "approval") { UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true, CreateNoWindow = true }))
					{
						closedWindow = approvalWindow = new IntPtr(long.Parse(await Task.Run(() => approval.StandardOutput.ReadLine())));
						await Eventually(() => GetForegroundWindow() == approvalWindow, () => "The owned approval process did not acquire focus.");
						string focus = form.Handle.ToInt64() + "," + Process.GetCurrentProcess().Id;
						await Send(form, null, "key", "ctrl+a", "--focus", focus);
						await Send(form, "after approval\rsecond\r\nthird", "type", "--focus", focus);
						await Eventually(() => text.Text.Replace("\r", "") == "after approval\nsecond\nthird", () => "Approval focus was not restored or CR/CRLF typing failed: " + text.Text);
						approval.StandardInput.WriteLine("close"); approval.StandardInput.Close();
						if (!await Task.Run(() => approval.WaitForExit(5000))) { approval.Kill(); throw new Exception("Approval fixture did not close."); }
						Check(approval.ExitCode == 0 && approval.StandardOutput.ReadToEnd().Contains("clean"), "Input reached the approval window.");
						approvalWindow = IntPtr.Zero;
					}
					await RejectFocus(form, form.Handle.ToInt64() + "," + (Process.GetCurrentProcess().Id + 1));
					await RejectFocus(form, closedWindow.ToInt64() + "," + Process.GetCurrentProcess().Id);
					await Refuse(form,"type",Policy(true,true));
					await Refuse(form,"type",Policy(false,false));
					await Refuse(form,"click 0 0 left 1",Policy(false,true));
					string monitorDir=Path.GetDirectoryName(helper), required=Path.Combine(monitorDir,"monitor-required.json"), ready=Path.Combine(monitorDir,"monitor-ready.json");
					File.WriteAllText(required,"{}");
					try {
						await Refuse(form,"type",Policy(false,true));
						var serializer=new JavaScriptSerializer();
						File.WriteAllText(Path.Combine(monitorDir,"presentation.json"),serializer.Serialize(new{id="current",epoch="native-test"}));
						double now=(DateTime.UtcNow-new DateTime(1970,1,1)).TotalMilliseconds;
						File.WriteAllText(ready,serializer.Serialize(new{id="older",epoch="native-test",pid=Process.GetCurrentProcess().Id,at=now}));
						await Refuse(form,"type",Policy(false,true));
						File.WriteAllText(ready,serializer.Serialize(new{id="current",epoch="native-test",pid=Process.GetCurrentProcess().Id,at=now-5000}));
						await Refuse(form,"type",Policy(false,true));
						now=(DateTime.UtcNow-new DateTime(1970,1,1)).TotalMilliseconds;
						File.WriteAllText(ready,serializer.Serialize(new{id="current",epoch="native-test",pid=Process.GetCurrentProcess().Id,at=now}));
						await Send(form,null,"key","ctrl+a");
					} finally {File.Delete(required);}
					string denied = Path.Combine(Path.GetDirectoryName(helper),"denied.jpg");
					await Refuse(form,"screenshot \"" + denied + "\" 1280",Policy(false,false));
					Check(!File.Exists(denied),"A disallowed app was captured.");
					string capture = Path.Combine(Path.GetDirectoryName(helper),"owned.jpg");
					await Send(form,null,"screenshot",capture,"1280");
					using(var image = new Bitmap(capture)) {
						RectangleNative rect; GetWindowRect(form.Handle,out rect); var bounds=Rectangle.Intersect(Rectangle.FromLTRB(rect.Left,rect.Top,rect.Right,rect.Bottom),Screen.PrimaryScreen.Bounds);
						Check(image.Width==bounds.Width && image.Height==bounds.Height,"Capture included pixels outside the owned app.");
						Point sample=pad.PointToScreen(new Point(100,40)); Color pixel=image.GetPixel(sample.X-bounds.Left,sample.Y-bounds.Top);
						Check(Math.Abs(pixel.B-Color.SteelBlue.B)<15 && Math.Abs(pixel.R-Color.SteelBlue.R)<15,"Window content was not captured.");
					}
					Check(text.Text.Replace("\r", "") == "after approval\nsecond\nthird", "Rejected input modified the target.");
					result = 0; Console.WriteLine("Native Unicode, shortcut, newline, move, left/right/double click and wheel passed; approval focus and CR/CRLF passed.");
				}
				catch (Exception error) { Console.Error.WriteLine(error); }
				finally { form.Close(); }
			};
			Application.Run(form);
		}
		SetCursorPos(cursor.X, cursor.Y);
		if (previous != IntPtr.Zero) SetForegroundWindow(previous);
		return result;
	}
}
