// Legacy Low-integrity launchers cannot isolate writes between prepared projects.
// Fail closed for any direct invocation; the app requests explicit command approval.
using System;
static class LowIL
{
	static int Main()
	{
		Console.Error.WriteLine("zer0ne sandbox: secure command sandboxing is unavailable on Windows");
		return 125;
	}
}
