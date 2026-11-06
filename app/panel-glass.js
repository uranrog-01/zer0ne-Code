'use strict';
const { spawn } = require('child_process');
const { BaseWindow } = require('electron');

// Each material window stays immediately BELOW its owning app window. It has no
// renderer, input or taskbar entry. Windows acrylic is window-wide, so applying it
// to these two small surfaces leaves the conversation's desktop transparency clear.
const SCRIPT = String.raw`
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class PanelGlass {
 [StructLayout(LayoutKind.Sequential)] struct RECT { public int L,T,R,B; }
 [StructLayout(LayoutKind.Sequential)] struct POINT { public int X,Y; }
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
 [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h,ref POINT p);
 [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h,uint cmd);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int cmd);
 [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int height,uint flags);
 static object gate=new object(); static IntPtr parent; static IntPtr[] panels;
 static double[][] areas=new double[2][];
 static void Tick(object ignored) {
  SetThreadDpiAwarenessContext(new IntPtr(-4));
  lock(gate) {
   RECT client; POINT origin=new POINT();
   bool visible=IsWindow(parent)&&IsWindowVisible(parent)&&!IsIconic(parent)&&GetClientRect(parent,out client);
   GetClientRect(parent,out client); ClientToScreen(parent,ref origin);
   IntPtr above=parent;
   for(int i=0;i<2;i++) {
    IntPtr h=panels[i]; double[] a=areas[i];
    if(!visible||a==null) { ShowWindow(h,0); continue; }
    int x=origin.X+(int)Math.Round(a[0]*client.R),y=origin.Y+(int)Math.Round(a[1]*client.B);
    int w=Math.Max(1,(int)Math.Round(a[2]*client.R)),height=Math.Max(1,(int)Math.Round(a[3]*client.B));
    RECT r; GetWindowRect(h,out r);
    if(!IsWindowVisible(h)||r.L!=x||r.T!=y||r.R-r.L!=w||r.B-r.T!=height||GetWindow(h,3)!=above)
     SetWindowPos(h,above,x,y,w,height,0x10|0x40|0x200);
    above=h;
   }
  }
 }
 public static void Run(string[] handles) {
  parent=new IntPtr(long.Parse(handles[0])); panels=new[]{new IntPtr(long.Parse(handles[1])),new IntPtr(long.Parse(handles[2]))};
  using(var timer=new Timer(Tick,null,0,33)) {
   string line;
   while((line=Console.ReadLine())!=null) {
    string[] pairs=line.Split(';');
    lock(gate) { for(int i=0;i<2;i++) {
     string[] n=pairs[i].Split(','); areas[i]=null;
     if(n.Length==4) { var a=new double[4]; bool ok=true;
      for(int k=0;k<4;k++) ok &= double.TryParse(n[k],System.Globalization.NumberStyles.Float,System.Globalization.CultureInfo.InvariantCulture,out a[k]);
      if(ok) areas[i]=a;
     }
    }}
   }
  }
  foreach(var h in panels) ShowWindow(h,0);
 }
}
'@
[PanelGlass]::Run($args)
`;

function regions(args) {
	const { width, height } = args?.viewport || {};
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !Array.isArray(args.panels)) return [null, null];
	return ['sidebar', 'auxiliary'].map(id => {
		const r = args.panels.find(p => p?.id === id);
		if (!r || ![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) return null;
		// The renderer supplies areas only; it can never supply native window handles.
		const x = Math.max(0, Math.min(width, r.x)), y = Math.max(0, Math.min(height, r.y));
		const w = Math.min(r.width, width - x), h = Math.min(r.height, height - y);
		return w > 0 && h > 0 ? [x / width, y / height, w / width, h / height] : null;
	});
}

class PanelGlass {
	constructor(win) { this.win = win; this.windows = []; this.worker = null; this.failed = false; }
	update(args) {
		if (process.platform !== 'win32' || this.win.isDestroyed() || this.failed) return false;
		const areas = regions(args);
		if (!this.worker && !areas.some(Boolean)) return true;
		if (!this.worker) {
			try {
				for (let i = 0; i < 2; i++) {
					const window = new BaseWindow({ width: 2, height: 2, show: false, frame: false, transparent: true, backgroundColor: '#00000000', focusable: false, skipTaskbar: true, resizable: true, movable: false, minimizable: false, maximizable: false, hasShadow: false, thickFrame: false });
					this.windows.push(window);
					window.setIgnoreMouseEvents(true);
					window.setBackgroundMaterial('acrylic');
				}
				const handle = w => w.getNativeWindowHandle().readBigUInt64LE().toString();
				// EncodedCommand cannot receive script arguments. Append only trusted decimal HWNDs.
				const script = SCRIPT.replace('[PanelGlass]::Run($args)', `[PanelGlass]::Run(@('${handle(this.win)}','${handle(this.windows[0])}','${handle(this.windows[1])}'))`);
				this.worker = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
				const fail = () => { this.failed = true; this.dispose(); };
				this.worker.on('error', fail); this.worker.on('exit', fail); this.worker.stdin.on('error', fail);
				this.worker.stderr.on('data', data => { console.error('Panel glass:', String(data).trim()); });
			} catch { this.failed = true; this.dispose(); return false; }
		}
		this.worker.stdin.write(areas.map(a => a ? a.join(',') : '').join(';') + '\n');
		return true;
	}
	clear() { return this.update({ viewport: { width: 1, height: 1 }, panels: [] }); }
	dispose() {
		const worker = this.worker; this.worker = null;
		if (worker) { worker.stdin.end(); worker.kill(); }
		for (const window of this.windows) if (!window.isDestroyed()) window.destroy();
		this.windows = [];
	}
}
module.exports = { PanelGlass, regions };
