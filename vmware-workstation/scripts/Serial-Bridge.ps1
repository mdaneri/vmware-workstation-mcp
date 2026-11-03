# Internal binary bridge: never invokes a shell command, terminal or desktop API.
param(
    [Parameter(Mandatory)][ValidatePattern('^vmware-mcp-serial-[a-f0-9]{32}-[0-3]$')][string]$PipeName,
    [Parameter(Mandatory)][string]$VMX,
    [ValidateRange(1, 10000)][int]$ConnectTimeoutMs = 10000
)
$ErrorActionPreference = 'Stop'
$serialPipe = $null
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SerialNative {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CommandLineToArgvW(string text, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr ptr);
    public static string[] Arguments(string text) {
        int count; IntPtr ptr = CommandLineToArgvW(text, out count);
        if (ptr == IntPtr.Zero) throw new Exception("Cannot read process arguments");
        try {
            var result = new string[count];
            for (int i=0; i<count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(ptr, i*IntPtr.Size));
            return result;
        } finally { LocalFree(ptr); }
    }
}
'@
    $serialPipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
    $serialPipe.Connect($ConnectTimeoutMs)
    [uint32]$serialOwner = 0
    if (-not [SerialNative]::GetNamedPipeServerProcessId($serialPipe.SafePipeHandle.DangerousGetHandle(), [ref]$serialOwner)) { throw 'Unverified owner' }
    $serialProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$serialOwner"
    if ($serialProcess.Name -ine 'vmware-vmx.exe' -or -not $serialProcess.CommandLine) { throw 'Unverified worker' }
    $serialArgs = [SerialNative]::Arguments($serialProcess.CommandLine)
    $serialMatch = @($serialArgs | Where-Object { [string]::Equals($_.Replace('/', '\'), $VMX.Replace('/', '\'), [StringComparison]::OrdinalIgnoreCase) })
    if ($serialMatch.Count -ne 1) { throw 'Different VM' }
    [Console]::Error.Write("SERIAL_READY`n")
    $serialInput = [Console]::OpenStandardInput()
    $serialOutput = [Console]::OpenStandardOutput()
    $serialRead = $serialPipe.CopyToAsync($serialOutput, 4096)
    $serialWrite = $serialInput.CopyToAsync($serialPipe, 4096)
    [void][System.Threading.Tasks.Task]::WaitAny([System.Threading.Tasks.Task[]]@($serialRead, $serialWrite))
    # Finishing either direction closes the session. Never echo bytes to stderr.
    if ($serialRead.IsFaulted -or $serialWrite.IsFaulted) { throw 'Disconnected' }
} catch {
    [Console]::Error.Write("SERIAL_UNAVAILABLE`n")
    exit 1
} finally {
    if ($null -ne $serialPipe) { $serialPipe.Dispose() }
}
