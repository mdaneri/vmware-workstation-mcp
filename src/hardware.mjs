import fs from 'node:fs/promises';
import path from 'node:path';
import { findVMwareExecutable } from './host-platform.mjs';
import { hardwareError as fail, readHardware, requireOffline } from './vm-hardware.mjs';
import { hardwareSchemas } from './hardware-schemas.mjs';
import { DiskManager } from './disks.mjs';
import { LanSegments, assertLanGUIClosed } from './lan-segments.mjs';

const bus = c => ['lsilogic', 'pvscsi'].includes(c.type) ? 'scsi' : c.type;
const prefix = c => `${bus(c)}${c.index}`;
const bool = v => v === undefined ? null : /^true$/i.test(v);
const numeric = v => /^\d+$/.test(v || '') ? Number(v) : null;
const truth = v => v ? 'TRUE' : 'FALSE';
const encode = v => String(v).replace(/\|/g, '|7C').replace(/"/g, '|22').replace(/\r/g, '|0D').replace(/\n/g, '|0A');
const present = (config, p) => Object.keys(config).some(k => k.startsWith(`${p}.`));

// vmrun reports its API version (1.17), not the installed product version.
// Query the native worker's version-only CLI; never launch the desktop UI.
export function productCapabilities(output) {
  const match = output.match(/VMware Workstation(?: Pro)?\s+(\d+)\.(\d+)(?:\.(\d+))?\s+build[- ](\d+)/i);
  if (!match) fail('UNSUPPORTED_CAPABILITY', 'Native vmware-vmx did not return a recognized Workstation product version.');
  const major = Number(match[1]), minor = Number(match[2]);
  const max = major === 17 && minor <= 6 ? (minor >= 5 ? 21 : 20) : [25, 26].includes(major) && minor === 0 ? 22 : null;
  if (!max) fail('UNSUPPORTED_CAPABILITY', 'Typed hardware has no compatibility profile for this Workstation release. No settings were guessed.');
  return { product_version: `${match[1]}.${match[2]}.${match[3] || '0'}`, build: match[4],
    minimum_hardware_version: 14, maximum_hardware_version: max, maximum_cpus: 32, maximum_memory_mb: 131072,
    controllers: ['lsilogic', 'pvscsi', 'sata', 'nvme'], nic_models: ['e1000', 'e1000e', 'vmxnet3'],
    firmware: ['bios', 'efi'], secure_boot: true, nested_virtualization: 'configurable; host CPU/hypervisor support unverified',
    vtpm: { configurable: false, reason: 'No verified headless encryption/key-management backend. Configure encryption and vTPM separately in VMware; encrypted VMX edits are refused.' },
    live_support: 'unknown', evidence: 'Installed native worker version and conservative compatibility profile; not a power-on or guest driver test.' };
}

function validateHardware(config, caps) {
  const hw = numeric(config['virtualhw.version']);
  if (!hw || hw < caps.minimum_hardware_version || hw > caps.maximum_hardware_version) fail('UNSUPPORTED_CAPABILITY', 'Declared virtual hardware is outside the installed product compatibility profile (14 through ' + caps.maximum_hardware_version + ').');
  const cpus = numeric(config.numvcpus), cores = numeric(config['cpuid.corespersocket']);
  const memory = numeric(config.memsize);
  if (!cpus || cpus > caps.maximum_cpus || !cores || cpus % cores || cores > cpus) fail('INVALID_TOPOLOGY', 'Declare positive vCPUs and cores_per_socket that evenly divide vCPUs, within 32 vCPUs.');
  if (!memory || memory < 256 || memory > caps.maximum_memory_mb || memory % 4) fail('INVALID_MEMORY', 'Memory must be 256 through 131072 MiB, divisible by four.');
  if (!caps.firmware.includes(config.firmware)) fail('UNSUPPORTED_CAPABILITY', 'Declare BIOS or EFI firmware explicitly.');
  if (bool(config['uefi.secureboot.enabled']) && config.firmware !== 'efi') fail('INCOMPATIBLE_HARDWARE', 'Secure Boot requires EFI firmware.');
}

function controllerSettings(controllers, config) {
  const settings = {}, seen = new Set();
  for (const c of controllers || []) {
    const p = prefix(c);
    if (seen.has(p)) fail('DUPLICATE_DEVICE', 'Controller indices must be unique within each bus.');
    seen.add(p);
    if (Object.keys(config).some(k => k.startsWith(p + ':')) && !/^true$/i.test(config[`${p}.present`] || '')) fail('CONTROLLER_OCCUPIED', 'A disabled or undeclared controller has device settings; inspect before changing it.');
    if (present(config, p) && (!/^true$/i.test(config[`${p}.present`] || '') || (bus(c) === 'scsi' && config[`${p}.virtualdev`] !== c.type))) fail('CONTROLLER_OCCUPIED', 'Existing controller identity/type is preserved. Choose a new controller index.');
    settings[`${p}.present`] = 'TRUE';
    if (bus(c) === 'scsi') settings[`${p}.virtualDev`] = c.type;
  }
  return settings;
}

function pcieSettings(config) {
  const settings = {};
  if (present(config, 'pcibridge0') && bool(config['pcibridge0.present']) !== true) fail('UNSUPPORTED_CAPABILITY', 'Existing PCI bridge is disabled or incomplete; inspect it before adding PCIe devices.');
  for (const i of [4, 5, 6, 7]) if (present(config, `pcibridge${i}`) && (bool(config[`pcibridge${i}.present`]) !== true || config[`pcibridge${i}.virtualdev`]?.toLowerCase() !== 'pcierootport')) fail('UNSUPPORTED_CAPABILITY', 'Existing PCIe root-port configuration is unsupported; inspect it before adding PCIe devices.');
  if (!present(config, 'pcibridge0')) settings['pciBridge0.present'] = 'TRUE';
  for (const i of [4, 5, 6, 7]) if (!present(config, `pcibridge${i}`)) Object.assign(settings, {
    [`pciBridge${i}.present`]: 'TRUE', [`pciBridge${i}.virtualDev`]: 'pcieRootPort', [`pciBridge${i}.functions`]: '8',
  });
  return settings;
}

export class HardwareManager {
  constructor({ backend, vmFiles, disks, lan, platform = process.platform, assertGUIClosed = assertLanGUIClosed } = {}) {
    this.backend = backend; this.vmFiles = vmFiles;
    this.disks = disks || new DiskManager({ backend, vmFiles });
    this.lan = lan || new LanSegments(backend, vmFiles);
    this.platform = platform;
    this.assertGUIClosed = () => assertGUIClosed(backend);
  }
  async capabilities() {
    let executable;
    try {
      const beside = await this.backend.executable();
      executable = await findVMwareExecutable('vmware-vmx', { env: this.backend.env, beside });
      const options = { shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 };
      // The Windows worker is a GUI-subsystem executable and -v produces no
      // stdio. Read its PE metadata through a fixed native helper, without
      // interpolating paths into PowerShell code or launching VMware.
      const result = this.platform === 'win32'
        ? await this.backend.execute('pwsh', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $info=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:VMWARE_HARDWARE_VERSION_TARGET); if ($info.OriginalFilename -ne 'vmware-vmx.exe' -or $info.ProductName -ne 'VMware Workstation') { throw 'Unexpected worker metadata' }; Write-Output ($info.ProductName + ' ' + $info.ProductVersion)"], { ...options, env: { ...this.backend.env, VMWARE_HARDWARE_VERSION_TARGET: executable } })
        : await this.backend.execute(executable, ['-v'], options);
      return { available: true, executable, ...productCapabilities([result.stdout, result.stderr].filter(Boolean).join('\n')) };
    } catch (e) { return { available: false, executable: executable || null, code: 'UNSUPPORTED_CAPABILITY', message: e.code === 'UNSUPPORTED_CAPABILITY' ? e.message : 'Cannot verify the native Workstation worker version.', action: 'Install a supported native Workstation and set VMWARE_VMX_PATH to vmware-vmx if needed. No GUI fallback.', live_support: 'unknown' }; }
  }
  async available() {
    const caps = await this.capabilities();
    if (!caps.available) fail(caps.code, caps.message);
    return caps;
  }
  async get(input) {
    const a = hardwareSchemas.vm_hardware_get.parse(input), vmx = await this.backend.vmx(a.vmx);
    const { config } = await readHardware(vmx);
    const cpus = numeric(config.numvcpus), cores = numeric(config['cpuid.corespersocket']);
    const controllers = Object.keys(config).filter(k => /^(scsi|sata|nvme)\d+\.present$/.test(k)).sort().map(k => {
      const p = k.split('.')[0]; return { device: p, present: bool(config[k]), type: p.startsWith('scsi') ? config[`${p}.virtualdev`] || null : p.replace(/\d+$/, '') };
    });
    const indices = [...new Set(Object.keys(config).flatMap(k => k.match(/^ethernet(\d+)\./)?.slice(1) || []))].map(Number).sort((a, b) => a - b);
    return { vmx, running: (await this.backend.details(vmx)).running, hardware_version: numeric(config['virtualhw.version']),
      cpus, cores_per_socket: cores, sockets: cpus && cores && cpus % cores === 0 ? cpus / cores : null,
      memory_mb: numeric(config.memsize), nested_virtualization: bool(config['vhv.enable']),
      firmware: config.firmware || null, secure_boot: bool(config['uefi.secureboot.enabled']), vtpm: bool(config['vtpm.present']),
      encrypted: Object.keys(config).some(k => k.startsWith('encryption.')), controllers,
      disks: Object.keys(config).filter(k => /^(scsi|sata|ide|nvme)\d+:\d+\.filename$/.test(k) && /\.vmdk$/i.test(config[k])).sort().map(k => ({ device: k.split('.')[0], file: config[k], present: bool(config[k.replace('filename', 'present')]) })),
      nics: indices.map(index => { const p = `ethernet${index}`; return { index, present: bool(config[`${p}.present`]), model: config[`${p}.virtualdev`] || null,
        network: config[`${p}.connectiontype`] || null, vmnet: config[`${p}.vnet`] || null, segment_id: config[`${p}.pvnid`] || null,
        address_type: config[`${p}.addresstype`] || null, mac: config[`${p}.address`] || config[`${p}.generatedaddress`] || null, start_connected: bool(config[`${p}.startconnected`]) }; }),
      note: 'Declared configuration only; omitted values are unknown, not inferred defaults. Guest driver and nested CPU support require live validation.' };
  }
  async nicSettings(nics, config) {
    const settings = {}, seen = new Set(), macs = new Set();
    let catalog = null;
    if (nics?.some(n => n.segment !== undefined || n.network === 'lan_segment')) catalog = await this.lan.readCatalog();
    for (const n of nics || []) {
      if (seen.has(n.index)) fail('DUPLICATE_DEVICE', 'NIC indices must be unique.'); seen.add(n.index);
      const p = `ethernet${n.index}`, existing = present(config, p);
      if (existing && !/^true$/i.test(config[`${p}.present`] || '')) fail('NIC_OCCUPIED', 'Disabled/partial NIC settings are preserved; select a new index.');
      if (existing && !config[`${p}.virtualdev`]) fail('UNSUPPORTED_CAPABILITY', 'Existing NIC model is undeclared; refusing to guess its identity.');
      const model = n.model || config[`${p}.virtualdev`] || 'e1000';
      if (!['e1000', 'e1000e', 'vmxnet3'].includes(model)) fail('UNSUPPORTED_CAPABILITY', 'Unsupported existing NIC model.');
      if (existing && n.model !== undefined && model !== config[`${p}.virtualdev`]) fail('NIC_IDENTITY_CHANGE', 'Changing an existing NIC model is refused to preserve identity. Add an adapter at an unused index.');
      settings[`${p}.present`] = 'TRUE'; settings[`${p}.virtualDev`] = model;
      if (!existing) settings[`${p}.addressType`] = 'generated';
      if (n.mac) {
        const mac = n.mac.toLowerCase();
        if (macs.has(mac) || Object.entries(config).some(([k, v]) => /^ethernet\d+\.(?:address|generatedaddress)$/.test(k) && !k.startsWith(p + '.') && v.toLowerCase() === mac)) fail('DUPLICATE_MAC', 'MAC is already assigned to another adapter in this VM.');
        macs.add(mac); settings[`${p}.addressType`] = 'static'; settings[`${p}.address`] = mac;
        settings[`${p}.generatedAddress`] = null; settings[`${p}.generatedAddressOffset`] = null;
      }
      const network = n.network || (existing ? null : 'nat');
      if (n.vmnet !== undefined && network !== 'custom') fail('INVALID_NETWORK', 'vmnet requires network=custom.');
      if (n.segment !== undefined && network !== 'lan_segment') fail('INVALID_NETWORK', 'segment requires network=lan_segment.');
      if (network) {
        settings[`${p}.vnet`] = null; settings[`${p}.pvnID`] = null;
        settings[`${p}.connectionType`] = network === 'lan_segment' ? 'pvn' : network;
        if (network === 'custom') {
          if (!n.vmnet) fail('INVALID_NETWORK', 'Custom networking requires an explicit vmnet.');
          settings[`${p}.vnet`] = n.vmnet;
        }
        if (network === 'lan_segment') {
          const matches = catalog.document.segments.filter(s => s.id === n.segment?.toLowerCase() || s.name.toLowerCase() === n.segment?.toLowerCase());
          if (matches.length !== 1) fail('INVALID_NETWORK', 'Select one unambiguous existing LAN segment by name or pvnID.');
          settings[`${p}.pvnID`] = matches[0].id;
        }
      }
      if (n.start_connected !== undefined || !existing) settings[`${p}.startConnected`] = truth(n.start_connected ?? true);
    }
    const existingIndices = Object.keys(config).flatMap(k => k.match(/^ethernet(\d+)\.present$/)?.slice(1) || []);
    if (new Set([...existingIndices.map(Number), ...seen]).size > 10) fail('UNSUPPORTED_CAPABILITY', 'At most ten NICs are supported.');
    return { settings, catalog };
  }
  settings(a, config, caps) {
    if (a.vtpm !== undefined) fail('UNSUPPORTED_CAPABILITY', caps.vtpm.reason);
    const settings = controllerSettings(a.controllers, config);
    for (const [field, key] of Object.entries({ cpus: 'numvcpus', cores_per_socket: 'cpuid.coresPerSocket', memory_mb: 'memsize', firmware: 'firmware' })) if (a[field] !== undefined) settings[key] = String(a[field]);
    if (a.nested_virtualization !== undefined) settings['vhv.enable'] = truth(a.nested_virtualization);
    if (a.secure_boot !== undefined) settings['uefi.secureBoot.enabled'] = truth(a.secure_boot);
    const combined = { ...config, ...Object.fromEntries(Object.entries(settings).map(([k, v]) => [k.toLowerCase(), v])) };
    validateHardware(combined, caps);
    return settings;
  }
  async set(input) {
    const a = hardwareSchemas.vm_hardware_set.parse(input), vmx = await this.backend.vmx(a.vmx);
    return this.backend.resources.use([vmx], async () => {
      await this.assertGUIClosed();
      const caps = await this.available(), vm = await requireOffline(this.backend, vmx);
      if (bool(vm.config['vtpm.present'])) fail('UNSUPPORTED_CAPABILITY', 'Existing vTPM hardware edits require a verified encryption backend.');
      const settings = this.settings(a, vm.config, caps), nic = await this.nicSettings(a.nics, vm.config);
      Object.assign(settings, nic.settings);
      if (a.controllers?.some(c => c.type === 'nvme') || a.nics?.some(n => !present(vm.config, `ethernet${n.index}`) && ['e1000e', 'vmxnet3'].includes(n.model))) Object.assign(settings, pcieSettings(vm.config));
      if (!Object.keys(settings).length) fail('INVALID_CHANGE', 'Provide at least one nonempty hardware change.');
      if (Object.keys(settings).length > 128) fail('INVALID_CHANGE', 'Too many VMX settings for one edit; split into smaller requests.');
      return { ...await this.vmFiles.configure({ vmx, settings }, { expectedOriginal: vm.text, beforeCommit: async () => {
        await this.assertGUIClosed(); await requireOffline(this.backend, vmx);
        if (nic.catalog) await this.lan.unchanged(nic.catalog);
        if (JSON.stringify(await this.available()) !== JSON.stringify(caps)) fail('CAPABILITY_CHANGED', 'Installed worker capabilities changed before commit.');
      } }), live_support: 'unknown' };
    });
  }
  // Shared read-only preflight for typed creation and declarative template plans.
  async planCreate(a) {
    const directory = await this.backend.hostPath(a.directory, 'destination-directory');
    await this.backend.hostPath(path.dirname(directory), 'directory');
    // New disks also need the host-file allowlist, independently of VM roots.
    await this.backend.hostPath(directory, 'host-destination-directory');
    try { await fs.lstat(directory); fail('TARGET_EXISTS', 'VM creation requires a NEW destination directory.'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const caps = await this.available();
    const controllers = a.controllers ?? [{ type: 'lsilogic', index: 0 }];
    const disks = a.disks ?? [{ controller: 'scsi', controller_index: 0, unit: 0, capacity_mb: a.disk_gb * 1024 }];
    const nics = a.nics ?? (a.network === 'none' ? [] : [{ index: 0, model: 'e1000', network: a.network, ...(a.vmnet ? { vmnet: a.vmnet } : {}) }]);
    const base = { '.encoding': 'UTF-8', 'config.version': '8', 'virtualHW.version': String(a.hardware_version), displayName: a.name, guestOS: a.guest_os,
      memsize: String(a.memory_mb), numvcpus: String(a.cpus), 'cpuid.coresPerSocket': String(a.cores_per_socket ?? 1), firmware: a.firmware,
      'floppy0.present': 'FALSE', 'sound.present': 'FALSE', 'usb.present': 'FALSE', ...pcieSettings({}) };
    const config = Object.fromEntries(Object.entries(base).map(([k, v]) => [k.toLowerCase(), v]));
    const settings = { ...base, ...this.settings({ ...a, controllers }, config, caps) };
    const nic = await this.nicSettings(nics, {}); Object.assign(settings, nic.settings);
    const slots = new Set();
    for (const d of disks) {
      const p = `${d.controller}${d.controller_index}`, slot = `${p}:${d.unit}`;
      if (!controllers.some(c => prefix(c) === p)) fail('CONTROLLER_MISSING', 'Every disk requires an explicitly declared controller.');
      if (slots.has(slot)) fail('DUPLICATE_DEVICE', 'Disk slots must be unique.'); slots.add(slot);
      if (d.unit > ({ scsi: 15, sata: 29, nvme: 14 })[d.controller] || d.controller === 'scsi' && d.unit === 7) fail('INVALID_SLOT', 'Invalid storage slot; SCSI unit 7 is reserved. NVMe supports units 0-14 in this conservative profile.');
    }
    if (a.iso_path) {
      const iso = await this.backend.hostPath(a.iso_path, 'input-file');
      // Legacy creation uses SATA; allocate a free slot without replacing a disk.
      let slot;
      for (let i = 0; i < 30; i++) if (!slots.has(`sata0:${i}`)) { slot = `sata0:${i}`; break; }
      if (!slot) fail('INVALID_SLOT', 'No free SATA0 slot for ISO.');
      Object.assign(settings, { 'sata0.present': 'TRUE', [`${slot}.present`]: 'TRUE', [`${slot}.deviceType`]: 'cdrom-image', [`${slot}.fileName`]: iso });
    }
    await this.disks.available('create', '0');
    await this.disks.freeSpace(path.dirname(directory), disks.reduce((sum, d) => sum + d.capacity_mb * 1048576, 0));
    if (nic.catalog) { await this.assertGUIClosed(); await this.lan.unchanged(nic.catalog); }
    for (let i = 0; i < disks.length; i++) {
      const d = disks[i], slot = `${d.controller}${d.controller_index}:${d.unit}`;
      settings[`${slot}.present`] = 'TRUE'; settings[`${slot}.fileName`] = path.join(`disk-${i}`, 'disk.vmdk');
    }
    return { directory, caps, disks, settings, nic };
  }
  async create(a) {
    return this.vmFiles.exclusive(async () => {
      const { directory, caps, disks, settings, nic } = await this.planCreate(a);
      const vmx = path.join(directory, 'machine.vmx'), createdDisks = [];
      return this.backend.resources.use([directory], async () => {
        await fs.mkdir(directory, { mode: 0o700 });
        try {
          for (let i = 0; i < disks.length; i++) {
            const d = disks[i], destination = path.join(directory, `disk-${i}`, 'disk.vmdk');
            const result = await this.disks.perform('create', { destination, capacity_mb: d.capacity_mb, adapter: 'lsilogic', disk_type: '0', timeout_seconds: a.timeout_seconds });
            createdDisks.push(result.disk);
            const slot = `${d.controller}${d.controller_index}:${d.unit}`;
            settings[`${slot}.present`] = 'TRUE'; settings[`${slot}.fileName`] = path.relative(directory, result.disk);
          }
          if (nic.catalog) { await this.assertGUIClosed(); await this.lan.unchanged(nic.catalog); }
          if (JSON.stringify(await this.available()) !== JSON.stringify(caps)) fail('CAPABILITY_CHANGED', 'Worker version changed during creation.');
          // Keep canonical VMX key casing for existing readers such as get_vm_details.
          await fs.writeFile(vmx, Object.entries(settings).filter(([, v]) => v !== null).map(([k, v]) => `${k} = "${encode(v)}"`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
          return { created: true, vmx, disk: createdDisks[0], disks: createdDisks, directory, registered: false, poweredOn: false, guestOSInstalled: false, live_support: 'unknown', note: 'Blank isolated hardware created. Guest drivers, OS installation and nested hypervisor execution require separate live validation.' };
        } catch (e) { throw Object.assign(new Error('Typed VM creation failed. Partial files are retained in the new directory; inspect before retrying. No existing VM was overwritten.'), { code: e.code || 'CREATE_FAILED', details: { directory, reason: e.code || 'DISK_OR_CONFIG_FAILED' } }); }
      });
    });
  }
}
