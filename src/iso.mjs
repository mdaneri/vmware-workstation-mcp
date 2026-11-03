import path from 'node:path';
import { z } from 'zod';
import { hardwareError as fail, readHardware, requireOffline } from './vm-hardware.mjs';

const file = z.string().min(1).max(4096).refine(value => !/[\x00-\x1f]/.test(value));
const device = z.string().regex(/^(?:ide[01]:[01]|sata[0-3]:(?:[0-9]|[12][0-9])|scsi[0-3]:(?:[0-6]|[89]|1[0-5]))$/);
const confirm = z.literal(true).describe('Set only after authorization for this VM/media change, with exclusive configuration access.');
export const isoSchemas = {
  iso_list: z.object({ vmx: file }).strict(),
  iso_mount: z.object({ vmx: file, iso_path: file, device: device.optional().describe('Exact optical or unused IDE/SATA slot. Omit to select the sole optical drive or allocate an unused slot.'), start_connected: z.boolean().default(true), confirm }).strict(),
  iso_eject: z.object({ vmx: file, device: device.optional(), confirm }).strict(),
  vm_boot_status: z.object({ vmx: file }).strict(),
  vm_boot_configure: z.object({ vmx: file, firmware_once: z.boolean().optional(), boot_order: z.array(z.enum(['cdrom', 'hdd', 'ethernet', 'floppy'])).min(1).max(4).optional(), confirm }).strict(),
};
const bool = value => /^true$/i.test(value || '') ? true : /^false$/i.test(value || '') ? false : null;
const optical = (config, slot) => /^(?:cdrom(?:-.*)?|atapi-cdrom)$/i.test(config[`${slot}.devicetype`] || '');
function devices(config, vmx) {
  const slots = [...new Set(Object.keys(config).map(k => k.match(/^((?:ide|sata|scsi|nvme)\d+:\d+)\./)?.[1]).filter(Boolean))];
  return slots.filter(slot => optical(config, slot)).sort().map(slot => {
    const backing = config[`${slot}.filename`];
    return { device: slot, device_type: config[`${slot}.devicetype`], present: bool(config[`${slot}.present`]),
      iso_path: /^cdrom-image$/i.test(config[`${slot}.devicetype`]) && backing ? path.resolve(path.dirname(vmx), backing) : null,
      connected: bool(config[`${slot}.connected`]), start_connected: bool(config[`${slot}.startconnected`]),
      connection_source: 'vmx_configuration', live_connection_verified: false,
      editable: /^(ide|sata)/.test(slot) && device.safeParse(slot).success };
  });
}
function select(config, vmx, requested, eject) {
  const drives = devices(config, vmx);
  if (requested) return requested;
  if (drives.length > 1) fail('AMBIGUOUS_DEVICE', 'Multiple optical devices exist; select an exact device from iso_list.');
  if (drives.length === 1) return drives[0].device;
  if (eject) fail('DEVICE_NOT_FOUND', 'No optical device exists.');
  // Prefer an existing SATA controller, otherwise use the universally available
  // IDE bus. Never infer that a disabled disk or a partially configured slot is free.
  const sata = Object.keys(config).filter(k => /^sata[0-3]\.present$/.test(k) && bool(config[k]) === true).map(k => k.split('.')[0]).sort();
  for (const bus of [...sata, 'ide0', 'ide1']) for (let unit = 0; unit < (bus.startsWith('sata') ? 30 : 2); unit++) {
    const slot = `${bus}:${unit}`;
    if (!Object.keys(config).some(k => k.startsWith(slot + '.'))) return slot;
  }
  fail('NO_AVAILABLE_DEVICE', 'No unused supported IDE/SATA slot is available.');
}
function supported(config, slot) {
  if (!device.safeParse(slot).success || !/^(ide|sata)/.test(slot)) fail('UNSUPPORTED_CAPABILITY', 'Optical edits support IDE and SATA only; existing SCSI/NVMe drives are inspection-only.');
  if (slot.startsWith('sata')) {
    if (!(Number(config['virtualhw.version']) >= 10)) fail('UNSUPPORTED_CAPABILITY', 'SATA optical edits require declared virtual hardware version 10 or newer.');
    if (bool(config[`${slot.split(':')[0]}.present`]) !== true) fail('CONTROLLER_MISSING', 'Select a present SATA controller or an unused IDE slot. Controller creation is separate.');
  }
}

