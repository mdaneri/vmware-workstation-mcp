# ISO media for existing VMs

Use these tools to attach installer media, reconnect a disabled optical drive or safely detach an ISO from an existing VM. All tools operate headlessly on Windows and native Linux. No guest agent or host UI is used.

Media edits require a fully powered-off, unlocked UTF-8 VMX and exclusive configuration access. Close the VM's Workstation tab and other configuration writers. Suspended/saved state, directory locks, encryption and hard-linked VMX files are refused. Do not remove locks or state files to bypass these checks. Reservations coordinate with other operations in this server; they do not lock out independent VMware processes or other server instances.

## Attach an installer ISO

1. Obtain the exact VMX path from `list_vms`. Use `iso_list` to inspect existing optical devices. Its connection fields describe saved VMX configuration; they are **not live device state**. Missing connection flags are `null`, rather than guessed defaults. Relative image paths are resolved against the VM directory; listing does not require the old backing file to still exist.
2. With authorization for this media change, fully power off the VM and close its Workstation tab. `iso_mount` never stops or starts it automatically.
3. Mount an existing `.iso` file. Windows example:

```json
{
  "vmx": "C:\\VMs\\installer-test\\machine.vmx",
  "iso_path": "C:\\ISO\\installer.iso",
  "device": "sata0:1",
  "start_connected": true,
  "confirm": true
}
```

Native Linux uses the same tool with host paths such as `/srv/vms/installer-test/machine.vmx` and `/srv/iso/installer.iso`. `VMWARE_ALLOWED_ROOTS` restricts VMX files; `VMWARE_ALLOWED_HOST_ROOTS` separately restricts ISO inputs. Both checks use canonical paths, including symlink/junction resolution. The input must exist and resolve to a `.iso` file; this does not validate ISO contents, bootability or publisher trust. Select media you trust.

`device` is optional. A sole existing optical drive is reused, including a previously disabled drive. Multiple optical drives require an exact selection from `iso_list`. If none exist, the tool allocates an unused slot on an existing SATA controller, then tries IDE. Explicit unused IDE/SATA slots are also accepted. A slot with any non-optical or incomplete settings is occupied, even if `present` is false. No disks or controllers are replaced. Creating an optical device does not create a controller: SATA requires a present controller and virtual hardware version 10 or newer. IDE supports controllers 0–1, units 0–1; SATA supports controllers 0–3, units 0–29. Existing SCSI/NVMe optical devices are inspection-only and fail explicitly on edits.

The result reports `device`, canonical `iso_path` and an exact original VMX `backup`. Unrelated settings and comments are retained. `start_connected` defaults to true; false stages the image while leaving it disconnected for next power-on. Mount enables the selected device and sets its backing to the ISO. With separate authorization to boot the selected VM, call `vm_power` with `action: "start", gui: false`. A successful power-on is not proof that the installer or guest OS is ready.

## Eject without deleting media

After fully powering off the VM, call:

```json
{
  "vmx": "C:\\VMs\\installer-test\\machine.vmx",
  "device": "sata0:1",
  "confirm": true
}
```

Use `iso_eject`, with `device` optional only when there is a sole optical device. Eject disables that optical device, clears its backing filename, and sets connection/start-connected to false. It preserves the controller, other slot settings, unrelated devices and the ISO file itself. A later `iso_mount` re-enables that optical slot. Eject never switches to a host physical drive. The response includes `iso_deleted: false` and a backup path.

This is an offline detach, not a live guest tray-eject command. Both mount and eject refuse running VMs; VMware's graphical hot-swap facilities do not establish an available headless vmrun/REST operation. An error never authorizes a power change, retry, lock removal or GUI fallback.

## Boot capability boundaries

`vm_boot_status` reads the selected VM's firmware and existing `bios.forceSetupOnce`/`bios.bootOrder` values, and attempts to discover the installed vmrun version. Existing values are inspection only. Executable discovery and a version string do not establish that a VMX boot key works on that build or firmware.

`firmware_once_supported`, `boot_order_supported` and `hot_swap_supported` currently return false. `vm_boot_configure` accepts a typed request (`firmware_once` or `boot_order`, plus `vmx` and `confirm:true`) but returns `UNSUPPORTED_CAPABILITY` without writing anything. No verified headless boot backend is implemented. In particular, do not extrapolate ESXi boot settings to Workstation or invent EFI VMX keys. Direct guest RFB input can be used for a separately authorized firmware interaction after console setup, without host desktop automation.

## Validation

Default tests use temporary ISO/VMX fixtures and mocked shell-free VMware execution on Windows and Linux, including the bundled MCP process. They cover original-byte backups, allowlists and canonical escapes, case-insensitive devices, occupied/ambiguous slots, saved state and locks, races and capability failures. Packaging checks all 134 tools against a saved baseline of all 129 previous definitions.

An opt-in native VMware harness is included but has not been live-validated for this feature. Run only after explicit authorization to create, boot and hard-stop a **new disposable installer VM**. No existing VM is a mutation target. Example PowerShell prerequisites:

```powershell
$env:VMWARE_ISO_LIVE = '1'
$env:VMWARE_ISO_LIVE_HARD_STOP = '1'
$env:VMWARE_ISO_LIVE_PATH = 'C:\ISO\disposable-installer.iso'
$env:VMWARE_ISO_LIVE_FIRMWARE = 'bios' # or efi for appropriate media
npm run build
npm run test:iso:live
```

On native Linux set the same environment variables using native paths. WSL is refused for this live harness. It checks attach, headless power-on, saved media settings, hard-stop, eject, unchanged ISO SHA-256 and the original running-VM set. Installer/OS readiness and boot-order compatibility are not asserted. Evidence and all VM artifacts remain under the newly allocated ignored `test-vms/iso-live-*` directory; no automatic file deletion occurs. Review `evidence.json` after a failure, including whether the disposable VM may remain running. Hosted CI never runs live tests.
