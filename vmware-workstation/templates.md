# Declarative VM templates

Version 0.13.0 adds four tools for reusable **blank hardware recipes**, using the
same typed hardware, disk creation, path allowlists and session resource locks as
`create_vm`. Existing tool definitions are unchanged. See [issue #11](https://github.com/mdaneri/vmware-workstation-mcp/issues/11)
and [tracker #6](https://github.com/mdaneri/vmware-workstation-mcp/issues/6).

## Choose a recipe and review its plan

Call `template_list` with `{}`. It returns complete editable templates:

| ID | Recipe | Local network bindings required |
| --- | --- | --- |
| `linux` | EFI, 2 vCPUs, 2 GiB RAM, 20 GiB SCSI disk | `primary` |
| `windows` | Windows Server 2019 hardware, EFI/Secure Boot, 4 vCPUs, 8 GiB RAM, 64 GiB disk | `primary` |
| `nested-esxi` | ESXi 8 hardware, nested virtualization, 4 vCPUs, 16 GiB RAM, two SCSI controllers/disks | `management`, `lab` |

These are hardware examples, not proven guest installation profiles. The Windows
example does not provision vTPM or satisfy every Windows edition's requirements.
Nested ESXi still requires host CPU/hypervisor support and suitable installation
media. Guest OS identifiers are declared values; installation/driver support is
not established by schema validation. Hardware version 21 requires a compatible
installed Workstation profile; inspect `vm_hardware_capabilities` first and choose
a supported version explicitly.

For a standard Linux VM on Windows, call `template_validate` with:

```json
{
  "template": "linux",
  "directory": "C:\\VMs\\linux-lab",
  "networks": { "primary": { "network": "nat" } }
}
```

On native Linux use an existing parent, for example
`"directory": "/home/alice/vms/linux-lab"`. Both `VMWARE_ALLOWED_ROOTS` (VMs) and
`VMWARE_ALLOWED_HOST_ROOTS` (host files) apply. The destination must not exist,
even as an empty directory. Its parent must already exist. Symlinks are resolved
before checking roots; dangling links are rejected.

The result includes `valid`, `dry_run` and a `plan` with the canonical directory,
VMX filename and complete generated `vmx_text`, each disk's path/capacity/slot,
vCPU/RAM requirements, conservative free-space requirement, installed capability
summary, requested changes and limitations. Validation queries only native
version/help and local files/free space; it creates no directory, VMX, disk or
registration. Insufficient free space fails before mutation: the conservative
estimate reserves full virtual capacity plus 10 percent and 64 MiB, even for
sparse disks.

## Deploy explicitly

`template_deploy` with the same arguments defaults to `dry_run:true`. After
reviewing the destination and intended effects, make a real deployment:

```json
{
  "template": "linux",
  "directory": "C:\\VMs\\linux-lab",
  "networks": { "primary": { "network": "nat" } },
  "dry_run": false,
  "confirm": true
}
```

It repeats preflight, creates independent type-0 sparse disks in separate
`disk-N/` directories, and writes `machine.vmx` exclusively. It does not copy an
OS, source disk contents, UUIDs, MAC addresses or credentials. Inspect the returned
VMX with `vm_hardware_get`, `get_vm_details` and `disk_inspect`.

`register:false` and `power_on:false` are defaults. Enable either only when the
user requested that action. Registration first checks authenticated REST with
a read-only inventory request, then POSTs only the new VM. Power-on uses vmrun
headlessly. Registration and power are independent; a successful power call does
not prove guest readiness. A dry-run with `register:true` also performs the
read-only REST prerequisite check, never registration.

Plans reserve nothing and are snapshots of current host configuration. Deploy
revalidates against the current host; review again if capabilities, bindings or
files change. Locks coordinate this server only. Keep other configuration
writers closed. Deployment is synchronous; allow a client timeout long enough
for every disk (`timeout_seconds`, default 600, applies per disk and registration).
Cancellation is checked before creation and before post-actions; it does not
interrupt an already running synchronous disk creation or roll back files.
Long-running template jobs are not implemented.

If disk/VMX creation fails, partial files remain in the NEW directory with its
path in the error. If registration/power fails, `POST_DEPLOY_FAILED` includes
the VMX, failed stage, and separately confirmed `registered`/`poweredOn` values.
The failed action's outcome may be unknown. Inspect inventory and VM state before
any retry; no cleanup, overwrite, automatic retry or rollback is performed.

## Portable schema and local bindings

[schema-v1.json](templates/schema-v1.json) is a generated JSON Schema 2020-12
document matching the runtime schema. Version `schema_version:"1.0"` is required;
unknown fields/versions are rejected. YAML and arbitrary VMX passthrough are not
supported. Templates are JSON objects supplied directly, or the three bundled IDs;
the server never scans host template directories or implicitly reads a JSON path.
Save custom JSON using your own editor and pass its object to the tools.

The complete [Linux](templates/linux.json), [Windows Server](templates/windows.json)
and [nested ESXi](templates/nested-esxi.json) examples document every field:
identity (`id`, portable display `name`), `guest_os`, `hardware_version`, `cpu`,
`memory_mb`, `firmware`, `security`, explicit `controllers`, blank `disks`, `nics`
and `boot`. CPU cores must evenly divide vCPUs. Controller/slot/NIC indices must
be unique; SCSI unit 7 is reserved. No raw settings, static MAC, absolute file
paths, console endpoints or credential fields are accepted in a template.
As with any user-authored document, do not put secret text in identity fields.

NIC `network` is a logical name. Bind every used name exactly once in the call's
`networks` object. Bindings support `nat`, `bridged`, `hostonly`,
`custom` with explicit `vmnet`, or `lan_segment` with an unambiguous existing
segment name/ID. Extra bindings are rejected. VMnet syntax is checked; live
VMnet/bridge/DHCP/connectivity availability is not proven. LAN segments are looked
up in the existing catalog and never implicitly created; close the VMware GUI
for LAN-backed creation. For the nested ESXi example:

```json
{
  "template": "nested-esxi",
  "directory": "/home/alice/vms/esxi-lab",
  "networks": {
    "management": { "network": "nat" },
    "lab": { "network": "lan_segment", "segment": "isolated-lab" }
  }
}
```

For ISO installation, take the full template from `template_list`, change
`boot` to `{"mode":"iso","media":"installer"}` and pass it as `template`.
Add `"media":{"installer":"/home/alice/iso/installer.iso"}` alongside it
(on Windows, use an absolute local ISO path). The ISO must exist inside allowed
host roots and have a canonical `.iso` extension. A free SATA slot is selected
without replacing a disk. Media paths are local bindings and are not saved in the
portable recipe. `boot.mode:"default"` leaves VMware's default boot behavior.
ISO attachment does not force first/next-boot order. `boot.mode:"pxe"` fails with
`UNSUPPORTED_CAPABILITY`: no installed-version-verified boot-order backend exists.
A default-boot NIC may use an independently configured PXE network, with firmware
interaction through direct RFB when explicitly requested. No boot keys are guessed.
`security.vtpm:true` also fails explicitly because encryption/key management is
unavailable; it is never silently disabled.

## Export and reuse an existing layout

Fully power off and close the source VM, then call:

```json
{"vmx":"C:\\VMs\\source\\machine.vmx","id":"my-linux","name":"Reusable Linux"}
```

Use these arguments with `template_export`. The tool returns a `template` object
and `required_bindings`. It reads only typed hardware and independent disk
capacities; it never saves a file, copies a disk or copies arbitrary VMX fields.
The caller supplies the new identity. Existing UUIDs/MACs, host paths, network
identity, credentials, serial/console configuration and boot order are omitted.
NIC bindings become `network0`, `network1`, etc.; ISO media becomes `installer`.
Rebind these explicitly, validate at a NEW destination, and deploy as above.

This is a lossy blank recipe, not a backup or clone. Unrelated devices/settings
are omitted as listed in the response. Malformed, encrypted, running, locked or
suspended sources are refused; unrepresentable active storage, linked/snapshot
backings, unsupported controllers or more than one ISO fail. Export leaves source
files unchanged. Use the separate clone or OVF workflow to preserve contents.

## Validation

Default tests exercise Windows/Linux capability profiles with mocked native
processes and temporary files, schema/semantic failures, absence of dry-run writes,
VMX/plan agreement, portable sanitized export/redeployment, authorization and
post-action failures. The bundled MCP integration verifies all 138 prior tool
definitions unchanged and the complete four-tool workflow. CI runs regression
tests and package/schema validation on Windows and Ubuntu without VMware.

The opt-in `npm run test:templates:live` requires separate disposable-workload
authorization and `VMWARE_TEMPLATES_LIVE=1` on native Windows/Linux. It creates two
NEW powered-off VMs with small disks under ignored `test-vms/templates-live-*`,
checks planning/deployment/inspection/export/redeployment and the unchanged
globally running VM set, then retains files/evidence. It does not register or
boot VMs, touch existing VMs, install an OS or prove nested virtualization.
This harness has not been run as part of the implementation; native VMware
Windows/Linux template deployment and guest behavior remain unverified.
