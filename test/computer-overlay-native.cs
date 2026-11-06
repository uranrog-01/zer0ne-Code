using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;

class OverlayFixture {
    static readonly BindingFlags Private = BindingFlags.Instance | BindingFlags.NonPublic;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window,int command);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
    [DllImport("user32.dll")] static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window,int attribute,out int value,int size);
    static void Check(bool pass, string why) { if (!pass) throw new Exception(why); }
    static string Foreground() {
        var window=GetForegroundWindow(); uint pid; GetWindowThreadProcessId(window,out pid);
        string name; try {using(var process=Process.GetProcessById((int)pid))name=process.ProcessName;}catch{name="unavailable";}
        return window+" ("+name+", PID "+pid+")";
    }
    static void Focus(Form target) {
        target.Activate(); Application.DoEvents();
        // Disposing the in-process overlays can return focus to the previous app.
        // Each independent phase must own focus before arming its handoff monitor.
        if(GetForegroundWindow()!=target.Handle) {keybd_event(0x12,0,0,UIntPtr.Zero);keybd_event(0x12,0,2,UIntPtr.Zero);for(int i=0;i<50 && !SetForegroundWindow(target.Handle);i++){Application.DoEvents();System.Threading.Thread.Sleep(20);}}
        Check(GetForegroundWindow()==target.Handle,"The owned fixture did not acquire focus; refusing input: "+Foreground());
    }
    static object Field(ComputerOverlay c, string name) { return typeof(ComputerOverlay).GetField(name, Private).GetValue(c); }
    static void Tick(ComputerOverlay c) { typeof(ComputerOverlay).GetMethod("Tick",Private).Invoke(c,null); Application.DoEvents(); }
    static void Input(ComputerOverlay c, bool keyboard, bool injected) {
        var data = Marshal.AllocHGlobal(40);
        try {
            for(int i=0;i<40;i++)Marshal.WriteByte(data,i,0);
            Marshal.WriteInt32(data,keyboard?8:12,injected?(keyboard?0x10:1):0);
            typeof(ComputerOverlay).GetMethod(keyboard?"Keyboard":"Mouse",Private).Invoke(c,new object[]{0,new IntPtr(keyboard?0x100:0x201),data});
        } finally {Marshal.FreeHGlobal(data);}
    }
    static void Save(Form form, string file) {
        using(var image=new Bitmap(form.Width,form.Height)) {form.DrawToBitmap(image,form.ClientRectangle); image.Save(file,ImageFormat.Png);}
    }
    static void Send(string helper, string arguments, string text) {
        var start=new ProcessStartInfo(helper,arguments){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
        using(var process=Process.Start(start)) {
            AllowSetForegroundWindow(process.Id);
            process.StandardInput.Write(text??"");process.StandardInput.Close();
            var until=DateTime.UtcNow.AddSeconds(5);
            while(!process.HasExited && DateTime.UtcNow<until){Application.DoEvents();System.Threading.Thread.Sleep(2);}
            if(!process.HasExited){process.Kill();throw new Exception("Native input did not finish with overlay active");}
            Check(process.ExitCode==0,"Native input failed with overlay active: "+process.StandardError.ReadToEnd()+"; args="+arguments+"; foreground="+GetForegroundWindow());
        }
        Application.DoEvents();
    }
    static void External(Form target, TextBox text, string folder, string helper, string executable) {
        Check(GetForegroundWindow()==target.Handle,"The fixture lost focus before starting the external overlay: "+Foreground());
        int pid=Process.GetCurrentProcess().Id;
        var policy=new ComputerOverlay.Policy{epoch="external",paused=false,allowed=new[]{Application.ExecutablePath},stop=File.ReadAllText(Path.Combine(folder,"stop"))};
        File.WriteAllText(Path.Combine(folder,"permissions.json"),Json.Serialize(policy));
        var point=text.PointToScreen(new System.Drawing.Point(40,12));
        var p=new ComputerOverlay.Presentation{id="external-observation",pid=pid,processId=pid,windowId=target.Handle.ToInt64().ToString(),epoch=policy.epoch,at=ComputerOverlay.Now,action="click",theme="dark",x=point.X,y=point.Y};
        File.WriteAllText(Path.Combine(folder,"presentation.json"),Json.Serialize(p));File.WriteAllText(Path.Combine(folder,"monitor-required.json"),"{}");
        var start=new ProcessStartInfo(executable,"\""+folder+"\" "+pid){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardError=true,RedirectStandardOutput=true};
        using(var monitor=Process.Start(start)) {
            try {
                var until=DateTime.UtcNow.AddSeconds(5);bool ready=false;
                while(!ready && !monitor.HasExited && DateTime.UtcNow<until){
                    Application.DoEvents();System.Threading.Thread.Sleep(10);
                    try {using(var stream=new FileStream(Path.Combine(folder,"monitor-ready.json"),FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))using(var reader=new StreamReader(stream)) {var ack=Json.Deserialize<System.Collections.Generic.Dictionary<string,object>>(reader.ReadToEnd());ready=Convert.ToInt32(ack["pid"])==monitor.Id && (string)ack["id"]==p.id;}}catch{}
                }
                Check(ready,"External monitor did not acknowledge the target");
                Check(GetForegroundWindow()==target.Handle,"Focus changed while starting the external overlay: "+Foreground()+"; monitor PID "+monitor.Id);
                string guard=" --policy \""+Path.Combine(folder,"permissions.json")+"\" --epoch "+policy.epoch+" --focus "+p.windowId+","+pid;
                Send(helper,"click "+point.X+" "+point.Y+" left 1"+guard,null);Send(helper,"type"+guard,"Desktop control verified");
                Check(text.Text=="Desktop control verified","Input did not reach the owned app through the external outline");
                Check(File.ReadAllText(Path.Combine(folder,"stop"))==policy.stop,"Injected input triggered a false handoff in the external monitor");
            } finally {
                monitor.StandardInput.Close();var until=DateTime.UtcNow.AddSeconds(3);
                while(!monitor.HasExited && DateTime.UtcNow<until){Application.DoEvents();System.Threading.Thread.Sleep(10);}
                if(!monitor.HasExited)monitor.Kill();
            }
        }
    }
    [STAThread] static int Main(string[] args) {
        SetProcessDPIAware(); Application.EnableVisualStyles();
        var previous=GetForegroundWindow();var previousPointer=Cursor.Position;
        try {
            var dir=args[0]; var output=args[1]; int pid=Process.GetCurrentProcess().Id;
            var policy=new ComputerOverlay.Policy {epoch="test-epoch",paused=false,allowed=new[]{Process.GetCurrentProcess().MainModule.FileName},stop=""};
            File.WriteAllText(Path.Combine(dir,"permissions.json"),Json.Serialize(policy));
            using(var target=new Form {Text="Calculator · desktop control preview",Size=new Size(780,510),TopMost=true,StartPosition=FormStartPosition.CenterScreen}) {
                var text=new TextBox{Text="",Location=new System.Drawing.Point(40,70),Width=500};target.Controls.Add(text);
                target.Show(); ShowWindow(target.Handle,1); Focus(target);
                using(var overlay=new ComputerOverlay(dir,pid)) {
                var p=new ComputerOverlay.Presentation{id="observation-one",pid=pid,processId=pid,windowId=target.Handle.ToInt64().ToString(),epoch=policy.epoch,at=ComputerOverlay.Now,action="click",theme="dark",x=target.Left+200,y=target.Top+160};
                File.WriteAllText(Path.Combine(dir,"presentation.json"),Json.Serialize(p)); Tick(overlay);
                Check((bool)Field(overlay,"watching"),"Monitor did not arm: " + Field(overlay,"lastError") + "; paused="+Field(overlay,"paused")+"; handoff="+Field(overlay,"handedOff")+"; ready="+File.Exists(Path.Combine(dir,"monitor-ready.json"))+"; target="+target.Bounds+"; primary="+Screen.PrimaryScreen.Bounds);
                Check(File.Exists(Path.Combine(dir,"monitor-ready.json")),"Missing observation readiness acknowledgement");
                p.action="approval";p.id="approval";File.WriteAllText(Path.Combine(dir,"presentation.json"),Json.Serialize(p));Tick(overlay);
                Check(!(bool)Field(overlay,"watching"),"Approval must allow the user's mouse and keyboard");
                Input(overlay,false,false);Check(!File.Exists(Path.Combine(dir,"stop")),"Approval input incorrectly triggered handoff");
                p.action="click";p.id="approved";File.WriteAllText(Path.Combine(dir,"presentation.json"),Json.Serialize(p));Tick(overlay);
                Input(overlay,false,true);Input(overlay,true,true);
                Check((bool)Field(overlay,"watching"),"Injected input caused a false handoff");
                var pill=(Form)Field(overlay,"pill"); var frame=(Form)Field(overlay,"outline");
                Save(pill,Path.Combine(output,"computer-desktop-floating-controls.png"));
                using(var image=new Bitmap(frame.Width,frame.Height)) {frame.DrawToBitmap(image,frame.ClientRectangle);image.MakeTransparent(Color.Fuchsia);image.Save(Path.Combine(output,"computer-desktop-outline.png"),ImageFormat.Png);}
                Input(overlay,false,false);
                Check(!(bool)Field(overlay,"watching"),"Physical mouse input did not pause");
                Check(File.Exists(Path.Combine(dir,"stop")),"Handoff did not invalidate native input");
                Check(((Label)Field(overlay,"title")).Text=="You're in control","Handoff is not visible");
                Save(pill,Path.Combine(output,"computer-desktop-handoff.png"));
                File.Delete(Path.Combine(dir,"presentation.json"));Tick(overlay);Check(pill.Visible,"Handoff disappeared when the stopped turn ended");
                policy.epoch="resumed-epoch";policy.stop=File.ReadAllText(Path.Combine(dir,"stop"));p.epoch=policy.epoch;p.id="observation-two";p.theme="light";p.reducedMotion=true;
                File.WriteAllText(Path.Combine(dir,"permissions.json"),Json.Serialize(policy));File.WriteAllText(Path.Combine(dir,"presentation.json"),Json.Serialize(p));Tick(overlay);
                Check((bool)Field(overlay,"watching"),"Explicit resume did not arm");
                Save(pill,Path.Combine(output,"computer-desktop-floating-light.png"));
                Input(overlay,true,false);Check(!(bool)Field(overlay,"watching"),"Physical keyboard input did not pause");
                overlay.Pause(false,true);Tick(overlay);Check(!pill.Visible,"Stop did not dismiss controls");
                }
                Focus(target);
                External(target,text,dir,args[2],args[3]);
                target.Close();
            }
            Console.WriteLine("Native overlay passed: observation acknowledgement, injected input, mouse/keyboard handoff, explicit resume, Stop, light/dark and reduced motion.");return 0;
        }catch(Exception e){Console.Error.WriteLine(e);return 1;}
        finally{Cursor.Position=previousPointer;if(previous!=IntPtr.Zero)SetForegroundWindow(previous);}
    }
}
