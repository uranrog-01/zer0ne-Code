/*
 * What lies under the notch: 'clear' (the desktop), 'covered' (an app window reaches the
 * notch's area at the top of the primary display) or 'fullscreen' (the window in front fills
 * the primary display: a game, a video, a presentation). The notch uses it to shrink to a
 * thin line over other windows and to step aside for full-screen apps. The same helper reports
 * the battery (on the charger or not, and its level) for the notch's Windows activity, and
 * whether Windows is in presentation mode (the notch then turns discreet).
 *
 * A small PowerShell helper owns the Win32 calls (as in panel-glass.js); it checks twice a
 * second and writes a line only when the answer changes. Tool windows (the notch itself, the
 * Quick window, panel glass), cloaked and minimized windows, the desktop and the taskbar never
 * count. Windows only; elsewhere, and if the helper fails, the area is always 'clear'.
 */
'use strict';
const { spawn } = require('child_process');

const SCRIPT = String.raw`
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class ZcNotchCover {
 [StructLayout(LayoutKind.Sequential)] struct RECT { public int L,T,R,B; }
 [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
 [StructLayout(LayoutKind.Sequential)] struct POWER { public byte AC, Flag, Percent, Saver; public int LifeTime, FullLifeTime; }
 [DllImport("kernel32.dll")] static extern bool GetSystemPowerStatus(out POWER p);
 delegate bool EnumProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
 [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
 [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
 [DllImport("user32.dll")] static extern bool GetMonitorInfoW(IntPtr m, ref MONITORINFO i);
 [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
 [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int s);
 static string lastPresent = "";
 static readonly object gate = new object();
 static RECT zone; static bool hasZone; static string last = ""; static string lastPower = "";
 static bool Counts(IntPtr h) {
  if (!IsWindowVisible(h) || IsIconic(h)) return false;
  if ((GetWindowLong(h, -20) & 0x80) != 0) return false;
  int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return false;
  var sb = new StringBuilder(64); GetClassNameW(h, sb, 64); string c = sb.ToString();
  return c != "Progman" && c != "WorkerW" && c != "Shell_TrayWnd" && c != "Shell_SecondaryTrayWnd";
 }
 static string Probe() {
  IntPtr fg = GetForegroundWindow();
  if (fg != IntPtr.Zero && Counts(fg)) {
   RECT r; var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(mi);
   if (GetWindowRect(fg, out r) && GetMonitorInfoW(MonitorFromWindow(fg, 2), ref mi) && (mi.dwFlags & 1) != 0
    && r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B) return "fullscreen";
  }
  RECT z; lock (gate) { if (!hasZone) return "clear"; z = zone; }
  bool covered = false;
  EnumWindows((h, l) => {
   if (!Counts(h)) return true;
   RECT r; if (!GetWindowRect(h, out r)) return true;
   if (r.L < z.R && r.R > z.L && r.T < z.B && r.B > z.T) { covered = true; return false; }
   return true;
  }, IntPtr.Zero);
  return covered ? "covered" : "clear";
 }
 static void Tick(object ignored) {
  SetThreadDpiAwarenessContext(new IntPtr(-4));
  POWER p;
  if (GetSystemPowerStatus(out p)) {
   string ps = p.Flag == 128 || p.Percent == 255 ? "power none 0" : "power " + (p.AC == 1 ? "ac " : "battery ") + p.Percent;
   if (ps != lastPower) { lastPower = ps; Console.Out.WriteLine(ps); Console.Out.Flush(); }
  }
  // QUNS_PRESENTATION_MODE (4): a slide show or Windows presentation settings are on.
  int q; string pr = SHQueryUserNotificationState(out q) == 0 && q == 4 ? "present 1" : "present 0";
  if (pr != lastPresent) { lastPresent = pr; Console.Out.WriteLine(pr); Console.Out.Flush(); }
  string s; try { s = Probe(); } catch { return; }
  if (s == last) return;
  last = s; Console.Out.WriteLine(s); Console.Out.Flush();
 }
 public static void Run() {
  using (var timer = new Timer(Tick, null, 0, 500)) {
   string line;
   while ((line = Console.ReadLine()) != null) {
    string[] n = line.Split(','); int[] v = new int[4]; bool ok = n.Length == 4;
    for (int i = 0; ok && i < 4; i++) ok = int.TryParse(n[i], out v[i]);
    lock (gate) { hasZone = ok; if (ok) { zone.L = v[0]; zone.T = v[1]; zone.R = v[0] + v[2]; zone.B = v[1] + v[3]; } }
   }
  }
 }
}
'@
[ZcNotchCover]::Run()
`;

class CoverWatch {
	/** @param {() => void} onChange called when `state` or `power` changes */
	constructor(onChange) {
		this.onChange = onChange;
		this.state = 'clear';
		/** The battery: 'none' on a desktop PC (or before the first report), else on the charger or not. */
		this.power = { source: 'none', percent: 0 };
		/** Windows reports a presentation (a slide show, or presentation settings on). */
		this.presenting = false;
		this.child = null;
		this.failed = false;
		this.zone = null;
	}

	/** Start (or keep) watching `zone`: the notch's area in physical screen pixels. */
	watch(zone) {
		if (process.platform !== 'win32' || this.failed) return;
		const line = [zone.x, zone.y, zone.width, zone.height].map((n) => Math.round(n)).join(',');
		if (!this.child) this.spawn();
		if (this.child && line !== this.zone) {
			this.zone = line;
			this.child.stdin.write(line + '\n');
		}
	}

	spawn() {
		try {
			const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
			this.child = child;
			let buffer = '';
			child.stdout.on('data', (data) => {
				buffer += String(data);
				let i;
				while ((i = buffer.indexOf('\n')) >= 0) {
					const s = buffer.slice(0, i).trim();
					buffer = buffer.slice(i + 1);
					const power = /^power (ac|battery|none) (\d+)$/.exec(s);
					if (power) {
						this.power = { source: power[1], percent: Math.min(100, Number(power[2])) };
						this.onChange();
					} else if (s === 'present 1' || s === 'present 0') {
						if (this.presenting !== (s === 'present 1')) {
							this.presenting = s === 'present 1';
							this.onChange();
						}
					} else if ((s === 'clear' || s === 'covered' || s === 'fullscreen') && s !== this.state) {
						this.state = s;
						this.onChange();
					}
				}
			});
			child.stderr.on('data', (data) => console.error('Notch cover:', String(data).trim()));
			// A helper that cannot run leaves the notch as if the area were clear.
			const fail = () => {
				if (this.child !== child) return;
				this.child = null;
				this.zone = null;
				this.failed = true;
				if (this.state !== 'clear') {
					this.state = 'clear';
					this.onChange();
				}
			};
			child.on('error', fail);
			child.on('exit', fail);
			child.stdin.on('error', fail);
		} catch {
			this.failed = true;
		}
	}

	stop() {
		const child = this.child;
		this.child = null;
		this.zone = null;
		if (child) {
			child.stdin.end();
			child.kill();
		}
		this.presenting = false;
		if (this.state !== 'clear') {
			this.state = 'clear';
			this.onChange();
		}
	}
}

module.exports = { CoverWatch };
