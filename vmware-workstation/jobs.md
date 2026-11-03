# Background jobs, cancellation and recovery

Version 0.12.0 extends the OVF job engine with `job_start`. Submit explicit disk
conversion/expansion, full offline clone or VM power steps and receive a job ID
promptly. Existing disk, vmrun and power tools keep their synchronous interfaces.
OVF tools use the same engine and still return job IDs.

## Convert a disk while another VM is cloned

After authorizing these exact targets, call `job_start` with:

```json
{
  "confirm": true,
  "timeout_seconds": 1800,
  "steps": [{
    "operation": "disk_convert",
    "arguments": {
      "disk": "C:/VMs/lab-a/disk.vmdk",
      "destination": "C:/VMs/converted-a/disk.vmdk",
      "disk_type": "0",
      "confirm": true
    }
  }]
}
```

Submit another job without waiting for the first:

```json
{
  "confirm": true,
  "steps": [{
    "operation": "clone",
    "arguments": {
      "vmx": "C:/VMs/lab-b/lab-b.vmx",
      "destination_vmx": "C:/VMs/clone-b/clone-b.vmx",
      "name": "Lab B copy",
      "timeout_seconds": 1800
    }
  }]
}
```

On native Linux, use absolute native paths such as `/srv/vmware/lab-a/disk.vmdk`.
WSL does not establish native VMware support or bridge to Windows VMs. Configure
`VMWARE_ALLOWED_ROOTS` for VMs and `VMWARE_ALLOWED_HOST_ROOTS` for disk/media files
as in the [setup guide](README.md). Both output parent directories must be NEW
and their parents must exist. Clone sources must be fully powered off, unlocked,
snapshot-free and self-contained. Encrypted, vTPM, external-backing and linked
sources are refused. [Disk safety checks](disks.md) and confirmations still apply.
Keep other disk writers and VMware GUIs closed.

Poll `job_status` with each returned `job_id`. `state: "running"` with
`progress: null` means percentage is unknown. Disk and clone backends currently
report no percentage. OVF uses actual machine-mode progress records; exit never
synthesizes 100%. Disk success requires descriptor/capacity inspection; clone
success requires an inspectable, self-contained output VMX. Neither proves boot
or guest readiness.

## Expand a disk or sequence VM actions

Expansion specifies total capacity in MiB, not an increment:

```json
{
  "confirm": true,
  "steps": [{
    "operation": "disk_expand",
    "arguments": {
      "disk": "C:/VMs/lab-a/disk.vmdk",
      "capacity_mb": 32768,
      "vmx_paths": ["C:/VMs/lab-a/lab-a.vmx"],
      "confirm": true
    }
  }]
}
```

This does not resize guest filesystems. Supply relevant unregistered VMX files
in `vmx_paths` so references are checked. For an authorized graceful shutdown
of two existing VMs, submit sequential steps in one job:

```json
{
  "confirm": true,
  "steps": [
    {"operation": "vm_power", "arguments": {"vmx": "C:/VMs/app/app.vmx", "action": "stop", "mode": "soft"}},
    {"operation": "vm_power", "arguments": {"vmx": "C:/VMs/db/db.vmx", "action": "stop", "mode": "soft"}}
  ]
}
```

Steps stop on the first error/cancellation. Inspect
`partial_result.completed_steps` for completed actions. All inputs must exist
at submission; no implicit dependency on a previous step's new output is
supported. Submit independent jobs for concurrency. Starts are headless and
soft actions never fall back to hard mode. Use `mode: "hard"` only when that
exact action is authorized. Start/stop/suspend check subsequent running
inventory; pause/unpause/reset report native exit status separately because
the running list cannot verify those transitions.

## Inspect, cancel and recover

- `job_list {}` lists retained jobs.
- `job_status {"job_id":"<returned ID>"}` reports state, progress, result/error,
  completed steps and artifact paths.
- `job_logs {"job_id":"<returned ID>"}` reads bounded redacted output and
  step messages. Incomplete native lines wait for completion.
- `job_cancel {"job_id":"<returned ID>"}` requests cancellation. Poll until
  terminal; the cancellation reply alone does not prove process exit.

Terminal states are `succeeded`, `failed`, `cancelled`, `timed_out` and
`interrupted`. Windows cancels native process trees with hidden `taskkill /T`;
Linux uses a dedicated process group and TERM/KILL escalation. Reservations
remain held through native cleanup and final journal writes. In-place edits,
clones and OVF staging can leave partial artifacts. Inspect reported paths and
VM state before retrying. Cancellation is not rollback; never retry or delete
partial files automatically.

Private journals persist IDs, timestamps, state, progress, redacted logs/results
and artifact metadata. They omit executable arguments, credential values and
raw OVF property defaults. Mutations start only after a durable admission
record. Restart retains completed results and reports unfinished jobs as
`interrupted` with unknown outcome. It never replays jobs or kills a PID
recovered from disk. An orphaned process or another server session may remain
active. Unknown/expired prior-session IDs also report unknown outcome.

| Host | Default journal directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%/vmware-workstation-mcp/jobs` |
| Linux | `$XDG_STATE_HOME/vmware-workstation-mcp/jobs`, or `~/.local/state/vmware-workstation-mcp/jobs` |

`VMWARE_JOB_DIRECTORY` selects an absolute private directory. Linux requires
an owned directory with mode 700 and regular owned files with mode 600. Windows
uses current-user-only ACLs. Unsafe or invalid journals fail closed for inspection.

## Bounds and coordination

Each server allows four active jobs, at most 16 sequential steps, a total
timeout of at most 24 hours and per-step timeouts of at most one hour.
Conflicts/capacity limits fail promptly. Canonical VM/source/output locks are
shared with synchronous disk operations, VMX edits, vmrun mutations and local
REST VM mutations. Unrelated VM commands use separate queues. Reservations
cover this server; other server instances, VMware processes and remote REST
origins require separate coordination.

History retains at most 100 records for seven days, pruning on job-tool use.
Each journal is at most 256 KiB, logs at most 64 KiB, result/partial-result
payloads at most 64 KiB each, native process output at most 1 MiB and artifact
metadata at most 64 paths. Overflow is marked or fails the job. Up to four
interrupted temporary journals are tolerated before writes fail closed.
The journal stores metadata only. User-selected VM/appliance outputs remain
subject to free-space checks, are retained for inspection and are never copied
into history or automatically deleted by retention.

## Validation

Default tests use native subprocesses and temporary VMware test doubles. They
cover concurrency, shared locks, process-tree cancellation, startup failure,
timeouts, killed processes, bounds, private journal redaction/retention, bundled
MCP disk/clone/power batches and abrupt server restart. CI runs on Windows and
Ubuntu without a hypervisor.

`npm run test:jobs:live` requires separate disposable-workload authorization and
`VMWARE_JOBS_LIVE=1`. It creates two new powered-off blank VMs under `test-vms/`,
converts their disks concurrently, expands one and full-clones the other. It
does not start or mutate existing VMs and retains artifacts. Default tests do
not run it. No live VMware result for these job workflows is claimed here.
