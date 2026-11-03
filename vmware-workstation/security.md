# Security inspection and the headless provisioning limit

Version 0.15.0 adds **read-only inspection**, the feasibility slice of
[issue #27](https://github.com/mdaneri/vmware-workstation-mcp/issues/27), following
[typed hardware #8](https://github.com/mdaneri/vmware-workstation-mcp/issues/8)
and [tracker #6](https://github.com/mdaneri/vmware-workstation-mcp/issues/6).
Encryption enablement and vTPM provisioning/persistence are **not implemented**.
No native platform, release or encryption mode is advertised as supported for
those operations. Discovery alone does not complete #27.

## Inspect before planning

Ask: “Check whether this host has a verified headless encryption backend.”

```json
{ "tool": "vm_security_capabilities", "arguments": {} }
```

This checks native worker metadata/version and optional `vmcli --help` and
`vmcli --version`. It does not select a VM, open credentials, launch the desktop
UI, or execute a mutation. `vmcli.discovered` and `help_verified` describe tool
discovery; `backend.available:false` and an empty `supported_encryption_modes`
are the provisioning decision. A discovered binary never enables provisioning.
An unrecognized product reports unknown product/build, without guessing support.
Set `VMWARE_VMCLI_PATH` to an absolute `vmcli.exe` (Windows) or `vmcli` (Linux)
if automatic discovery beside vmrun, in standard locations, or on PATH fails.

Ask: “Inspect the security declarations of C:/VMs/example/example.vmx.”

```json
{
  "tool": "vm_security_status",
  "arguments": { "vmx": "C:/VMs/example/example.vmx" }
}
```

On Linux use an absolute native path such as `/srv/vms/example/example.vmx`.
VM paths are canonicalized and checked against `VMWARE_ALLOWED_ROOTS`.
This reads selected declarations only, without running a native command or
unlocking the VM. It returns no passwords, encryption fields, TPM certificates
or contents, MAC addresses, disk paths, arbitrary VMX values or guest output.
Neither tool accepts credential profiles, plaintext credentials or native options.

`encryption.state` and `encryption.mode` remain `unknown` because VMX markers
cannot independently prove encryption or its extent. A marker boolean reports
only their presence. `vtpm.declared_present` is true, false or null;
`vtpm.presence` remains `unknown` until independent VMware inspection proves it.
Missing keys do not prove absence, particularly when encrypted configuration
hides devices. `inspection:unknown` covers malformed, duplicate, non-UTF8,
oversized, unreadable or detectably changing configuration. Power-off, other
writers, complete recovery and product compatibility are not verified by this
declaration reader. It cannot authorize a subsequent mutation.

## Feasibility evidence, checked 2026-11-03

[Broadcom's engineering response in the VMware Packer repository](https://github.com/vmware/packer-plugin-vmware/issues/244)
states that partial/full encryption creation is available only through the
product UI and that programmatic support needs a future product entry point.
The issue also distinguishes `vmrun -vp` authentication from encryption creation.
[A Broadcom employee's vmcli response](https://community.broadcom.com/vmware-cloud-foundation/discussion/vmcli-add-encryption-for-enabling-tpm)
confirms that vmcli cannot create encrypted VM disks or add a vTPM.
These are dated engineering statements, not a guarantee about future releases.

Read-only native Windows probes on Workstation **26.0.1 build 25688693** found:

| Exact invocation (no target or credentials) | Observation |
| --- | --- |
| `vmcli.exe --version` | `0.1.25688693` |
| `vmcli.exe --help` | No encryption or TPM module advertised |
| `vmcli.exe VM --help` | VM creation advertised; no encryption/provisioning operation |
| `vmcli.exe VM Create --help` | No encryption or TPM option advertised |
| `vmcli.exe Disk --help` | Disk operations advertised; no encryption operation |
| `vmcli.exe Disk Create --help` | No encryption option advertised |
| `vmcli.exe Chipset --help` | CPU/memory query/set operations; no TPM provisioning |
| `vmrun.exe` | `1.17.0.25688693`; `-vp` authentication, no encryption creation command |
| `vmware-vdiskmanager.exe` | Build 25688693; no encryption creation operation advertised |
| `dictTool.exe --help` | Generic dictionary print/query/add/set/remove; no semantic TPM/encryption provisioning |

The combined engineering guidance and installed help establish **no verified
usable backend**, rather than proof that no future/private API can exist.
`dictTool`, arbitrary ConfigParams and raw VMX flags are not provisioning
backends. No crypto formats or TPM mutation keys are guessed or reverse engineered.
The existing REST catalog also has no typed encryption/vTPM provisioning endpoint;
generic configuration setters do not establish one.

Reproduce the safe runtime discovery with `npm run security:probe`. Full help
checks above are developer feasibility evidence; runtime discovery intentionally
returns only bounded parsed facts and never native output/errors.

| Platform/version | Read-only inspection | Encryption modes / vTPM provisioning |
| --- | --- | --- |
| Native Windows 26.0.1 / 25688693 | Native help/version discovery exercised; VM declarations tested with fixtures | Unsupported: no verified backend; no live provisioning or guest test |
| Native Windows other versions | Runtime discovery; unknown products stay unknown | Unsupported/unverified |
| Native Linux, all versions | Automated fixtures/MCP contracts run in Ubuntu CI; native hypervisor probes pending | Unsupported/unverified; no native VMware validation |
| WSL | Development doubles only | Not native Linux hypervisor evidence |

## Credentials and staged provisioning

Existing `vm_password_profile` resolves a protected local encryption password
for supported vmrun operations on an **already encrypted** VM. Configure it
interactively through `scripts/Set-Credentials.ps1`; see the
[credential guide](README.md#configure-credentials-locally). Never paste passwords into chat.
The native `vmrun -vp` mechanism passes that password in process arguments,
which may be visible to host process observers. This feature introduces no
credential transport and does not use that mechanism for provisioning.

A new blank VM can still be planned/created through existing hardware/template
tools. A security inspection is a separate read-only step. **There is currently
no supported next encryption/provisioning call**. `create_vm` and
`vm_hardware_set` continue to refuse vTPM mutation; encrypted/managed VM raw
editing restrictions remain in place. Do not stage an implicit power-on,
experimental auto-add flag, UI automation, disk conversion, clone or OVF
workaround to bypass the backend refusal.

## Recovery and remaining acceptance work

Password rotation, decryption, TPM removal/reset, encrypted portability and
general encrypted-VM editing remain unsupported. Existing TPM state must be
preserved. TPM removal/replacement/reset can make guest-bound keys such as
BitLocker recovery-dependent; this plugin does not perform those actions.

A VMX-only backup is **not** sufficient recovery for encryption/TPM changes.
Future mutation support requires a verified protected complete VM recovery set,
including disks, firmware/TPM state and any snapshot dependencies, plus separately
retained credentials and an exercised restore procedure. No backup or rollback
is claimed by these tools, and no partial artifacts are deleted or retried.

Before #27 can be completed, obtain a supported native backend with documented
version/platform/mode prerequisites, protected credential transport and an
independent VMware security inspection path. Then implement compatibility,
offline/lock/writer, snapshot/clone/shared/external-disk and managed-VM refusal
checks; verified complete backups and repeated preflight; bounded jobs with
honest partial/timeout/cancel/restart outcomes; and staged new-VM integration.
Separately authorized disposable native tests must enable the verified mode,
provision TPM 2.0, verify it independently, boot a guest and prove TPM identity
persists across stop/start. No such workload was authorized or run for this
inspection delivery. Native Linux needs its own evidence; Windows or doubles
cannot establish it.

Default tests use generated fake secrets and assert that selected declarations,
probe failures, MCP responses and stderr expose none of their values. Existing
148 tool definitions are checked unchanged against a pre-security baseline.
No security mutation jobs, credential files or recovery artifacts are created.

On 2026-11-03 with Node 22.14.0, Windows validation passed 273 tests (9
Linux-only skips); an isolated Ubuntu 24.04 WSL source copy passed 280 tests
(4 platform-specific skips). Build, manifest/schema validation, platform
credential protection checks and the 36-entry package round trip passed on
both. The bundled MCP capability tool also exercised native Windows 26.0.1
discovery and returned an unavailable provisioning backend. Rebuilding the
Windows package files reproduced them exactly. These results establish runtime
and test-double behavior, not native Linux VMware or guest TPM validation.
