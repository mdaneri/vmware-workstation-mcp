# Read-only observation for console integration tests. No capture or input/activation API.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ForegroundObservation {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
while ($true) {
    $window = [ForegroundObservation]::GetForegroundWindow()
    [uint32]$foregroundProcessId = 0
    [void][ForegroundObservation]::GetWindowThreadProcessId($window, [ref]$foregroundProcessId)
    $processName = if ($foregroundProcessId) { (Get-Process -Id $foregroundProcessId -ErrorAction SilentlyContinue).ProcessName } else { $null }
    @{ timestamp = [DateTimeOffset]::UtcNow.ToString('O'); window = $window.ToInt64().ToString(); processId = $foregroundProcessId; processName = $processName } | ConvertTo-Json -Compress
    Start-Sleep -Milliseconds 100
}
