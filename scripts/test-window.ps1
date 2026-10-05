param([Parameter(Mandatory = $true)][int]$ProcessId)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeWindowTest {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr param);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int count);
}
'@
$script:handle = [IntPtr]::Zero
$callback = [NativeWindowTest+EnumProc]{
    param($hwnd, $unused)
    [uint32]$owner = 0
    [void][NativeWindowTest]::GetWindowThreadProcessId($hwnd, [ref]$owner)
    if ($owner -eq $ProcessId -and [NativeWindowTest]::IsWindowVisible($hwnd)) {
        $script:handle = $hwnd
        return $false
    }
    return $true
}
[void][NativeWindowTest]::EnumWindows($callback, [IntPtr]::Zero)
if ($script:handle -eq [IntPtr]::Zero) { throw 'Test browser window not found' }
$title = New-Object System.Text.StringBuilder 512
[void][NativeWindowTest]::GetWindowText($script:handle, $title, $title.Capacity)
if (-not $title.ToString().EndsWith('Rovuka')) { throw "Expected native window brand Rovuka" }
$style = [NativeWindowTest]::GetWindowLongPtr($script:handle, -16).ToInt64()
foreach ($flag in @(0x20000, 0x10000, 0x40000)) {
    if (($style -band $flag) -eq 0) { throw "Native window capability missing: $flag" }
}
try {
    [void][NativeWindowTest]::ShowWindow($script:handle, 3)
    Start-Sleep -Milliseconds 400
    if (-not [NativeWindowTest]::IsZoomed($script:handle)) { throw 'Maximize failed' }
    [void][NativeWindowTest]::ShowWindow($script:handle, 6)
    Start-Sleep -Milliseconds 400
    if (-not [NativeWindowTest]::IsIconic($script:handle)) { throw 'Minimize failed' }
} finally {
    [void][NativeWindowTest]::ShowWindow($script:handle, 9)
    Start-Sleep -Milliseconds 200
    if ([NativeWindowTest]::IsZoomed($script:handle)) {
        [void][NativeWindowTest]::ShowWindow($script:handle, 9)
    }
}
Start-Sleep -Milliseconds 400
if ([NativeWindowTest]::IsZoomed($script:handle) -or [NativeWindowTest]::IsIconic($script:handle)) { throw 'Restore failed' }
Write-Output 'PASS: Rovuka native title, minimize/maximize/restore and resizable titlebar styles'
