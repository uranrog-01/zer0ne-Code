// zer0ne command supervisor for Windows: runs one approved command inside a
// kill-on-close Job Object, so the command's whole tree dies with this helper
// even when a re-parented grandchild would survive `taskkill /T /F` — and when
// the engine's stdin closes (engine crash: no cleanup runs) the job is ended
// here, before any orphan can outlive the app.
//
// Compiled on first use with the C# compiler that ships with Windows.
//
// Spec via environment (no argv, so no quoting round-trip):
//   ZER0NE_JOB_FILE     executable; PATH-resolved like Node's spawn when bare
//   ZER0NE_JOB_ARGS     argv as <count>;<len1>:<arg1><len2>:<arg2>… (UTF-16
//                       code-unit lengths; args may hold any character)
//   ZER0NE_JOB_VERBATIM "1" joins argv with single spaces, unquoted
// The child's stdout/stderr stream through unchanged; the exit code is the
// child's. Internal failures exit 125; engine-gone exits 130.
//
// The command sandbox (ZER0NE_SANDBOX_SID set): the child runs with a
// write-restricted copy of this process's token (Chromium's and Codex's
// approach). Reads are unchanged, so toolchains work; a write succeeds only
// where the restricting SIDs are granted too — the project's own sandbox SID
// (granted on its folder and its sandbox temp when the project is prepared),
// the logon session and Everyone. Other projects never grant that SID, so they
// stay out of reach. All privileges but change-notify are dropped, and the job
// keeps the command away from the desktop, the clipboard and shutdown. A token
// or process that cannot be created fails the command (exit 125): never an
// unsandboxed fallback.
//
//   C# 5 only: this is built by the in-box Framework compiler (csc.exe 4.0).
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

