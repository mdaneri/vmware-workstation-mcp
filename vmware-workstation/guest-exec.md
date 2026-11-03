# Verified guest execution

`guest_exec` runs an authorized program or script in a selected VM, captures bounded stdout and stderr, and verifies its exit code using a unique guest completion record. It uses VMware Tools and local credential profiles on either Windows or native Linux hosts. See [issue #13](https://github.com/mdaneri/vmware-workstation-mcp/issues/13) and [tracker #6](https://github.com/mdaneri/vmware-workstation-mcp/issues/6).

## Prerequisites

The guest must already be running with VMware Tools and a configured guest account. Select `guest_os` explicitly: it describes the guest, independently of the host. Linux guests require `/usr/bin/python3`; Windows guests require Windows PowerShell 5.1 at `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` and permission to compile the small .NET capture helper. Restricted language/application-control policies may prevent execution; the result stays unavailable or indeterminate. There is no automatic SSH, WinRM, console or GUI fallback.

Configure credentials locally using the [credential setup](README.md#configure-credentials-locally). `guest_profile` is required even for the profile named `default`. Optional `vm_password_profile` selects an encrypted-VM password. No plaintext password argument is accepted. Do not paste credentials into scripts or arguments. Known local credential passwords are redacted from returned text; arbitrary guest secrets cannot be identified automatically. The underlying vmrun process still requires credential arguments visible to sufficiently privileged host process inspectors.

The host uses a new private temporary directory beneath `VMWARE_GUEST_EXEC_ROOT` (default: the OS temporary directory). Set this variable to an existing writable directory inside `VMWARE_ALLOWED_HOST_ROOTS` when host roots are restricted. Files receive mode 600 on Linux or the existing current-user-only Windows ACL policy. All VM targets pass through `VMWARE_ALLOWED_ROOTS` validation, and the server reserves the VM against conflicting mutations while execution is pending.

The guest uses a new UUID-named directory beneath `/tmp` or `C:\Windows\Temp`. Optional `guest_temp_directory` selects an existing writable guest directory; it must be an absolute path containing only letters, digits, underscores, dots, separators, colon and hyphen, with no `..` component. Use a private guest directory when command text is sensitive. This path restriction applies only to staging; executable paths and literal arguments can contain spaces, quotes and Unicode.

## Run a program

After authorizing the command and its effects, use:

```json
{
  "tool": "guest_exec",
  "arguments": {
    "vmx": "/home/me/vms/lab/lab.vmx",
    "guest_os": "linux",
    "guest_profile": "linux_lab",
    "program": "/usr/bin/printf",
    "arguments": ["%s\n", "literal $HOME; no shell expansion"],
    "timeout_seconds": 20,
    "max_output_bytes": 65536,
    "confirm": true
  }
}
```

Use a Windows host VMX path such as `C:\VMs\Lab\Lab.vmx` when the host runs Windows. For a Windows guest, set `guest_os: "windows"` and a guest executable such as `C:\Windows\System32\whoami.exe`. Paths describe their own OS, regardless of the other OS. Windows arguments use standard Windows executable argument quoting; unusual programs with custom command-line parsers may interpret arguments differently. No host shell is used, and shell expansion is never added implicitly. Commands run with stdin closed and no interactive console.

`confirm: true` records authorization for this exact command, including destructive effects if any. A request to inspect a guest does not authorize installing software, deleting files or restarting services. Do not replay a command automatically after a timeout or transport failure.

## Run a script

Choose either `program`/`arguments`, or `script`/`interpreter`/`interpreter_arguments`. The executable or interpreter must be an absolute guest path. Script text is transferred as UTF-8 data; it is not interpolated into a host or guest launch command. The selected interpreter determines script expansion. Interpreter arguments precede the generated script filename.

Linux example:

```json
{
  "vmx": "/home/me/vms/lab/lab.vmx",
  "guest_os": "linux",
  "guest_profile": "linux_lab",
  "interpreter": "/bin/sh",
  "script": "printf 'hello\\n'; printf 'problem\\n' >&2; exit 7",
  "timeout_seconds": 20,
  "max_output_bytes": 4096,
  "confirm": true
}
```

Windows example:

```json
{
  "vmx": "C:\\VMs\\Lab\\Lab.vmx",
  "guest_os": "windows",
  "guest_profile": "windows_lab",
  "interpreter": "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "interpreter_arguments": ["-NoProfile", "-NonInteractive", "-File"],
  "script": "[Console]::Out.Write('hello'); [Console]::Error.Write('problem'); exit 7",
  "timeout_seconds": 20,
  "max_output_bytes": 4096,
  "confirm": true
}
```

Windows PowerShell scripts use a `.ps1` filename and a UTF-8 BOM for PowerShell 5.1. Other interpreters receive a UTF-8 `.script` file without a BOM. For PowerShell, use an explicit `exit` when the script needs to define the process exit code; a non-terminating PowerShell error alone may still yield exit code zero.

## Interpret results

| Field | Meaning |
| --- | --- |
| `transport.status` | `succeeded`, `failed`, `timed_out`, or `cancelled`; this is independent of guest program success. |
| `transport.phase` | Last stage reached: setup, tools, create_directory, upload, launch, completion, download or verify. Native errors and command text are omitted. |
| `transport.launch_succeeded` | vmrun accepted the runner launch. This alone never verifies command completion. |
| `status: "completed"` | A versioned completion record matches this call's random nonce and passes output/exit validation. Inspect `exit_code`, including nonzero values. |
| `status: "timed_out"` | The runner observed the command timeout. `exit_code` is null. |
| `status: "unavailable"` | Execution was not attempted, or the runner could not start/capture the command. `exit_code` is null. |
| `status: "indeterminate"` | Launch may have occurred, but a valid completion record or fully drained streams are unavailable. `exit_code` is null. |
| `timed_out`, `cancelled` | Distinguish timeout observations from MCP cancellation. A guest timeout can coexist with indeterminate output when descendants retain pipes. |
| `stdout`, `stderr` | Captured bytes decoded as UTF-8, with known credential redaction. Other encodings and split multibyte tails may display replacement characters. |
| `stdout_bytes`, `stderr_bytes` | Retained byte counts before UTF-8 decoding and redaction. |
| `stdout_truncated`, `stderr_truncated` | The runner discarded bytes beyond `max_output_bytes` for that stream. False on an unavailable capture does not prove empty output. |
| `cleanup` | Separate host/guest outcomes. Guest paths are returned when cleanup fails or the execution outcome is unknown. |

The runner drains both streams while retaining at most `max_output_bytes` each (default 64 KiB, maximum 256 KiB per stream). It writes a bounded JSON envelope containing encoded stdout/stderr, a nonce, status and exit code, then atomically publishes `result.json`. Polling and file transfer retrieve this record; a zero vmrun exit never substitutes for it. The record verifies the selected guest runner's observation, not the integrity of a compromised guest. No raw output or request text is logged by this feature.

`timeout_seconds` bounds the guest command (1–600 seconds). The host allows that duration plus 30 seconds for staging and collection; individual native operations are capped at 10 seconds. Give the MCP client at least `timeout_seconds + 45` seconds. Cancellation stops waiting and native transport but cannot guarantee guest termination. On command timeout Linux attempts to kill the new process group; Windows PowerShell 5.1 kills the directly launched process, without a guaranteed descendant-tree kill. Child processes can escape or retain pipes; inspect uncertain state before any further action.

Cleanup removes only this call's guest directory after a verified record, including verified timeout/unavailable results. Missing Tools, a restart, transfer failure, cancellation or a missing/malformed record may leave staged files and a running process. Those files are retained and identified for separately authorized inspection. A directory creation transport failure reports `creation_unconfirmed`; the directory may exist. Host scratch files are removed in all ordinary return paths. Host process termination can interrupt cleanup. Guest cleanup has a separate five-second bound; cleanup failure never overwrites a verified exit code.

Existing `vmrun_run_program_in_guest` and `vmrun_run_script_in_guest` remain unchanged: their results describe vmrun invocation only. Direct VNC behavior is unchanged.

## Validation

Default tests mock Tools transports for both guest OSes and execute the native runner on each matching Windows/Linux CI host. They cover literal arguments, script mode, both streams, nonzero exit, timeout, output bounds, credential redaction, restarts, missing Tools, transfer errors, malformed records, cancellation, allowlists and cleanup failures. A bundled MCP test checks private transfers and all 128 previous tool definitions.

Live VMware execution is opt-in and has not been run for this feature. Prepare a closed, fully powered-off, unencrypted template with no saved state, working Tools, a locally configured account and the required guest runner. Authorize reading/full-cloning this template and creating, booting, executing the fixed tests in, and hard-stopping one NEW disposable clone. The harness disconnects the clone's configured NICs and disables its VNC listener before boot. It never runs commands or changes power in the source VM, never captures a desktop and retains the clone and sanitized evidence under ignored `test-vms/`.

```powershell
$env:VMWARE_GUEST_EXEC_LIVE = '1'
$env:VMWARE_GUEST_EXEC_LIVE_SOURCE_VMX = 'C:\VMs\OfflineTemplate\Template.vmx'
$env:VMWARE_GUEST_EXEC_LIVE_OS = 'linux' # or windows
$env:VMWARE_GUEST_EXEC_LIVE_PROFILE = 'linux_lab'
npm run test:guest-exec:live
```

Use equivalent environment assignments on native Linux. WSL is refused as live hypervisor evidence. Hosted CI never runs the live harness. Review evidence for each host/guest combination separately; passing transport mocks or a native local runner test does not prove authenticated VMware guest execution.
