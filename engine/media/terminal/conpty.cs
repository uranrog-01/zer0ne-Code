// ConPTY channels must drain on a separate thread during ClosePseudoConsole.
// https://learn.microsoft.com/windows/console/creating-a-pseudoconsole-session
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

class PtyHost {
    [StructLayout(LayoutKind.Sequential)] struct Coord { public short X, Y; public Coord(int x, int y) { X=(short)x; Y=(short)y; } }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public int cb; public string reserved, desktop, title; public int x,y,xSize,ySize,xChars,yChars,fill,flags;
        public short show, reservedSize; public IntPtr reserved2, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupEx { public Startup startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime, jobTime; public uint flags; public UIntPtr min, max; public uint active; public UIntPtr affinity; public uint priority, scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct Io { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimit basic; public Io io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr attrs, int size);
    [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(Coord size, IntPtr input, IntPtr output, uint flags, out IntPtr console);
    [DllImport("kernel32.dll")] static extern int ResizePseudoConsole(IntPtr console, Coord size);
    [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref StartupEx startup, out ProcessInfo info);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, int size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    static readonly object outputLock = new object();
    static void Send(string text) { lock(outputLock) { Console.WriteLine(text); Console.Out.Flush(); } }
    static void Check(bool ok) { if(!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
    static void Hr(int result) { if(result < 0) Marshal.ThrowExceptionForHR(result); }
    static int Main(string[] args) {
        IntPtr inputRead=IntPtr.Zero,inputWrite=IntPtr.Zero,outputRead=IntPtr.Zero,outputWrite=IntPtr.Zero,pc=IntPtr.Zero,job=IntPtr.Zero,list=IntPtr.Zero;
        ProcessInfo child = new ProcessInfo();
        FileStream input=null, output=null; Thread reader=null;
        var closing = new ManualResetEvent(false);
        try {
            if(args.Length != 3) throw new ArgumentException("Expected cwd, columns, rows.");
            Check(CreatePipe(out inputRead,out inputWrite,IntPtr.Zero,0)); Check(CreatePipe(out outputRead,out outputWrite,IntPtr.Zero,0));
            Hr(CreatePseudoConsole(new Coord(int.Parse(args[1]),int.Parse(args[2])),inputRead,outputWrite,0,out pc));
            IntPtr bytes=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes); list=Marshal.AllocHGlobal(bytes);
            Check(InitializeProcThreadAttributeList(list,1,0,ref bytes));
            Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x20016),pc,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
            var startup = new StartupEx(); startup.startup.cb=Marshal.SizeOf(typeof(StartupEx)); startup.attributes=list;
            // Redirected parent handles otherwise override the pseudoconsole's standard handles.
            startup.startup.flags=0x100;
            job=CreateJobObject(IntPtr.Zero,null); Check(job != IntPtr.Zero);
            var limits = new Limits(); limits.basic.flags=0x2000; Check(SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(Limits))));
            string shell=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"cmd.exe");
            Check(CreateProcessW(shell,new StringBuilder("\""+shell+"\" /d /q"),IntPtr.Zero,IntPtr.Zero,false,0x80000|4,IntPtr.Zero,args[0],ref startup,out child));
            // Assign before resuming so no descendant can escape the lifetime of this helper.
            Check(AssignProcessToJobObject(job,child.process)); uint resumed=ResumeThread(child.thread); if(resumed==0xffffffff) Check(false);
            CloseHandle(inputRead); inputRead=IntPtr.Zero; CloseHandle(outputWrite); outputWrite=IntPtr.Zero;
            input = new FileStream(new SafeFileHandle(inputWrite,true),FileAccess.Write); inputWrite=IntPtr.Zero;
            output = new FileStream(new SafeFileHandle(outputRead,true),FileAccess.Read); outputRead=IntPtr.Zero;
            reader = new Thread(() => { try { byte[] buf=new byte[8192]; int count; while((count=output.Read(buf,0,buf.Length))>0) Send("D "+Convert.ToBase64String(buf,0,count)); } catch(IOException) {} catch(ObjectDisposedException) {} }); reader.IsBackground=true; reader.Start();
            var writer = new Thread(() => { try { string line; while((line=Console.ReadLine())!=null) {
                if(line.StartsWith("I ")) { byte[] data=Convert.FromBase64String(line.Substring(2)); input.Write(data,0,data.Length); input.Flush(); }
                else if(line.StartsWith("R ")) { string[] size=line.Substring(2).Split(' '); Hr(ResizePseudoConsole(pc,new Coord(int.Parse(size[0]),int.Parse(size[1])))); }
                else if(line=="C") break;
            } } catch(Exception) {} finally { closing.Set(); } }); writer.IsBackground=true; writer.Start();
            Send("READY");
            while(WaitForSingleObject(child.process,100)==258 && !closing.WaitOne(0)) {}
            if(closing.WaitOne(0)) { TerminateJobObject(job,130); WaitForSingleObject(child.process,1000); }
            uint code; GetExitCodeProcess(child.process,out code);
            ClosePseudoConsole(pc); pc=IntPtr.Zero;
            reader.Join(2000); Send("E "+code); return 0;
        } catch(Exception error) { Console.Error.WriteLine(error.Message); return 1; }
        finally {
            if(child.process!=IntPtr.Zero && WaitForSingleObject(child.process,0)==258) TerminateProcess(child.process,130);
            if(job!=IntPtr.Zero) { TerminateJobObject(job,130); CloseHandle(job); }
            if(pc!=IntPtr.Zero) ClosePseudoConsole(pc);
            if(input!=null) input.Dispose(); if(output!=null) output.Dispose();
            foreach(IntPtr handle in new[]{inputRead,inputWrite,outputRead,outputWrite,child.thread,child.process}) if(handle!=IntPtr.Zero) CloseHandle(handle);
            if(list!=IntPtr.Zero) { DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); }
        }
    }
}
