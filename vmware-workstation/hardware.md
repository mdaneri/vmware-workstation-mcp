# Typed virtual hardware

Version 0.11.0 adds `vm_hardware_capabilities`, `vm_hardware_get` and
`vm_hardware_set`, plus optional typed fields on `create_vm`. All previous
creation arguments/defaults remain accepted; omitting every typed field runs
the original one-disk, E1000 creation path. `configure_vm` is unchanged.

## Inspect first

```json
{}
```

Pass this to `vm_hardware_capabilities`. It verifies the installed native
**product** version, rather than mistaking vmrun's 1.17 API version for
Workstation's version. Windows reads the worker's PE version metadata with a
fixed PowerShell helper; Linux invokes `vmware-vmx -v` without a shell. No
desktop UI is launched. An optional absolute `VMWARE_VMX_PATH` points to the
native worker. It defaults to discovery beside vmrun (including Windows x64)
or native Linux installation directories.

The conservative profile supports Workstation 17.0–17.4 through hardware 20,
17.5–17.6 through hardware 21, and 25.0/26.0 through hardware 22. Typed changes
require declared hardware 14 or newer, up to 32 vCPUs and 128 GiB memory.
Unknown product versions and unsupported combinations fail explicitly before
writing. These are configuration limits, not a claim that the host can run
that much memory or expose nested virtualization. Read the
[Broadcom hardware-version table](https://knowledge.broadcom.com/external/article?legacyId=1003746)
and [Workstation 17.5 announcement](https://blogs.vmware.com/cloud-foundation/2023/10/19/workstation-17-5-pro-and-player-are-now-live/)
for the profile's version mapping.

Read an existing VM with `vm_hardware_get`:

```json
{"vmx":"C:\\VMs\\lab\\machine.vmx"}
```

The result includes declared vCPUs, cores per socket, calculated sockets,
memory, nested virtualization, firmware, Secure Boot/vTPM presence,
controllers, disk slots and NICs. Missing declarations return `null`.
Connection settings are saved configuration, not live link verification.
Unrelated VMX fields and encryption key material are omitted.

## Create a nested ESXi lab

Create an existing isolated LAN segment using `create_lan_segment` (close the
Workstation GUI first). Then pass this to `create_vm`, selecting a **new**
directory whose parent exists. The VM and host-file allowlists must both
permit the destination because it contains new VMDKs.

```json
{
  "directory": "C:\\VMs\\nested-esxi",
  "name": "Nested ESXi",
  "guest_os": "vmkernel8",
  "hardware_version": 21,
  "firmware": "efi",
  "memory_mb": 8192,
  "cpus": 4,
  "cores_per_socket": 2,
  "nested_virtualization": true,
  "secure_boot": false,
  "controllers": [
    {"type":"lsilogic","index":0},
    {"type":"pvscsi","index":1},
    {"type":"nvme","index":0}
  ],
  "disks": [
    {"controller":"scsi","controller_index":0,"unit":0,"capacity_mb":32768},
    {"controller":"scsi","controller_index":1,"unit":0,"capacity_mb":65536},
    {"controller":"nvme","controller_index":0,"unit":0,"capacity_mb":65536}
  ],
  "nics": [
    {"index":0,"model":"vmxnet3","network":"lan_segment","segment":"esxi-isolated"},
    {"index":1,"model":"e1000e","network":"lan_segment","segment":"esxi-isolated"}
  ]
}
```

On Linux use an absolute native path such as `/srv/vms/nested-esxi`; other
arguments are identical. This creates blank independent sparse disks using
the existing disk manager's capability, capacity and path checks. It never
registers or powers on a VM or installs ESXi. Guest driver support, nested
VT-x/AMD-V exposure, host resources and ESXi installation require separate
validation. LAN segments provide neither DHCP nor access to physical networks.

`controllers` accepts LSI Logic/PVSCSI SCSI, SATA and NVMe at indices 0–3.
LSI Logic and PVSCSI share the SCSI index namespace. Disk slots must be unique;
SCSI units 0–15 exclude reserved unit 7, SATA supports 0–29, and this profile
conservatively limits NVMe to 0–14. Every disk must reference a declared
controller. An optional `iso_path` uses an unused SATA0 slot without replacing
a data disk. Each VMDK lives in its own new subdirectory. Partial output is
retained on failure for inspection; nothing is automatically deleted.

`disks` replaces `disk_gb`. `nics` replaces the legacy `network`/`vmnet`
configuration; `nics: []` creates no NICs. When those arrays are omitted,
the legacy disk/NIC defaults apply and need a matching SCSI0 controller.
NIC models are E1000, E1000E and VMXNET3. Networks are `nat`, `bridged`,
`hostonly`, `custom` with an explicit `vmnet`, or `lan_segment` with an
unambiguous existing segment name/pvnID. No VMnets or segments are created
implicitly. NIC indices are zero-based (0–9), independent of REST indices.
`start_connected` controls next boot. Omitted MACs preserve identity on
existing NICs and request generated identity on new ones. An explicit manual
`mac` must be in VMware's `00:50:56:00`–`00:50:56:3f` range; duplicates within
the VM are refused. The caller must ensure uniqueness across the wider lab.

## Change selected hardware safely

After authorizing the exact offline change, fully power off the VM and close
the Workstation/Player GUI. Call `vm_hardware_set`:

```json
{
  "vmx":"C:\\VMs\\lab\\machine.vmx",
  "confirm":true,
  "cpus":8,
  "cores_per_socket":4,
  "memory_mb":16384,
  "nested_virtualization":true,
  "nics":[{"index":0,"network":"custom","vmnet":"vmnet2"}],
  "controllers":[{"type":"sata","index":1}]
}
```

Cores per socket must evenly divide total vCPUs. Omitted fields, attached
devices, unknown VMX keys, UUIDs, generated MACs and PCI identities are
preserved. NIC arrays patch only named indices; an empty array never removes
other NICs. Replacing an existing NIC model or controller type is refused.
Add a new device at an unused index instead. To attach/detach an existing
disk, use the separately confirmed [disk tools](disks.md) after adding its
controller. This API does not replace disks or delete backing files.

Edits back up the original VMX and use the existing optimistic replacement
writer. Power/locks/suspend markers, including external working/snapshot
directories, GUI state, LAN catalog identity and installed worker capabilities
are rechecked before commit. Encrypted, vTPM, managed, malformed, duplicate-key
or hard-linked VMX files are refused. Reservations coordinate this server's
operations; keep other writers closed. A conflict preserves the external
writer's content and requires inspection before retrying.

## Firmware and security limits

`firmware` accepts `bios` or `efi`. `secure_boot: true` requires EFI and the
supported hardware/profile. Turning EFI back to BIOS requires explicitly
disabling an enabled Secure Boot setting. Firmware changes do not convert a
guest's boot loader or partition layout.

`vtpm` is an explicit unsupported-feature request: both true and false fail
with `UNSUPPORTED_CAPABILITY` without edits. The server has no verified
headless encryption/key-management backend, so it never creates guessed TPM
keys, removes an existing TPM or changes encryption. Broadcom describes the
[encryption requirement for vTPM](https://knowledge.broadcom.com/external/article/315650).
Do not bypass this refusal using raw VMX settings. Existing encrypted/vTPM
machines remain inspectable as far as their readable declarations allow.

## Validation

Default regression tests use temporary files, fake native runners and the
bundled MCP process. Both Windows metadata and Linux CLI capability paths are
mocked. Nested ESXi fixtures cover topology, four controller types, multiple
isolated NICs/disks, exact backups, identity preservation, invalid combinations,
allowlists and concurrent-change/state failures. These are not ESXi guest
installation or nested hypervisor execution tests.

`npm run test:hardware:live` is opt-in and requires explicit workload
authorization and `VMWARE_HARDWARE_LIVE=1`. It creates only a NEW disposable,
powered-off VM under ignored `test-vms`, exercises real disk creation and
typed VMX round trips, and retains evidence. It never starts a VM, changes an
existing VM, captures the desktop or sends host input. Native Windows/Linux
Workstation is required; WSL is refused. No live guest/hypervisor hardware
validation is claimed for this release.
