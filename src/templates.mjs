import fs from 'node:fs/promises';
import path from 'node:path';
import { templateSchema, templateSchemas } from './template-schemas.mjs';
import { hardwareError as fail, requireOffline } from './vm-hardware.mjs';
import linux from '../vmware-workstation/templates/linux.json' with { type: 'json' };
import windows from '../vmware-workstation/templates/windows.json' with { type: 'json' };
import esxi from '../vmware-workstation/templates/nested-esxi.json' with { type: 'json' };

export const builtinTemplates = [linux, windows, esxi].map(t => templateSchema.parse(t));
const bus = c => ['lsilogic', 'pvscsi'].includes(c.type) ? 'scsi' : c.type;
const encode = v => String(v).replace(/\|/g, '|7C').replace(/"/g, '|22').replace(/\r/g, '|0D').replace(/\n/g, '|0A');
const vmxText = settings => Object.entries(settings).filter(([, v]) => v !== null).map(([k, v]) => `${k} = "${encode(v)}"`).join('\n') + '\n';
const declaredBool = (value, fallback = false) => {
  if (value === undefined) return fallback;
  if (!/^(true|false)$/i.test(value)) fail('UNSUPPORTED_CAPABILITY', 'An unrecognized hardware boolean cannot be exported safely.');
  return /^true$/i.test(value);
};

export function validateTemplate(input) {
  const t = templateSchema.parse(input);
  if (t.cpu.cpus % t.cpu.cores_per_socket) fail('INVALID_TOPOLOGY', 'cores_per_socket must evenly divide cpus.');
  if (t.security.vtpm) fail('UNSUPPORTED_CAPABILITY', 'Template vTPM/encryption deployment has no verified headless backend.');
  if (t.security.secure_boot && t.firmware !== 'efi') fail('INCOMPATIBLE_HARDWARE', 'Secure Boot requires EFI.');
  if (t.boot.mode === 'pxe') fail('UNSUPPORTED_CAPABILITY', 'PXE boot-order writes have no verified backend. Use default boot and a separately configured PXE network; no boot order is promised.');
  if ((t.boot.mode === 'iso') !== !!t.boot.media) fail('INVALID_MEDIA', 'Only ISO boot requires a logical media name.');
  const controllers = new Set();
  for (const c of t.controllers) {
    const p = `${bus(c)}${c.index}`;
    if (controllers.has(p)) fail('DUPLICATE_DEVICE', 'Controller indices must be unique per bus.');
    controllers.add(p);
  }
  const slots = new Set();
  for (const d of t.disks) {
    const p = `${d.controller}${d.controller_index}`, slot = `${p}:${d.unit}`;
    if (!controllers.has(p)) fail('CONTROLLER_MISSING', 'Every disk requires a declared controller.');
    if (slots.has(slot)) fail('DUPLICATE_DEVICE', 'Disk slots must be unique.');
    slots.add(slot);
    if (d.unit > ({ scsi: 15, sata: 29, nvme: 14 })[d.controller] || d.controller === 'scsi' && d.unit === 7) fail('INVALID_SLOT', 'Invalid disk slot; SCSI 7 is reserved.');
  }
  if (new Set(t.nics.map(n => n.index)).size !== t.nics.length) fail('DUPLICATE_DEVICE', 'NIC indices must be unique.');
  return t;
}

export class TemplateManager {
  constructor({ backend, hardware, rest } = {}) { this.backend = backend; this.hardware = hardware; this.rest = rest; }
  list() { return { schema_version: '1.0', templates: structuredClone(builtinTemplates), custom_templates: 'Pass a JSON template directly; no host directory scan or implicit file reads.' }; }
  resolve(input) {
    const found = typeof input === 'string' ? builtinTemplates.find(t => t.id === input) : input;
    if (!found) fail('TEMPLATE_NOT_FOUND', 'Unknown template ID. Use template_list or supply a portable JSON template.');
    return validateTemplate(found);
  }
  async prepare(a) {
    const t = this.resolve(a.template);
    const required = new Set(t.nics.map(n => n.network));
    if (Object.keys(a.networks).some(k => !required.has(k)) || [...required].some(k => !Object.hasOwn(a.networks, k))) fail('INVALID_NETWORK', 'Supply exactly one local binding for each logical network in the template.');
    const mediaNames = t.boot.mode === 'iso' ? [t.boot.media] : [];
    if (Object.keys(a.media).some(k => !mediaNames.includes(k)) || mediaNames.some(k => !Object.hasOwn(a.media, k))) fail('INVALID_MEDIA', 'Supply exactly the logical ISO media bindings declared by the template.');
    let iso;
    if (mediaNames.length) {
      iso = await this.backend.hostPath(a.media[t.boot.media], 'input-file');
      if (path.extname(iso).toLowerCase() !== '.iso') fail('INVALID_MEDIA', 'ISO bindings must resolve to an existing .iso file.');
    }
    const creation = { directory: a.directory, name: t.name, guest_os: t.guest_os, hardware_version: t.hardware_version,
      ...t.cpu, memory_mb: t.memory_mb, firmware: t.firmware, secure_boot: t.security.secure_boot,
      controllers: t.controllers, disks: t.disks, nics: t.nics.map(n => ({ ...n, ...a.networks[n.network] })),
      ...(iso ? { iso_path: iso } : {}), timeout_seconds: a.timeout_seconds ?? 600 };
    const internal = await this.hardware.planCreate(creation);
    const capacity = t.disks.reduce((sum, d) => sum + d.capacity_mb * 1048576, 0);
    const directory = internal.directory;
    return { creation, plan: { schema_version: '1.0', template_id: t.id, directory, vmx: path.join(directory, 'machine.vmx'),
      vmx_text: vmxText(internal.settings), disks: t.disks.map((d, i) => ({ ...d, path: path.join(directory, `disk-${i}`, 'disk.vmdk'), type: '0' })),
      resources: { cpus: t.cpu.cpus, memory_mb: t.memory_mb, virtual_disk_bytes: capacity, required_free_bytes: Math.ceil(capacity * 1.1 + 64 * 1048576) },
      changes: ['Create a NEW VM directory', 'Create independent blank sparse disks', 'Write a NEW VMX', ...(a.register ? ['Register through authenticated REST'] : []), ...(a.power_on ? ['Start this new VM headlessly'] : [])],
      register: a.register ?? false, power_on: a.power_on ?? false,
      capabilities: { product_version: internal.caps.product_version, maximum_hardware_version: internal.caps.maximum_hardware_version, boot_order: 'unsupported', vtpm: 'unsupported' },
      warnings: ['Blank hardware only: no OS, disk contents, credentials, UUIDs or MACs are copied.', 'ISO attachment does not force boot order. Guest drivers, Windows requirements and nested CPU support need separate live validation.', 'Plans reserve no paths. Deployment repeats preflight; partial output is retained on failure.'], live_support: 'unknown' } };
  }
  async validate(input) {
    const a = templateSchemas.template_validate.parse(input);
    const { plan } = await this.prepare(a);
    return { valid: true, dry_run: true, plan };
  }
  async deploy(input, { signal } = {}) {
    const a = templateSchemas.template_deploy.parse(input);
    if (!a.dry_run && a.confirm !== true) fail('CONFIRM_REQUIRED', 'Real deployment requires confirm=true after authorization for this destination and requested actions.');
    const { creation, plan } = await this.prepare(a);
    if (a.register) {
      if (!this.rest) fail('REGISTRATION_UNAVAILABLE', 'Registration requires authenticated Workstation REST.');
      // Read-only preflight verifies service/credentials before creating any files.
      await this.rest.request('GET', '/api/vms', { timeout: Math.min(10000, a.timeout_seconds * 1000) });
    }
    if (a.dry_run) return { valid: true, dry_run: true, plan };
    signal?.throwIfAborted();
    return this.backend.resources.use([plan.directory], async () => {
      const created = await this.hardware.create(creation);
      let registered = false, poweredOn = false, stage = 'registration';
      try {
        if (a.register) {
          signal?.throwIfAborted();
          await this.rest.request('POST', '/api/vms/registration', { body: { name: creation.name, path: created.vmx }, timeout: a.timeout_seconds * 1000 }); registered = true;
        }
        stage = 'power_on';
        if (a.power_on) { signal?.throwIfAborted(); await this.backend.power(created.vmx, 'start', 'soft', false); poweredOn = true; }
      } catch {
        throw Object.assign(new Error('VM files were created; a requested post-deploy action failed or was cancelled. Inspect retained VM and inventory/power state before retrying; no rollback.'), {
          code: 'POST_DEPLOY_FAILED', details: { vmx: created.vmx, directory: created.directory, registered, poweredOn, failed_stage: stage, failed_action_outcome: 'unknown' },
        });
      }
      return { ...created, registered, poweredOn, dry_run: false, plan };
    });
  }
  async export(input) {
    const a = templateSchemas.template_export.parse(input), vmx = await this.backend.vmx(a.vmx);
    return this.backend.resources.use([vmx], async () => {
      const { text, config: c } = await requireOffline(this.backend, vmx);
      const t = { schema_version: '1.0', id: a.id, name: a.name, guest_os: c.guestos, hardware_version: Number(c['virtualhw.version']),
        cpu: { cpus: Number(c.numvcpus), cores_per_socket: Number(c['cpuid.corespersocket'] || 1), nested_virtualization: declaredBool(c['vhv.enable']) },
        memory_mb: Number(c.memsize), firmware: c.firmware || 'bios', security: { secure_boot: declaredBool(c['uefi.secureboot.enabled']), vtpm: declaredBool(c['vtpm.present']) },
        controllers: [], disks: [], nics: [], boot: { mode: 'default' } };
      for (const [k, v] of Object.entries(c)) {
        let m;
        if ((m = k.match(/^(scsi|sata|nvme)(\d+)\.present$/)) && /^true$/i.test(v)) t.controllers.push({ type: m[1] === 'scsi' ? c[`scsi${m[2]}.virtualdev`] : m[1], index: Number(m[2]) });
        if ((m = k.match(/^(scsi|sata|nvme|ide)(\d+):(\d+)\.filename$/)) && /^true$/i.test(c[k.replace('filename', 'present')] || '')) {
          if (/\.vmdk$/i.test(v)) {
            const disk = await this.hardware.disks.inspect({ disk: path.resolve(path.dirname(vmx), v) });
            if (!disk.independent) fail('UNSUPPORTED_DISK', 'Export requires independent disks; template export does not copy linked/snapshot contents.');
            t.disks.push({ controller: m[1], controller_index: Number(m[2]), unit: Number(m[3]), capacity_mb: disk.capacity_bytes / 1048576 });
          } else if (c[k.replace('filename', 'devicetype')] === 'cdrom-image') {
            if (t.boot.mode === 'iso') fail('UNSUPPORTED_CAPABILITY', 'Template v1 supports at most one ISO.');
            t.boot = { mode: 'iso', media: 'installer' };
          } else fail('UNSUPPORTED_CAPABILITY', 'Active storage backing cannot be represented as a portable blank template.');
        }
        if ((m = k.match(/^ethernet(\d+)\.present$/)) && /^true$/i.test(v)) {
          t.nics.push({ index: Number(m[1]), model: c[`ethernet${m[1]}.virtualdev`], network: `network${m[1]}`, start_connected: declaredBool(c[`ethernet${m[1]}.startconnected`], true) });
        }
      }
      const template = validateTemplate(t);
      if (await fs.readFile(vmx, 'utf8') !== text) fail('SOURCE_CHANGED', 'VMX changed during export; inspect and retry.');
      return { template, required_bindings: { networks: [...new Set(t.nics.map(n => n.network))], media: t.boot.media ? [t.boot.media] : [] },
        omissions: ['Disk contents and OS installation', 'VM identity, UUIDs and MAC addresses', 'Host paths, VMnets and LAN segment identity', 'Credentials, encryption, console/serial endpoints, arbitrary VMX fields and boot order'],
        note: 'Read-only blank hardware recipe. All networks/media must be rebound locally; unrelated devices/settings are omitted. No source files were copied or modified.' };
    });
  }
}