export class IsoManager {
  constructor({ backend, vmFiles }) { this.backend = backend; this.vmFiles = vmFiles; }
  async isoPath(input) {
    if (path.extname(input).toLowerCase() !== '.iso' || /:[^\\/]/.test(input.slice(2))) fail('INVALID_ISO', 'Select an absolute local .iso file without alternate streams.');
    const iso = await this.backend.hostPath(input, 'input-file');
    if (path.extname(iso).toLowerCase() !== '.iso') fail('INVALID_ISO', 'ISO links must resolve to a .iso file.');
    return iso;
  }
  async list(input) {
    const a = isoSchemas.iso_list.parse(input); const vmx = await this.backend.vmx(a.vmx);
    const { config } = await readHardware(vmx);
    return { vmx, devices: devices(config, vmx), hot_swap_supported: false, note: 'Connection fields are VMX configuration, not live device state. Media changes require full power-off and exclusive configuration access.' };
  }
  async edit(input, eject = false) {
    const a = isoSchemas[eject ? 'iso_eject' : 'iso_mount'].parse(input);
    const vmx = await this.backend.vmx(a.vmx);
    const iso = eject ? null : await this.isoPath(a.iso_path);
    return this.backend.resources.use([vmx, ...(iso ? [iso] : [])], async () => {
      const vm = await requireOffline(this.backend, vmx);
      const slot = select(vm.config, vmx, a.device, eject); supported(vm.config, slot);
      const occupied = Object.keys(vm.config).some(k => k.startsWith(slot + '.'));
      if (eject && !optical(vm.config, slot)) fail('DEVICE_NOT_FOUND', 'Selected slot is not an optical device.');
      if (!eject && occupied && !optical(vm.config, slot)) fail('SLOT_OCCUPIED', 'Selected slot has non-optical or incomplete settings; refusing to overwrite them.');
      const settings = eject ? {
        [`${slot}.present`]: 'FALSE', [`${slot}.connected`]: 'FALSE', [`${slot}.startConnected`]: 'FALSE', [`${slot}.fileName`]: null,
      } : {
        [`${slot}.present`]: 'TRUE', [`${slot}.deviceType`]: 'cdrom-image', [`${slot}.fileName`]: iso,
        [`${slot}.connected`]: a.start_connected ? 'TRUE' : 'FALSE', [`${slot}.startConnected`]: a.start_connected ? 'TRUE' : 'FALSE',
        [`${slot}.autodetect`]: 'FALSE', [`${slot}.clientDevice`]: 'FALSE',
      };
      const result = await this.vmFiles.configure({ vmx, settings }, { expectedOriginal: vm.text, beforeCommit: async () => {
        if ((await requireOffline(this.backend, vmx)).text !== vm.text) fail('VMX_CHANGED', 'VMX changed during preflight; inspect and retry.');
        if (iso && await this.isoPath(a.iso_path) !== iso) fail('ISO_CHANGED', 'ISO path changed during editing; inspect and retry.');
      } });
      return { ...result, device: slot, mounted: !eject, iso_path: iso, iso_deleted: false,
        note: eject ? 'Optical device disabled and backing detached; ISO and unrelated devices are preserved. A later mount re-enables this slot.' : 'ISO configured offline. start_connected controls connection at next power-on; no power action or live hot-swap performed.' };
    });
  }
  async bootStatus(input) {
    const a = isoSchemas.vm_boot_status.parse(input); const vmx = await this.backend.vmx(a.vmx);
    const { config } = await readHardware(vmx);
    let help;
    try { help = await this.backend.help(); } catch { /* Discovery failure is explicit below. */ }
    return { vmx, firmware: config.firmware || 'bios', configured_firmware_once: bool(config['bios.forcesetuponce']), configured_boot_order: config['bios.bootorder'] || null,
      vmrun_version: help?.match(/vmrun version ([\w.]+)/i)?.[1] || null, help_verified: !!help,
      firmware_once_supported: false, boot_order_supported: false, hot_swap_supported: false, code: 'UNSUPPORTED_CAPABILITY',
      reason: 'No installed-version-verified headless boot configuration interface is implemented. Existing VMX values are inspection only; no keys are inferred or written.' };
  }
  async configureBoot(input) {
    const a = isoSchemas.vm_boot_configure.parse(input);
    await this.backend.vmx(a.vmx);
    fail('UNSUPPORTED_CAPABILITY', 'Next-boot firmware entry and boot-order writes are unavailable until proven compatible with the installed Workstation version. No VMX settings were changed.');
  }
}
