// These runners execute only inside the selected guest, never on the host.
// Input is data in a private per-call directory, not interpolated shell text.
export const linuxRunner = String.raw`import base64, json, os, signal, subprocess, sys, threading

os.umask(0o077)
root = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(root, 'request.json'), encoding='utf-8') as f:
    request = json.load(f)
result = dict(protocol=1, nonce=request['nonce'], status='unavailable', exit_code=None, timed_out=False,
              stdout_base64='', stderr_base64='', stdout_truncated=False, stderr_truncated=False)
buffers = [bytearray(), bytearray()]
truncated = [False, False]
def drain(stream, index):
    try:
        while True:
            data = stream.read(8192)
            if not data: break
            remaining = request['max_output_bytes'] - len(buffers[index])
            buffers[index].extend(data[:max(0, remaining)])
            if len(data) > remaining: truncated[index] = True
    except (OSError, ValueError):
        pass

try:
    command = [request['program']] + request['arguments']
    if request.get('script') is not None:
        script = os.path.join(root, 'command.script')
        with open(script, 'x', encoding='utf-8', newline='') as f: f.write(request['script'])
        command = [request['interpreter']] + request['interpreter_arguments'] + [script]
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, shell=False, start_new_session=True)
    threads = [threading.Thread(target=drain, args=(stream, index), daemon=True)
               for index, stream in enumerate([process.stdout, process.stderr])]
    for thread in threads: thread.start()
    try:
        process.wait(timeout=request['timeout_seconds'])
        result['status'] = 'completed'
        result['exit_code'] = process.returncode
    except subprocess.TimeoutExpired:
        result['status'] = 'timed_out'
        result['timed_out'] = True
        try: os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        process.wait(timeout=2)
    for thread in threads: thread.join(timeout=1)
    if any(thread.is_alive() for thread in threads):
        # Descendants may hold pipes open. Completion/output cannot be verified.
        result['status'] = 'indeterminate'
        result['exit_code'] = None
    for index, name in enumerate(['stdout', 'stderr']):
        result[name + '_base64'] = base64.b64encode(bytes(buffers[index])).decode('ascii')
        result[name + '_truncated'] = truncated[index]
except Exception:
    # Exceptions can contain command text or secrets. Publish only a category.
    result['status'] = 'unavailable'
    result['exit_code'] = None
with open(os.path.join(root, 'result.partial'), 'x', encoding='ascii') as f:
    json.dump(result, f, ensure_ascii=True)
os.replace(os.path.join(root, 'result.partial'), os.path.join(root, 'result.json'))
`;

export const windowsRunner = String.raw`$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$request = Get-Content -LiteralPath (Join-Path $root 'request.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$result = @{ protocol=1; nonce=$request.nonce; status='unavailable'; exit_code=$null; timed_out=$false; stdout_base64=''; stderr_base64=''; stdout_truncated=$false; stderr_truncated=$false }
try {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
using System.Text;
using System.Threading.Tasks;
public class GuestExecCapture {
    public byte[][] Data = new byte[][] { new byte[0], new byte[0] };
    public bool[] Truncated = new bool[2];
    public string Status = "unavailable";
    public bool TimedOut;
    public int? ExitCode;
    public static string Quote(string value) {
        var b = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') b.Append('\\', slashes * 2 + 1);
            else b.Append('\\', slashes);
            b.Append(c); slashes = 0;
        }
        b.Append('\\', slashes * 2); return b.Append('"').ToString();
    }
    private async Task Drain(Stream stream, int index, int limit) {
        using (var saved = new MemoryStream()) {
            var buffer = new byte[8192]; int count;
            while ((count = await stream.ReadAsync(buffer, 0, buffer.Length)) > 0) {
                int keep = Math.Min(count, limit - (int)saved.Length);
                if (keep > 0) {
                    saved.Write(buffer, 0, keep);
                    // Once full, drain without repeatedly copying the cap.
                    Data[index] = saved.ToArray();
                }
                if (keep < count) Truncated[index] = true;
            }
        }
    }
    public void Run(string program, string[] args, int timeout, int limit) {
        var command = new StringBuilder();
        foreach (var arg in args) { if (command.Length > 0) command.Append(' '); command.Append(Quote(arg)); }
        var start = new ProcessStartInfo(program, command.ToString()) {
            UseShellExecute=false, CreateNoWindow=true, RedirectStandardInput=true,
            RedirectStandardOutput=true, RedirectStandardError=true
        };
        using (var process = Process.Start(start)) {
            process.StandardInput.Close();
            var output = Drain(process.StandardOutput.BaseStream, 0, limit);
            var error = Drain(process.StandardError.BaseStream, 1, limit);
            if (process.WaitForExit(timeout)) { Status="completed"; ExitCode=process.ExitCode; }
            else {
                Status="timed_out";
                TimedOut=true;
                // Kill only the process this invocation created. Descendant
                // termination is not guaranteed on Windows PowerShell 5.1.
                try { process.Kill(); } catch { }
            }
            try {
                if (!Task.WaitAll(new Task[] { output, error }, 2000)) { Status="indeterminate"; ExitCode=null; }
            } catch { Status="indeterminate"; ExitCode=null; }
        }
    }
}
'@
    $program = [string]$request.program
    [string[]]$commandArguments = @($request.arguments)
    if ($null -ne $request.script) {
        $scriptPath = Join-Path $root 'command.script'
        # PowerShell 5.1 needs a BOM to preserve non-ASCII script text.
        if ([string]$request.interpreter -match '(?i)(?:powershell|pwsh)(?:\.exe)?$') { $scriptPath = Join-Path $root 'command.ps1' }
        $bom = $scriptPath.EndsWith('.ps1')
        [IO.File]::WriteAllText($scriptPath, [string]$request.script, [Text.UTF8Encoding]::new($bom))
        $program = [string]$request.interpreter
        $commandArguments = @($request.interpreter_arguments) + @($scriptPath)
    }
    $capture = New-Object GuestExecCapture
    $capture.Run($program, $commandArguments, ([int]$request.timeout_seconds * 1000), [int]$request.max_output_bytes)
    $result.status = $capture.Status
    $result.exit_code = $capture.ExitCode
    $result.timed_out = $capture.TimedOut
    $result.stdout_base64 = [Convert]::ToBase64String($capture.Data[0])
    $result.stderr_base64 = [Convert]::ToBase64String($capture.Data[1])
    $result.stdout_truncated = $capture.Truncated[0]
    $result.stderr_truncated = $capture.Truncated[1]
} catch { $result.status = 'unavailable'; $result.exit_code = $null }
[IO.File]::WriteAllText((Join-Path $root 'result.partial'), ($result | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath (Join-Path $root 'result.partial') -Destination (Join-Path $root 'result.json')
`;
