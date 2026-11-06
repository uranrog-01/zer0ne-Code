param([int]$TargetProcess, [switch]$Minimize)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TaskbarRestoreFixture {
 public delegate bool EnumProc(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint process);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int command);
 [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint message, IntPtr wParam, IntPtr lParam);
 public static void Restore(uint process) {
  IntPtr target = IntPtr.Zero; int count = 0;
  var elapsed = System.Diagnostics.Stopwatch.StartNew();
  do {
   count = 0;
   EnumWindows((h, unused) => { uint owner; GetWindowThreadProcessId(h, out owner); if (owner == process && IsIconic(h)) { target = h; count++; } return true; }, IntPtr.Zero);
   if (target == IntPtr.Zero) System.Threading.Thread.Sleep(20);
  } while (target == IntPtr.Zero && elapsed.ElapsedMilliseconds < 3000);
  if (count > 1) throw new Exception("More than one test window is minimized.");
  if (target == IntPtr.Zero) throw new Exception("The disposable test app has no minimized window.");
  if (!PostMessage(target, 0x0112, new IntPtr(0xf120), IntPtr.Zero)) throw new Exception("Windows rejected the restore request.");
 }
 // A background process cannot always minimize its own window; the test then does it
 // through the window itself, which is the same OS state the taskbar restore exercises.
 public static void Minimize(uint process) {
  IntPtr target = IntPtr.Zero;
  var elapsed = System.Diagnostics.Stopwatch.StartNew();
  do {
   EnumWindows((h, unused) => { uint owner; GetWindowThreadProcessId(h, out owner); if (owner == process && IsWindowVisible(h) && !IsIconic(h)) { target = h; return false; } return true; }, IntPtr.Zero);
   if (target == IntPtr.Zero) System.Threading.Thread.Sleep(20);
  } while (target == IntPtr.Zero && elapsed.ElapsedMilliseconds < 3000);
  if (target == IntPtr.Zero) throw new Exception("The disposable test app has no visible window to minimize.");
  ShowWindow(target, 6 /* SW_MINIMIZE */);
  elapsed.Restart();
  while (!IsIconic(target) && elapsed.ElapsedMilliseconds < 3000) System.Threading.Thread.Sleep(20);
  if (!IsIconic(target)) throw new Exception("The test window did not become minimized.");
 }
}
'@
if ($Minimize) { [TaskbarRestoreFixture]::Minimize($TargetProcess) } else { [TaskbarRestoreFixture]::Restore($TargetProcess) }
