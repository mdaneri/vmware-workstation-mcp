# VMDK lifecycle

Version 0.6.0 adds nine disk tools. They use native `vmware-vdiskmanager`, descriptor inspection and backed-up VMX edits. OVF/OVA appliances continue to use the separate [OVF workflow](ovf.md).

## Discover support

Call `disk_manager_status {}` first. It reports the executable, version, exact case-sensitive flags, advertised disk types and supported operations. `-R` is repair and never substitutes for conversion `-r`. No repair, raw-device, mount, deletion or arbitrary flag passthrough is provided.

Set `VMWARE_VDISKMANAGER_PATH` to the absolute `vmware-vdiskmanager.exe` (Windows) or executable `vmware-vdiskmanager` launcher (native Linux), or let discovery check beside vmrun, the Workstation installation and PATH. Linux launchers retain their original name. An invalid explicit override fails without silently choosing another binary. Restart the application launching the MCP process after changing its environment.

All disk files and extents honor `VMWARE_ALLOWED_HOST_ROOTS`; VMX files honor `VMWARE_ALLOWED_ROOTS`. Set both for a restricted deployment. Paths must be absolute and use host-native syntax. The examples use Windows paths; on Linux use paths such as `/srv/vms/data/disk.vmdk`.

## Create and inspect a disk

Call `disk_create` with a **new parent directory**, whose parent already exists:

```json
{ "destination": "D:\\VMs\\extra-data\\data.vmdk", "capacity_mb": 1024, "disk_type": "0", "adapter": "lsilogic" }
```

Disk types are strings: `0` single growable, `1` split growable, `2` single preallocated, `3` split preallocated. They must also be advertised by the installed executable. Creation and conversion never overwrite files. Reserving the entire new directory protects generated `-flat` and split extents too. Preallocated disks and conservative temporary-space estimates may need substantial free space. Capacity is in MiB; BusLogic is limited to 2040 GiB.

Call `disk_inspect`:

```json
{ "disk": "D:\\VMs\\extra-data\\data.vmdk" }
```

It reads the declared descriptor (including the embedded sparse descriptor), virtual capacity, adapter, CID, parent CID, extent files and independence. Choose the descriptor VMDK, not a `-flat` or numbered extent. Inspection supports the four local types and stream-optimized descriptors, without invoking native repair. It does not verify disk-chain consistency or filesystem integrity. Raw, encrypted, malformed and external-extent descriptors are refused.

## Expand, compact or defragment

Obtain authorization for the exact disk change. Fully power off and close every VM using it. Include any unregistered VMX files in `vmx_paths`, and confirm that no other process or host uses the disk. Call `disk_expand`:

```json
{ "disk": "D:\\VMs\\extra-data\\data.vmdk", "capacity_mb": 2048, "vmx_paths": ["D:\\VMs\\lab\\machine.vmx"], "confirm": true }
```

`capacity_mb` is the new **total** capacity, not an increment. Decreasing capacity is refused. Increasing VMDK capacity does **not** resize guest partitions or filesystems; extend them separately using the guest OS's supported tools after booting.

`disk_compact` and `disk_defragment` accept `disk`, `vmx_paths` and `confirm: true`. Both require an independent growable local disk and their exact installed flag. Compact can reclaim prepared free space; it does not reduce virtual capacity. Guest free-space preparation is a separate authorized operation. All native disk tools accept `timeout_seconds` (default 600, maximum 3600) and return synchronously; configure the MCP client's call timeout accordingly.

Preflight checks registered/running VMs, explicitly supplied VMX files and VMX files beside the disk. A readable inventory is required. Missing/stale inventory entries are skipped only when their VMX does not exist. Unreadable, malformed or out-of-root existing entries block the operation. Checks refuse running, locked, suspended, encrypted/vTPM or snapshot-bearing VMs, hard-linked disk files, multiple device references, shared extents and parent/linked chains. Child descriptors beside the source are checked as well. Stream-optimized source disks are refused for mutation and attachment; use a separately prepared Workstation disk.

