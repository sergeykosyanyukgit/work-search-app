param(
  [Parameter(Mandatory = $true)][ValidateRange(1, 255)][int]$VirtualKey,
  [switch]$Control,
  [switch]$Alt,
  [switch]$Shift,
  [Parameter(Mandatory = $true)][long]$ExpectedForegroundHandle,
  [Parameter(Mandatory = $true)][int]$ExpectedProcessId
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class NativeHotkey {
  [StructLayout(LayoutKind.Sequential)] struct MouseInput {
    public int dx, dy;
    public uint mouseData, flags, time;
    public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] struct KeyboardInput {
    public ushort key, scan;
    public uint flags, time;
    public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion {
    [FieldOffset(0)] public MouseInput mouse;
    [FieldOffset(0)] public KeyboardInput keyboard;
  }
  [StructLayout(LayoutKind.Sequential)] struct Input {
    public uint type;
    public InputUnion data;
  }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] input, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  static Input Key(ushort key, bool up) {
    return new Input { type = 1, data = new InputUnion { keyboard = new KeyboardInput { key = key, flags = up ? 2u : 0u } } };
  }
  public static void Send(ushort key, bool control, bool alt, bool shift, long expectedHandle, int expectedProcessId) {
    uint processId;
    GetWindowThreadProcessId(new IntPtr(expectedHandle), out processId);
    if (expectedHandle == 0 || processId != expectedProcessId) throw new Exception("Input target does not belong to the test application (actual PID=" + processId + ", expected PID=" + expectedProcessId + "); no keys were sent.");
    SetForegroundWindow(new IntPtr(expectedHandle));
    System.Threading.Thread.Sleep(100);
    long foreground = GetForegroundWindow().ToInt64();
    if (expectedHandle == 0 || foreground != expectedHandle) throw new Exception("Test input window is not foreground (actual=" + foreground + ", expected=" + expectedHandle + "); no keys were sent.");
    var modifiers = new List<ushort>();
    if (control) modifiers.Add(0x11);
    if (alt) modifiers.Add(0x12);
    if (shift) modifiers.Add(0x10);
    var inputs = new List<Input>();
    foreach (var modifier in modifiers) inputs.Add(Key(modifier, false));
    inputs.Add(Key(key, false));
    inputs.Add(Key(key, true));
    modifiers.Reverse();
    foreach (var modifier in modifiers) inputs.Add(Key(modifier, true));
    if (SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(Input))) != inputs.Count) {
      var releases = new List<Input>();
      releases.Add(Key(key, true));
      foreach (var modifier in modifiers) releases.Add(Key(modifier, true));
      SendInput((uint)releases.Count, releases.ToArray(), Marshal.SizeOf(typeof(Input)));
      throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows did not accept all test keyboard events.");
    }
  }
}
'@
[NativeHotkey]::Send([UInt16]$VirtualKey, $Control.IsPresent, $Alt.IsPresent, $Shift.IsPresent, $ExpectedForegroundHandle, $ExpectedProcessId)
