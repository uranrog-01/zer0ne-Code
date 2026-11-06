/*
 * Explorer's desktop icons are hidden while a see-through zer0ne Code window covers
 * the desktop (Liquid Glass), and shown again when none does. A small PowerShell
 * helper owns the Win32 calls and is also the watchdog: when the app exits or crashes
 * its stdin closes and it shows the icons it hid. Icons the user hid are never shown,
 * and no Explorer preference or registry value is changed. A marker file recovers
 * icons a killed helper left hidden. Windows only; elsewhere every call is a no-op.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class ZcDesktopIcons {
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowW(string c, string n);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowExW(IntPtr p, IntPtr after, string c, string n);
	[DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
	[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
	static IntPtr List() {
		IntPtr progman = FindWindowW("Progman", null);
		IntPtr view = progman == IntPtr.Zero ? IntPtr.Zero : FindWindowExW(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
		IntPtr worker = IntPtr.Zero;
		while (view == IntPtr.Zero) {
			worker = FindWindowExW(IntPtr.Zero, worker, "WorkerW", null);
			if (worker == IntPtr.Zero) break;
			view = FindWindowExW(worker, IntPtr.Zero, "SHELLDLL_DefView", null);
		}
		return view == IntPtr.Zero ? IntPtr.Zero : FindWindowExW(view, IntPtr.Zero, "SysListView32", null);
	}
	public static bool Visible() { IntPtr l = List(); return l != IntPtr.Zero && IsWindowVisible(l); }
	public static bool Set(bool show) { IntPtr l = List(); if (l == IntPtr.Zero) return false; ShowWindow(l, show ? 5 : 0); return IsWindowVisible(l) == show; }
	public static void SetTaskbar(bool show) {
		IntPtr t = FindWindowW("Shell_TrayWnd", null);
		if (t != IntPtr.Zero) ShowWindow(t, show ? 5 : 0);
		IntPtr sec = IntPtr.Zero;
		while ((sec = FindWindowExW(IntPtr.Zero, sec, "Shell_SecondaryTrayWnd", null)) != IntPtr.Zero) {
			ShowWindow(sec, show ? 5 : 0);
		}
	}
}
"@
function UserHidden {
	try { return [int](Get-ItemPropertyValue -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' -Name 'HideIcons') -ne 0 } catch { return $false }
}
$hidden = $false
$taskbarHidden = $false
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
	if ($line -eq 'hide') {
		if (-not $hidden -and [ZcDesktopIcons]::Visible()) { if ([ZcDesktopIcons]::Set($false)) { $hidden = $true } }
	} elseif ($line -eq 'show') {
		if ($hidden) { if (-not (UserHidden)) { [void][ZcDesktopIcons]::Set($true) }; $hidden = $false }
	} elseif ($line -eq 'hide_taskbar') {
		if (-not $taskbarHidden) { [ZcDesktopIcons]::SetTaskbar($false); $taskbarHidden = $true }
	} elseif ($line -eq 'show_taskbar') {
		if ($taskbarHidden) { [ZcDesktopIcons]::SetTaskbar($true); $taskbarHidden = $false }
	} elseif ($line -eq 'recover') {
		if (-not $hidden -and -not [ZcDesktopIcons]::Visible() -and -not (UserHidden)) { [void][ZcDesktopIcons]::Set($true) }
		[ZcDesktopIcons]::SetTaskbar($true); $taskbarHidden = $false
	}
	[Console]::Out.WriteLine($(if ($hidden) { 'hidden' } else { 'shown' })); [Console]::Out.Flush()
}
if ($hidden -and -not (UserHidden)) { [void][ZcDesktopIcons]::Set($true) }
if ($taskbarHidden) { [ZcDesktopIcons]::SetTaskbar($true) }
`;

class DesktopIcons {
	/** @param {string} markerDir where desktop-icons.json records that icons are hidden */
	constructor(markerDir) {
		this.marker = path.join(markerDir, 'desktop-icons.json');
		this.helper = null;
		this.wanted = false;
		this.taskbarWanted = false;
		this.sent = null;
		this.taskbarSent = null;
		this.enabled = process.platform === 'win32';
		// A previous run died while the icons or taskbar were hidden: bring them back.
		if (this.enabled && this.markerSaysHidden()) this.send('recover');
	}

	markerSaysHidden() {
		try {
			const data = JSON.parse(fs.readFileSync(this.marker, 'utf8'));
			return data.hidden === true || data.taskbarHidden === true;
		} catch {
			return false;
		}
	}

	record(hidden, taskbarHidden) {
		try {
			if (hidden || taskbarHidden) {
				fs.mkdirSync(path.dirname(this.marker), { recursive: true });
				fs.writeFileSync(this.marker, JSON.stringify({ hidden: !!hidden, taskbarHidden: !!taskbarHidden }));
			} else fs.rmSync(this.marker, { force: true });
		} catch {
			// Recovery is best effort; the helper still restores icons on exit.
		}
	}

	start() {
		if (this.helper) return this.helper;
		const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
		const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
		child.on('error', () => undefined);
		child.on('exit', () => {
			if (this.helper === child) {
				this.helper = null;
				this.sent = null;
				this.taskbarSent = null;
			}
		});
		let buf = '';
		child.stdout.on('data', (d) => {
			buf += d;
			let i;
			while ((i = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, i).trim();
				buf = buf.slice(i + 1);
				if (line === 'hidden') this.record(true, this.taskbarSent);
				else if (line === 'shown') this.record(false, this.taskbarSent);
			}
		});
		this.helper = child;
		return child;
	}

	send(cmd) {
		if (!this.enabled) return;
		try {
			this.start().stdin.write(cmd + '\n');
		} catch {
			// The helper is gone; the next change starts a new one.
		}
	}

	/**
	 * on = some see-through window is on screen over the desktop.
	 * taskbarOn = some see-through window is in fullscreen over the desktop.
	 */
	sync(on, taskbarOn = false) {
		if (!this.enabled) return;
		this.wanted = !!on;
		this.taskbarWanted = !!taskbarOn;

		if (this.sent !== this.wanted) {
			this.sent = this.wanted;
			this.send(this.wanted ? 'hide' : 'show');
		}

		if (this.taskbarSent !== this.taskbarWanted) {
			this.taskbarSent = this.taskbarWanted;
			this.send(this.taskbarWanted ? 'hide_taskbar' : 'show_taskbar');
			this.record(this.sent, this.taskbarSent);
		}
	}

	/** App exit: show what we hid and let the helper finish. */
	restore() {
		if (!this.helper) return;
		const child = this.helper;
		this.helper = null;
		try {
			child.stdin.write('show_taskbar\n');
			child.stdin.end('show\n');
		} catch {
			// Closing stdin alone also restores the icons.
		}
	}
}

/** Pure rule (tested): icons hide only for a visible, unminimized window showing a project page with some transparency. */
function hideRequested(visible, minimized, activePage, transparency) {
	return visible && !minimized && activePage && transparency > 0;
}

/** Pure rule (tested): taskbar hides only for a visible, unminimized, fullscreen window showing a project page with some transparency. */
function hideTaskbarRequested(visible, minimized, activePage, transparency, fullscreen) {
	return visible && !minimized && activePage && transparency > 0 && fullscreen;
}

module.exports = { DesktopIcons, hideRequested, hideTaskbarRequested, SCRIPT };