Inventory cannot discover every unregistered VM or a child chain stored elsewhere. `confirm: true` explicitly confirms authorization and exclusive access outside the checked set. Close Workstation tabs and other writers. No tool automatically powers off VMs, removes snapshots or deletes saved state to make an operation proceed.

## Convert while preserving the original

Call `disk_convert` with a new output directory:

```json
{ "disk": "D:\\VMs\\extra-data\\data.vmdk", "destination": "D:\\VMs\\converted-data\\data.vmdk", "disk_type": "1", "confirm": true }
```

Conversion supports installed types `0`–`3` and streaming output type `5`. The source must be an independent offline Workstation disk; ESX types `4`/`6` are outside this local workflow. The original is preserved and remains attached wherever it was before conversion. Conversion does not switch any VMX backing. Inspect the result, then detach/attach explicitly if requested.

## Attach or detach an explicit device

Use an existing controller. Controller creation and hardware tuning remain separate configuration work. Call `disk_attach`:

```json
{ "vmx": "D:\\VMs\\lab\\machine.vmx", "disk": "D:\\VMs\\extra-data\\data.vmdk", "controller": "scsi", "controller_index": 0, "unit": 1, "confirm": true }
```

This selects `scsi0:1`; indices are zero-based. SCSI controllers use units 0–15 excluding reserved unit 7, SATA 0–29, IDE 0–1 with controller indices 0–1, and NVMe 0–14. Other controller indices range from 0–3. SCSI requires a known configured controller type; SATA/NVMe require `present=TRUE`. IDE is implicit. Disk adapter metadata must match: `ide` for IDE, `buslogic` for BusLogic SCSI, and `lsilogic` for other supported controllers (as disk-manager help directs). Occupied or stale slot settings are refused. A disk referenced by any other known device cannot be attached again.

Call `disk_detach` with the same arguments. It verifies the **expected disk** at that exact slot, removes the slot's VMX settings, and preserves all VMDK and extent files. Both changes use the existing UTF-8 VMX backup/protection mechanism and return the backup path. Detach never deletes disks or removes the controller. Restore only after inspecting current VM state and the backup.

## Conflicts and failures

Disk operations reserve canonical disk directories, related VMX paths and new output directories within this server. Conflicting disk calls, VMX edits, vmrun mutations, loopback REST VM mutations and OVF jobs fail with a busy error; unrelated VM operations can proceed. Local REST mutations resolve the VM ID through inventory before reserving its VMX; remote REST origins retain their existing behavior and are outside local reservations. This is not a system-wide lock, and another server or VMware process can still modify files. State is rechecked immediately before native execution and VMX commits.

Errors have a JSON `code`, `message` and actionable detail. Missing/unsupported executable features report `CAPABILITY_UNAVAILABLE` or `UNSUPPORTED_CAPABILITY`. Native output is not echoed into disk-operation errors. Failed or timed-out conversions retain the new directory and report `partial_output`; inspect it before retrying. Only after confirming that directory contains disposable output should you remove it. In-place operations can partially change the original and have no automatic rollback. Never delete an original disk as cleanup.

## Validation

`npm test` exercises native argument contracts and failure/safety paths with temporary fixture disks on Windows and Linux CI. `npm run package` verifies all 117 schemas, all 108 previous definitions, generated reference and required archive entries.

`npm run test:disk:live` is opt-in and requires authorization for disposable VM/disk creation and mutation. It creates an isolated powered-off VM and disks under ignored `test-vms/`, tests create/inspect/expand/convert/attach/detach and supported compact/defragment, and retains evidence plus artifacts. Its isolated inventory/roots deliberately exclude existing VMs; it never boots, registers or deletes a VM. Mock tests and WSL runs do not establish native Linux VMware behavior. A live result applies only to the host/build on which that script actually passed.