static class Job
{
	const uint CREATE_SUSPENDED = 0x4;
	const uint CREATE_NO_WINDOW = 0x08000000;
	const int STARTF_USESTDHANDLES = 0x100;
	const uint HANDLE_FLAG_INHERIT = 0x1;
	const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
	const int JobObjectExtendedLimitInformation = 9;
	const int JobObjectBasicAccountingInformation = 1;
	const uint INFINITE = 0xFFFFFFFF;

	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup
	{
		public int cb; public string reserved, desktop, title; public int x, y, xSize, ySize, xChars, yChars, fill, flags;
		public short show, reservedSize; public IntPtr reserved2, stdin, stdout, stderr;
	}
	[StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
	[StructLayout(LayoutKind.Sequential)] struct SecurityAttrs { public int length; public IntPtr descriptor; public bool inherit; }
	[StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long processTime, jobTime; public uint flags; public UIntPtr min, max; public uint active; public UIntPtr affinity; public uint priority, scheduling; }
	[StructLayout(LayoutKind.Sequential)] struct Io { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
	[StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimit basic; public Io io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob; }
	[StructLayout(LayoutKind.Sequential)] struct Accounting { public long userTime, kernelTime, periodUserTime, periodKernelTime; public uint faults, total, active, terminated; }

	[DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttrs attrs, int size);
	[DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string app, StringBuilder command, ref SecurityAttrs procAttrs, ref SecurityAttrs threadAttrs, bool inherit, uint flags, IntPtr env, string cwd, ref Startup info, out ProcessInfo process);
	[DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
	[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
	[DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
	[DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits limits, int size);
	[DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, int size, IntPtr returned);
	[DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
	[DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
	[DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
	[DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
	[DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);

	// Sandbox: the write-restricted token.
	const uint TOKEN_ASSIGN_PRIMARY = 0x1, TOKEN_DUPLICATE = 0x2, TOKEN_QUERY = 0x8, TOKEN_ADJUST_DEFAULT = 0x80;
	const uint DISABLE_MAX_PRIVILEGE = 0x1, WRITE_RESTRICTED = 0x8;
	const int TokenUser = 1, TokenGroups = 2, TokenDefaultDacl = 6;
	const uint SE_GROUP_LOGON_ID = 0xC0000000;
	const int JobObjectBasicUIRestrictions = 4;
	const uint UI_HANDLES = 0x1, UI_READCLIPBOARD = 0x2, UI_WRITECLIPBOARD = 0x4, UI_SYSTEMPARAMETERS = 0x8, UI_DISPLAYSETTINGS = 0x10, UI_GLOBALATOMS = 0x20, UI_DESKTOP = 0x40, UI_EXITWINDOWS = 0x80;
	[StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr sid; public uint attributes; }
	[StructLayout(LayoutKind.Sequential)] struct TokenDefaultDaclInfo { public IntPtr dacl; }
	[StructLayout(LayoutKind.Sequential)] struct UiRestrictions { public uint flags; }
	[DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
	[DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr mem);
	[DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
	[DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr info, int length, out int returned);
	[DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int kind, ref TokenDefaultDaclInfo info, int length);
	[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSidToSidW(string sid, out IntPtr psid);
	[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr text);
	[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr descriptor, IntPtr size);
	[DllImport("advapi32.dll", SetLastError = true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
	[DllImport("advapi32.dll", SetLastError = true)] static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disableCount, IntPtr disable, uint deleteCount, IntPtr delete, uint restrictCount, SidAndAttributes[] restrict, out IntPtr token);
	[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessAsUserW(IntPtr token, string app, StringBuilder command, ref SecurityAttrs procAttrs, ref SecurityAttrs threadAttrs, bool inherit, uint flags, IntPtr env, string cwd, ref Startup info, out ProcessInfo process);
	[DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref UiRestrictions limits, int size);

	static volatile bool childDone;

	static int Main()
	{
		try { return Run(); }
		catch (Exception e)
		{
			try { Console.Error.WriteLine("zer0ne-job: " + e.Message); } catch { }
			return 125;
		}
	}

	static int Run()
	{
		// Preparing a project: grant, check or revoke its sandbox SID on folders (ZER0NE_SANDBOX_DIRS, '|'-separated).
		string aclMode = Environment.GetEnvironmentVariable("ZER0NE_SANDBOX_ACL");
		if (!string.IsNullOrEmpty(aclMode)) return Acl(Environment.GetEnvironmentVariable("ZER0NE_SANDBOX_SID"), aclMode, (Environment.GetEnvironmentVariable("ZER0NE_SANDBOX_DIRS") ?? "").Split('|'));
		string file = Environment.GetEnvironmentVariable("ZER0NE_JOB_FILE");
		string packed = Environment.GetEnvironmentVariable("ZER0NE_JOB_ARGS");
		bool verbatim = Environment.GetEnvironmentVariable("ZER0NE_JOB_VERBATIM") == "1";
		if (string.IsNullOrEmpty(file) || packed == null) throw new InvalidOperationException("missing job spec");
		string[] args = Unpack(packed);

		IntPtr job = CreateJobObject(IntPtr.Zero, null);
		if (job == IntPtr.Zero) throw new InvalidOperationException("CreateJobObject failed");
		var limits = new Limits();
		limits.basic.flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
		if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(Limits))))
			throw new InvalidOperationException("SetInformationJobObject failed");
		string sandboxSid = Environment.GetEnvironmentVariable("ZER0NE_SANDBOX_SID");
		IntPtr restricted = IntPtr.Zero;
		if (!string.IsNullOrEmpty(sandboxSid))
		{
			restricted = RestrictedToken(sandboxSid);
			var ui = new UiRestrictions();
			ui.flags = UI_HANDLES | UI_READCLIPBOARD | UI_WRITECLIPBOARD | UI_SYSTEMPARAMETERS | UI_DISPLAYSETTINGS | UI_GLOBALATOMS | UI_DESKTOP | UI_EXITWINDOWS;
			if (!SetInformationJobObject(job, JobObjectBasicUIRestrictions, ref ui, Marshal.SizeOf(typeof(UiRestrictions))))
				throw new InvalidOperationException("sandbox: job UI restrictions failed");
		}

		var inherit = new SecurityAttrs();
		inherit.length = Marshal.SizeOf(typeof(SecurityAttrs));
		inherit.inherit = true;
		IntPtr stdinR, stdinW, stdoutR, stdoutW, stderrR, stderrW;
		if (!CreatePipe(out stdinR, out stdinW, ref inherit, 0)) throw new InvalidOperationException("CreatePipe failed");
		if (!CreatePipe(out stdoutR, out stdoutW, ref inherit, 0)) throw new InvalidOperationException("CreatePipe failed");
		if (!CreatePipe(out stderrR, out stderrW, ref inherit, 0)) throw new InvalidOperationException("CreatePipe failed");
		// Only the ends the child reads/writes must be inherited; extra inheritable
		// copies are harmless (they neither create writers on our read ends nor hold
		// the engine's stdin open), and CreatePipe cannot set flags per end.
		SetHandleInformation(stdinW, HANDLE_FLAG_INHERIT, 0);
		SetHandleInformation(stdoutR, HANDLE_FLAG_INHERIT, 0);
		SetHandleInformation(stderrR, HANDLE_FLAG_INHERIT, 0);

		var start = new Startup();
		start.cb = Marshal.SizeOf(typeof(Startup));
		start.flags = STARTF_USESTDHANDLES;
		start.stdin = stdinR;
		start.stdout = stdoutW;
		start.stderr = stderrW;
		var procAttrs = new SecurityAttrs(); procAttrs.length = Marshal.SizeOf(typeof(SecurityAttrs)); procAttrs.inherit = true;
		var threadAttrs = new SecurityAttrs(); threadAttrs.length = Marshal.SizeOf(typeof(SecurityAttrs)); threadAttrs.inherit = true;
		var command = new StringBuilder(Quote(Resolve(file)));
		for (int i = 0; i < args.Length; i++)
		{
			command.Append(' ');
			command.Append(verbatim ? args[i] : Quote(args[i]));
		}
		ProcessInfo child;
		if (restricted != IntPtr.Zero)
		{
			if (!CreateProcessAsUserW(restricted, null, command, ref procAttrs, ref threadAttrs, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, null, ref start, out child))
				throw new InvalidOperationException("sandbox: CreateProcessAsUser failed for " + file + " (error " + Marshal.GetLastWin32Error() + ")");
			CloseHandle(restricted);
		}
		else if (!CreateProcessW(null, command, ref procAttrs, ref threadAttrs, true, CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, null, ref start, out child))
			throw new InvalidOperationException("CreateProcess failed for " + file);
		// Suspend-then-assign (as the terminal helper does): no grandchild can start
		// outside the job, and breakaway is not permitted, so the tree stays killable.
		if (!AssignProcessToJobObject(job, child.process))
			throw new InvalidOperationException("AssignProcessToJobObject failed");
		ResumeThread(child.thread);
		// The parent keeps the child's stdin write end: the engine's stdin is pumped
		// into it (command_input answers a prompt), and its EOF still means the
		// engine is gone (crash, kill) — end the whole job then.
		CloseHandle(stdinR);
		CloseHandle(stdoutW); CloseHandle(stderrW);

		new Thread(delegate ()
		{
			bool eof = false;
			try
			{
				IntPtr std = GetStdHandle(-10); // STD_INPUT_HANDLE
				if (std != IntPtr.Zero && std != new IntPtr(-1))
				{
					var input = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(std, false), FileAccess.Read, 4096, false);
					var sink = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(stdinW, false), FileAccess.Write, 4096, false);
					var buffer = new byte[4096];
					int n;
					while ((n = input.Read(buffer, 0, buffer.Length)) > 0) { sink.Write(buffer, 0, n); sink.Flush(); }
					eof = true;
					sink.Dispose();
				}
			}
			catch { }
			// No usable engine stdin: give the command EOF instead of a stdin that never closes.
			if (!eof) { try { CloseHandle(stdinW); } catch { } }
			if (eof && !childDone) { TerminateJobObject(job, 130); Environment.Exit(130); }
		}) { IsBackground = true, Name = "zer0ne-job-stdin" }.Start();

		var output = new Thread(delegate () { Copy(new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(stdoutR, false), FileAccess.Read, 65536, false), Console.OpenStandardOutput()); }) { IsBackground = true, Name = "zer0ne-job-out" };
		var errors = new Thread(delegate () { Copy(new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(stderrR, false), FileAccess.Read, 65536, false), Console.OpenStandardError()); }) { IsBackground = true, Name = "zer0ne-job-err" };
		output.Start(); errors.Start();

		WaitForSingleObject(child.process, INFINITE);
		uint code;
		GetExitCodeProcess(child.process, out code);
		// A shell can exit before a GUI-subsystem executable it launched (Electron
		// in Node mode still has that subsystem). Its descendants retain our pipes;
		// keep the job alive and cancellable until the entire command tree is done.
		Accounting accounting;
		while (QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero) && accounting.active != 0) Thread.Sleep(20);
		childDone = true;
		CloseHandle(child.thread);
		CloseHandle(child.process);
		CloseHandle(job); // kill-on-close ends anything the command left behind
		output.Join(5000); errors.Join(5000);
		CloseHandle(stdoutR); CloseHandle(stderrR);
		return unchecked((int)code);
	}

	/// <summary>
	/// This process's token, write-restricted to the project's sandbox SID, the logon session and
	/// Everyone, with every privilege but change-notify dropped. The default DACL names the same
	/// SIDs, so objects the command creates (its own processes, pipes) stay usable to it.
	/// </summary>
	static IntPtr RestrictedToken(string sandboxSid)
	{
		IntPtr token;
		if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT, out token))
			throw new InvalidOperationException("sandbox: OpenProcessToken failed");
		IntPtr cap, world, logon = IntPtr.Zero;
		if (!ConvertStringSidToSidW(sandboxSid, out cap)) throw new InvalidOperationException("sandbox: invalid SID");
		if (!ConvertStringSidToSidW("S-1-1-0", out world)) throw new InvalidOperationException("sandbox: Everyone SID");
		IntPtr groups = Info(token, TokenGroups);
		int count = Marshal.ReadInt32(groups), size = Marshal.SizeOf(typeof(SidAndAttributes));
		for (int i = 0; i < count; i++)
		{
			var g = (SidAndAttributes)Marshal.PtrToStructure(new IntPtr(groups.ToInt64() + IntPtr.Size + i * size), typeof(SidAndAttributes));
			if ((g.attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID) { logon = g.sid; break; }
		}
		if (logon == IntPtr.Zero) throw new InvalidOperationException("sandbox: no logon session SID");
		var restrict = new SidAndAttributes[3];
		restrict[0].sid = cap; restrict[1].sid = logon; restrict[2].sid = world;
		IntPtr restricted;
		if (!CreateRestrictedToken(token, DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED, 0, IntPtr.Zero, 0, IntPtr.Zero, 3, restrict, out restricted))
			throw new InvalidOperationException("sandbox: CreateRestrictedToken failed (error " + Marshal.GetLastWin32Error() + ")");
		IntPtr user = Info(token, TokenUser);
		string sddl = "D:(A;;GA;;;" + SidText(Marshal.ReadIntPtr(user)) + ")(A;;GA;;;SY)(A;;GA;;;" + sandboxSid + ")(A;;GA;;;" + SidText(logon) + ")";
		IntPtr descriptor, dacl;
		bool present, defaulted;
		if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, IntPtr.Zero) || !GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted))
			throw new InvalidOperationException("sandbox: default DACL");
		var info = new TokenDefaultDaclInfo();
		info.dacl = dacl;
		if (!SetTokenInformation(restricted, TokenDefaultDacl, ref info, Marshal.SizeOf(typeof(TokenDefaultDaclInfo))))
			throw new InvalidOperationException("sandbox: SetTokenInformation failed (error " + Marshal.GetLastWin32Error() + ")");
		CloseHandle(token);
		return restricted;
	}

	/// <summary>
	/// The project's ACL entry: Modify for the sandbox SID, inherited by everything below
	/// (Windows propagates it to existing children). "check" exits 3 when a folder lacks it.
	/// "deny"/"undeny" add or remove a read-deny entry for the SID on files or folders.
	/// </summary>
	static int Acl(string sid, string mode, string[] dirs)
	{
		if (string.IsNullOrEmpty(sid)) throw new InvalidOperationException("sandbox: no SID");
		var id = new SecurityIdentifier(sid);
		const InheritanceFlags both = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
		foreach (string dir in dirs)
		{
			if (dir.Length == 0) continue;
			if (mode == "deny" || mode == "undeny")
			{
				bool isDir = Directory.Exists(dir);
				if (!isDir && !File.Exists(dir)) continue;
				FileSystemSecurity targetSecurity = isDir
					? (FileSystemSecurity)new DirectoryInfo(dir).GetAccessControl(AccessControlSections.Access)
					: (FileSystemSecurity)new FileInfo(dir).GetAccessControl(AccessControlSections.Access);
				if (mode == "deny")
				{
					targetSecurity.AddAccessRule(new FileSystemAccessRule(id, FileSystemRights.Read, isDir ? both : InheritanceFlags.None, PropagationFlags.None, AccessControlType.Deny));
				}
				else
				{
					var remove = new System.Collections.Generic.List<FileSystemAccessRule>();
					foreach (FileSystemAccessRule r in targetSecurity.GetAccessRules(true, false, typeof(SecurityIdentifier)))
						if (r.IdentityReference.Equals(id) && r.AccessControlType == AccessControlType.Deny) remove.Add(r);
					foreach (FileSystemAccessRule r in remove) targetSecurity.RemoveAccessRuleSpecific(r);
				}
				if (isDir) new DirectoryInfo(dir).SetAccessControl((DirectorySecurity)targetSecurity);
				else new FileInfo(dir).SetAccessControl((FileSecurity)targetSecurity);
				continue;
			}
			var info = new DirectoryInfo(dir);
			DirectorySecurity security = info.GetAccessControl(AccessControlSections.Access);
			if (mode == "check")
			{
				bool found = false;
				foreach (FileSystemAccessRule r in security.GetAccessRules(true, false, typeof(SecurityIdentifier)))
					if (r.IdentityReference.Equals(id) && r.AccessControlType == AccessControlType.Allow && (r.FileSystemRights & FileSystemRights.Modify) == FileSystemRights.Modify && r.InheritanceFlags == both) found = true;
				if (!found) return 3;
			}
			else if (mode == "grant")
			{
				security.AddAccessRule(new FileSystemAccessRule(id, FileSystemRights.Modify, both, PropagationFlags.None, AccessControlType.Allow));
				info.SetAccessControl(security);
			}
			else if (mode == "revoke")
			{
				security.PurgeAccessRules(id);
				info.SetAccessControl(security);
			}
			else throw new InvalidOperationException("sandbox: unknown ACL mode");
		}
		return 0;
	}

	static IntPtr Info(IntPtr token, int kind)
	{
		int length;
		GetTokenInformation(token, kind, IntPtr.Zero, 0, out length);
		IntPtr buffer = Marshal.AllocHGlobal(length);
		if (!GetTokenInformation(token, kind, buffer, length, out length)) throw new InvalidOperationException("sandbox: GetTokenInformation failed");
		return buffer; // lives as long as this short-lived helper
	}

	static string SidText(IntPtr sid)
	{
		IntPtr text;
		if (!ConvertSidToStringSidW(sid, out text)) throw new InvalidOperationException("sandbox: SID text");
		string s = Marshal.PtrToStringUni(text);
		LocalFree(text);
		return s;
	}

	static void Copy(Stream from, Stream to)
	{
		var buffer = new byte[65536];
		try
		{
			int n;
			while ((n = from.Read(buffer, 0, buffer.Length)) > 0) to.Write(buffer, 0, n);
			to.Flush();
		}
		catch { }
		try { from.Dispose(); } catch { }
	}

	/// <summary>PATH search matching Node's spawn for bare names; absolute paths pass through.</summary>
	static string Resolve(string file)
	{
		if (file.IndexOf('/') < 0 && file.IndexOf('\\') < 0)
		{
			foreach (string dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
			{
				if (dir.Trim().Length == 0) continue;
				string candidate = Path.Combine(dir.Trim(), file);
				if (File.Exists(candidate)) return candidate;
				if (!Path.HasExtension(file) && File.Exists(candidate + ".exe")) return candidate + ".exe";
			}
		}
		return file; // let CreateProcess try its own search
	}

	/// <summary>Canonical MSVCRT argv quoting: quote when needed, double backslashes before a quote.</summary>
	static string Quote(string a)
	{
		bool need = a.Length == 0;
		for (int i = 0; i < a.Length && !need; i++) if (a[i] == ' ' || a[i] == '\t' || a[i] == '"') need = true;
		if (!need) return a;
		var sb = new StringBuilder(a.Length + 8);
		sb.Append('"');
		int run = 0;
		for (int i = 0; i < a.Length; i++)
		{
			char c = a[i];
			if (c == '\\') { run++; continue; }
			if (c == '"') { sb.Append('\\', run * 2 + 1); sb.Append('"'); run = 0; continue; }
			if (run > 0) { sb.Append('\\', run); run = 0; }
			sb.Append(c);
		}
		sb.Append('\\', run * 2); // backslashes before the closing quote double too
		sb.Append('"');
		return sb.ToString();
	}

	/// <summary>argv from ZER0NE_JOB_ARGS: <count>;<len1>:<arg1><len2>:<arg2>… (UTF-16 code-unit lengths).</summary>
	static string[] Unpack(string packed)
	{
		int semi = packed.IndexOf(';');
		int count = int.Parse(semi > 0 ? packed.Substring(0, semi) : "0");
		var args = new string[count];
		int at = semi + 1;
		for (int i = 0; i < count; i++)
		{
			int colon = packed.IndexOf(':', at);
			if (colon < 0) throw new InvalidOperationException("corrupt ZER0NE_JOB_ARGS");
			int len = int.Parse(packed.Substring(at, colon - at));
			args[i] = packed.Substring(colon + 1, len);
			at = colon + 1 + len;
		}
		return args;
	}
}
