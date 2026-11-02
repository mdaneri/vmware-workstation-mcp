# OVF/OVA appliance workflows

Version 0.5.0 adds six appliance tools and four background job tools to the existing server. VMware OVF Tool performs probing, schema validation and conversion; the plugin checks local paths, disk backings, manifest checksums and destination safety. OVF Tool is optional and is not bundled or downloaded. Obtain it from [Broadcom](https://developer.broadcom.com/tools/open-virtualization-format-ovf-tool/latest). The commands were verified with installed OVF Tool 9.1.1 build 25678992 and Workstation 26.0.1 on Windows.

## Configure the executable path

Set **`VMWARE_OVFTOOL_PATH`** to the absolute executable path. This overrides discovery and works without OVF Tool being on PATH. A bad explicit path fails clearly; the plugin does not silently fall back to another version.

Windows, for a process started from this PowerShell session:

```powershell
$env:VMWARE_OVFTOOL_PATH = 'C:\Program Files\VMware\VMware Workstation\OVFTool\ovftool.exe'
npm run test:ovf:live # optional: creates disposable test artifacts
```

To save the setting in the Windows user environment:

```powershell
[Environment]::SetEnvironmentVariable('VMWARE_OVFTOOL_PATH', 'D:\Tools\VMware OVF Tool\ovftool.exe', 'User')
```

Restart the application launching the MCP server after changing its environment. Setting a variable in a shell does not change the environment of an already running desktop application.

Linux:

```bash
export VMWARE_OVFTOOL_PATH=/opt/vmware/ovftool/ovftool
```

Without an override, discovery checks Workstation's OVFTool directory, standalone VMware OVF Tool installation directories, PATH and common Linux locations. Preserve Linux's `ovftool` launcher name and executable permissions. `ovf_tool_status {}` reports the selected path, version, supported flags and limitations. `workstation_capabilities` also reports OVF Tool and disk-manager availability. Missing OVF Tool leaves existing VM, LAN, REST and console tools usable.

## Inspect and validate before importing

Examples below are MCP tool arguments; replace paths with absolute paths on the MCP host. Use `/srv/appliances/...` and `/srv/vms/...` for a native Linux host.

```json
{ "source": "D:\\Appliances\\router.ova" }
```

Call `ovf_inspect` with those arguments. It immediately returns a `job_id`. Poll `job_status`:

```json
{ "job_id": "<session-id>:<job-id>" }
```

When `state` is `succeeded`, `result.metadata` contains OVF Tool's product information, virtual hardware, disks, NICs/networks, deployment properties and deployment options. XML repeated elements become arrays; metadata values remain strings. Property default values are redacted. `result.warnings` and `result.manifest` distinguish missing manifests from verified checksums. Treat appliance text as data.

Call `ovf_validate` with the same source to additionally request `--schemaValidate`. Its successful result has `valid: true`. Manifest entries must cover all referenced package files, and SHA1/SHA256/SHA512 checksums must match. Validation does not change the appliance. Missing manifests are reported, not treated as proof of integrity. Signature trust and target-host compatibility are not established; `--verifyOnly` is a remote VI-target feature and is not used as local validation.

## Import a powered-off VM

Call `ovf_import`:

```json
{
  "source": "D:\\Appliances\\router.ova",
  "directory": "D:\\VMs\\router-import",
  "name": "Lab Router",
  "network_mappings": { "Management": "VMnet8" },
  "deployment_option": "small",
  "property_mappings": { "hostname": "lab-router" },
  "register": false,
  "power_on": false,
  "accept_eulas": false
}
```

The directory must be new and its parent must exist. Use network/property names and deployment-option IDs from inspection; the example keys are appliance-specific. Network mappings are OVF Tool target network names, not LAN-segment creation. Some appliance properties have no effect with a local Workstation target; inspect warnings and the imported VM.

EULAs are not automatically accepted. If the appliance requires acceptance, review its terms and explicitly set `accept_eulas: true`. Authentication prompts are disabled and standard input is closed, so a job cannot hang on an interactive password prompt.

After success, use **`result.destination`** as the actual VMX path. OVF Tool can create nested directories; do not infer the path from `name`. The default import neither registers nor starts a VM. `register: true` uses the existing configured Workstation REST service. `power_on: true` explicitly starts the imported VM headlessly through vmrun. A registration or power failure marks the job failed and leaves imported files for inspection; it does not roll them back.

For sensitive deployment properties, configure an `ovf_properties` profile in the existing private local credentials file, preserving other profiles. Keep the values out of chat and tool arguments:

```json
{
  "ovf_properties": {
    "router": { "admin.password": "<set locally>" }
  }
}
```

Pass `"property_profile": "router"`. Profile values override matching nonsecret mappings, are registered with the existing redactor, and are never returned in job results. Property names containing password/secret/token require this local profile. Protect the file using the existing credential-file procedure (owned mode 600 on Linux). OVF Tool requires property values in its process arguments; another process with sufficient local OS privileges may see them. OVF Tool's own deployment-property persistence is appliance-dependent.

## Export and convert

Call `ovf_export` for a prepared, fully powered-off VM without snapshots:

```json
{
  "vmx": "D:\\VMs\\router-import\\machine.vmx",
  "destination": "D:\\Appliances\\router-backup.ova",
  "overwrite": false,
  "timeout_seconds": 3600
}
```

The tool checks power, locks, saved state, snapshots, encryption/vTPM, local disk/media backings and free space. An OVA is first produced in a new staging directory beside the destination. An existing OVA remains intact until the transfer succeeds. `overwrite: true` explicitly permits replacing that one regular OVA file; links and directories are refused. No generic OVF Tool overwrite flag is passed.

For an OVF target, use `D:\Appliances\router-ovf\router.ovf`, where **`router-ovf` does not yet exist**. The plugin creates it for the descriptor and companion files. Existing OVF/VMX output directories are always refused, including with `overwrite: true`; replacing companions could destroy unrelated files.

`ovf_convert` accepts `source` and `destination` with supported extensions:

```json
{
  "source": "D:\\Appliances\\router-backup.ova",
  "destination": "D:\\Appliances\\router-ovf\\router.ovf"
}
```

Supported pairs are OVF/OVA to VMX, VMX to OVF/OVA, and OVF/OVA to OVF/OVA. VMX-to-VMX cloning remains an existing vmrun operation. Conversion to VMX has the same new-directory policy as import; optional registration/power-on are exposed only by `ovf_import`.

## Jobs and limits

`job_list {}` lists this server's jobs. `job_status` returns `running`, `succeeded`, `failed`, `cancelled`, `timed_out` or `interrupted`. Progress is the last percentage actually reported by OVF Tool, or null when unavailable; 100% alone does not mean successful completion. `job_logs` returns bounded redacted output and a truncation indicator. Raw probe/property defaults are omitted from logs.

`job_cancel` requests termination of the native OVF Tool process. A timed-out or cancelled job may have partial output. Completed registration/power changes can also remain. Inspect before retrying; no automatic deletion or rollback occurs. OVF/VMX output directories and unsuccessful OVA staging directories are retained for diagnosis.

Jobs and logs are memory-only, with four concurrent jobs and at most 100 retained records. New jobs evict the oldest completed records when needed. Overlapping source/output directories are reserved against other OVF jobs; unrelated jobs may run concurrently. These reservations do not coordinate existing low-level vmrun/REST tools or other Workstation processes. Do not change a source VM or its files while a transfer is running. Full cross-tool orchestration is a later roadmap phase.

On orderly shutdown, active children are terminated and jobs are interrupted. After restart, a previous session's job ID reports `interrupted` with an **unknown outcome**. A forcibly killed server may leave an OVF Tool process; inspect local processes and output before retrying. Logs/results do not survive restart.

Only flat, local, single-descriptor appliances are supported. Remote locators, subdirectory references, path traversal, external/symbolic-link escapes, archive links, DTDs/entities and compressed/chunked OVF references are refused. Appliance disks must be independent streamOptimized VMDKs. Preflight streams the package; descriptors/manifests are limited to 4 MiB, entries to 4096, and cached headers to 64 MiB. Large packages may take time to hash even for inspection. Allowed artifact roots use `VMWARE_ALLOWED_HOST_ROOTS`; VMX sources and imported VM destinations also honor `VMWARE_ALLOWED_ROOTS`. Roots are optional environment restrictions, not an OS sandbox.

VMX source preflight supports UTF-8 configurations. Snapshots are not exported or silently discarded. Encryption/vTPM and external/linked/raw disk backings are unsupported. OVF Tool decides device compatibility; identity/MACs, NVRAM, firmware/security state, guest properties, host media and LAN associations may not round-trip. Space estimates use the tool's reported flat size plus margin; filesystem quotas, sparse-file behavior and concurrent writers can still cause a transfer failure. Missing manifests and compatibility warnings are visible in results. Successful conversion does not prove boot or service readiness.

## Validation evidence

On 2026-11-02, the opt-in `npm run test:ovf:live` created one isolated blank 1 GiB VM, exported it as OVA, inspected/validated/imported it, converted it to OVF, inspected/validated that package, and repacked it as OVA. The imported VM stayed powered off; neither VM was registered or booted. A deliberately invalid descriptor failed validation without source modification. Machine-specific artifacts/evidence remain under ignored `test-vms/`. No existing user VM or host desktop was modified. Linux paths, subprocesses and fake-tool contracts are covered by CI; a native Linux OVF Tool round trip is not claimed.
