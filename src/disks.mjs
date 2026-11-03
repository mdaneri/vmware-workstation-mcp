import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { findVMwareExecutable } from './host-platform.mjs';
import { isWithin, parseAssignments } from './workstation.mjs';

const file = z.string().min(1).max(4096).refine(value => !/[\x00-\x1f]/.test(value));
const timeout = z.number().int().min(1).max(3600).default(600);
const capacity = z.number().int().min(1).max(8388608).describe('Total virtual capacity in MiB, not an increment.');
const vmPaths = z.array(file).max(256).default([]).describe('Additional unregistered VMX files that may reference this disk. Inventory is also checked.');
const confirm = z.literal(true).describe('Set only after the user authorizes this exact change and confirms no unregistered VM, other process or host uses this disk.');
const source = { disk: file, vmx_paths: vmPaths, confirm, timeout_seconds: timeout };
const slot = { vmx: file, controller: z.enum(['scsi', 'sata', 'ide', 'nvme']), controller_index: z.number().int().min(0).max(3), unit: z.number().int().min(0).max(63), confirm };
export const diskSchemas = {
  disk_manager_status: z.object({}).strict(),
  disk_inspect: z.object({ disk: file }).strict(),
  disk_create: z.object({ destination: file.describe('Absolute .vmdk in a NEW parent directory; grandparent must exist.'), capacity_mb: capacity, disk_type: z.enum(['0', '1', '2', '3']).default('0'), adapter: z.enum(['ide', 'buslogic', 'lsilogic']).default('lsilogic'), timeout_seconds: timeout }).strict(),
  disk_expand: z.object({ ...source, capacity_mb: capacity }).strict(),
  disk_convert: z.object({ ...source, destination: file.describe('Absolute .vmdk in a NEW parent directory; source is preserved.'), disk_type: z.enum(['0', '1', '2', '3', '5']).default('0') }).strict(),
  disk_compact: z.object(source).strict(),
  disk_defragment: z.object(source).strict(),
  disk_attach: z.object({ ...slot, disk: file, vmx_paths: vmPaths }).strict(),
  disk_detach: z.object({ ...slot, disk: file.describe('Expected backing disk; refuses a different disk at the selected slot.'), vmx_paths: vmPaths }).strict(),
};
const flags = { create: '-c', expand: '-x', convert: '-r', compact: '-k', defragment: '-d' };
const types = new Set(['monolithicSparse', 'monolithicFlat', 'twoGbMaxExtentSparse', 'twoGbMaxExtentFlat', 'streamOptimized']);
const sparse = new Set(['monolithicSparse', 'twoGbMaxExtentSparse']);
const key = file => process.platform === 'win32' ? file.toLowerCase() : file;
const exists = async file => { try { return await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
function fail(code, message, details = {}) { throw Object.assign(new Error(message), { code, details }); }
function vmConfig(text) {
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const match = line.match(/^\s*([\w.:-]+)\s*=\s*".*"\s*$/);
    if (!match || seen.has(match[1].toLowerCase())) fail('UNSAFE_VM', 'Malformed or duplicate VMX settings prevent safe disk editing.');
    seen.add(match[1].toLowerCase());
  }
  const config = Object.fromEntries(Object.entries(parseAssignments(text)).map(([k, v]) => [k.toLowerCase(), v]));
  if (config['.encoding'] && !/^utf-?8$/i.test(config['.encoding'])) fail('UNSAFE_VM', 'Disk edits require UTF-8 VMX files.');
  return config;
}

// Read the declared descriptor, never search guest data for strings resembling metadata.
export async function readDiskDescriptor(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat(); const header = Buffer.alloc(512);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    let offset = 0; let size = Math.min(stat.size, 1024 * 1024);
    if (bytesRead >= 44 && header.toString('ascii', 0, 4) === 'KDMV') {
      const sectors = header.readBigUInt64LE(28); const count = header.readBigUInt64LE(36);
      if (!sectors || !count) fail('UNSUPPORTED_DISK', 'VMDK extent has no embedded descriptor. Select its descriptor VMDK.');
      if (sectors > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 512)) || count > 2048n) fail('UNSUPPORTED_DISK', 'VMDK descriptor bounds are unsupported.');
      offset = Number(sectors) * 512; size = Number(count) * 512;
    } else if (!header.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '').startsWith('# Disk DescriptorFile')) {
      fail('UNSUPPORTED_DISK', 'Unrecognized VMDK descriptor. Raw devices, encrypted disks and extent-only inputs are unsupported.');
    } else if (stat.size > 1024 * 1024) fail('UNSUPPORTED_DISK', 'VMDK text descriptor exceeds 1 MiB.');
    if (offset + size > stat.size) fail('UNSUPPORTED_DISK', 'VMDK descriptor extends beyond its file.');
    const buffer = Buffer.alloc(size); const read = await handle.read(buffer, 0, size, offset);
    if (read.bytesRead !== size) fail('UNSUPPORTED_DISK', 'Incomplete VMDK descriptor.');
    const text = buffer.toString('utf8').replace(/\0+$/, '');
    const field = (name, quoted = false) => {
      const matches = [...text.matchAll(new RegExp(`^\\s*${name}\\s*=\\s*${quoted ? '"([^"\\r\\n]+)"' : '([a-fA-F0-9]+)'}\\s*$`, 'gm'))];
      if (matches.length !== 1) fail('UNSUPPORTED_DISK', `VMDK must declare exactly one ${name}.`);
      return matches[0][1];
    };
    const createType = field('createType', true); const cid = field('CID'); const parentCID = field('parentCID');
    const adapter = text.match(/^\s*ddb\.adapterType\s*=\s*"([^"]+)"\s*$/m)?.[1] || null;
    if (!/^[a-f0-9]{8}$/i.test(cid) || !/^[a-f0-9]{8}$/i.test(parentCID) || !types.has(createType) || /encrypt|crypto|keySafe/i.test(text)) fail('UNSUPPORTED_DISK', 'Raw, encrypted or unsupported VMDK format.');
    const extents = [];
    for (const line of text.split(/\r?\n/)) {
      if (!/^\s*(RW|RDONLY|NOACCESS)\b/.test(line)) continue;
      const match = line.match(/^\s*RW\s+(\d+)\s+(SPARSE|FLAT)\s+"([^"\r\n]+)"(?:\s+(\d+))?\s*$/);
      if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0) fail('UNSUPPORTED_DISK', 'Unsupported VMDK extent declaration.');
      const name = match[3];
      if (path.basename(name) !== name || /[\\/:\x00-\x1f]/.test(name) || ['.', '..'].includes(name)) fail('UNSAFE_PATH', 'VMDK extents must use flat local filenames.');
      extents.push({ sectors: Number(match[1]), type: match[2], name, offset_sectors: Number(match[4] || 0) });
    }
    const capacityBytes = extents.reduce((sum, e) => sum + e.sectors * 512, 0);
    if (!extents.length || !Number.isSafeInteger(capacityBytes) || capacityBytes <= 0) fail('UNSUPPORTED_DISK', 'VMDK capacity cannot be established safely.');
    return { create_type: createType, adapter, cid, parent_cid: parentCID.toLowerCase(), has_parent_hint: /^\s*parentFileNameHint\s*=/mi.test(text), capacity_bytes: capacityBytes, extents };
  } finally { await handle.close(); }
}

export class DiskManager {
  constructor({ backend, vmFiles, space = fs.statfs } = {}) { this.backend = backend; this.vmFiles = vmFiles; this.space = space; }
  async status() {
    try {
      const beside = await this.backend.executable().catch(() => undefined);
      const executable = await findVMwareExecutable('vmware-vdiskmanager', { env: this.backend.env, beside });
      let output;
      const options = { shell: false, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8' };
      try { const r = await this.backend.execute(executable, [], options); output = [r.stdout, r.stderr].filter(Boolean).join('\n'); }
      catch (e) { output = [e.stdout, e.stderr].filter(Boolean).join('\n'); if (e.killed) output = ''; }
      if (!/Virtual Disk Manager/i.test(output || '') || !/Usage:/i.test(output)) fail('CAPABILITY_UNAVAILABLE', 'Cannot read installed disk-manager help. Check installation and permissions.');
      const supported_flags = [...output.matchAll(/^\s+(-[A-Za-z])(?:\s|$)/gm)].map(m => m[1]);
      const diskTypes = [...output.split(/Disk types:/i)[1]?.matchAll(/^\s+([0-6])\s+:\s*(.+)$/gm) || []].map(m => ({ id: m[1], description: m[2].trim() }));
      return { available: true, executable, version: output.split(/\r?\n/)[0], supported_flags, disk_types: diskTypes, operations: Object.fromEntries(Object.entries(flags).map(([op, flag]) => [op, supported_flags.includes(flag)])) };
    } catch (e) { return { available: false, code: 'CAPABILITY_UNAVAILABLE', message: e.message, action: 'Install native VMware Workstation or set VMWARE_VDISKMANAGER_PATH to its absolute executable path.' }; }
  }
  async available(operation, diskType) {
    const status = await this.status();
    if (!status.available) fail(status.code, status.message, { action: status.action });
    const required = [flags[operation], ...(['create', 'convert'].includes(operation) ? ['-t'] : []), ...(operation === 'create' ? ['-a', '-s'] : [])];
    if (required.some(flag => !status.supported_flags.includes(flag)) || (diskType && !status.disk_types.some(t => t.id === diskType))) fail('UNSUPPORTED_CAPABILITY', 'Installed disk manager does not advertise the required operation or disk type.', { operation, required_flags: required, disk_type: diskType, action: 'Inspect disk_manager_status and choose an advertised local disk type or install a supported Workstation build.' });
    return status;
  }
  async diskPath(input) {
    if (path.extname(input).toLowerCase() !== '.vmdk' || /:[^\\/]/.test(input.slice(2))) fail('UNSAFE_PATH', 'Select an absolute .vmdk file, without alternate streams.');
    return this.backend.hostPath(input, 'input-file');
  }
  async inspect(input) {
    const a = diskSchemas.disk_inspect.parse(input); const disk = await this.diskPath(a.disk);
    const descriptor = await readDiskDescriptor(disk); const files = new Map();
    for (const extent of descriptor.extents) {
      const backing = await this.backend.hostPath(path.join(path.dirname(disk), extent.name), 'input-file');
      if (!isWithin(path.dirname(disk), backing)) fail('UNSAFE_PATH', 'VMDK extent escapes the descriptor directory.');
      const stat = await fs.stat(backing);
      if (extent.type === 'FLAT' && stat.size < (extent.offset_sectors + extent.sectors) * 512) fail('UNSUPPORTED_DISK', 'Flat extent is shorter than its declared capacity.');
      files.set(key(backing), { path: backing, size_bytes: stat.size, modified_ms: stat.mtimeMs, device: stat.dev, inode: stat.ino });
    }
    const stat = await fs.stat(disk);
    files.set(key(disk), { path: disk, size_bytes: stat.size, modified_ms: stat.mtimeMs, device: stat.dev, inode: stat.ino });
    return { disk, ...descriptor, files: [...files.values()], independent: descriptor.parent_cid === 'ffffffff' && !descriptor.has_parent_hint, note: 'Descriptor inspection does not verify guest filesystem integrity. Increasing VMDK capacity does not resize guest partitions or filesystems.' };
  }
  async safeVM(input) {
    const vmx = await this.backend.vmx(input); const text = await fs.readFile(vmx, 'utf8'); const config = vmConfig(text);
    if ((await this.backend.details(vmx)).running) fail('UNSAFE_VM', 'Power off the VM before disk edits.');
    if (Object.entries(config).some(([k, v]) => (/^encryption\./.test(k) && v) || (k === 'vtpm.present' && /^true$/i.test(v)))) fail('UNSAFE_VM', 'Encrypted and vTPM VM configurations are unsupported for disk edits.');
    const dirs = new Set([path.dirname(vmx)]);
    for (const k of ['workingdir', 'snapshot.directory']) if (config[k]) dirs.add(await this.backend.hostPath(path.resolve(path.dirname(vmx), config[k]), 'directory'));
    for (const dir of dirs) if ((await fs.readdir(dir)).some(name => /\.(lck|vmss|vmem|vmsn)$/i.test(name))) fail('UNSAFE_VM', 'Locked or suspended VM detected. Fully power off and close it before disk edits.');
    if (config['checkpoint.vmstate'] || config['suspend.filename'] || (await this.backend.snapshots(vmx)).snapshots.length) fail('UNSAFE_VM', 'Snapshots or saved state prevent safe disk edits. Prepare a fully powered-off VM without snapshots.');
    // Saved snapshots may be outside the default directory; reject retained metadata too.
    for (const dir of dirs) for (const name of await fs.readdir(dir)) if (/\.vmsd$/i.test(name)) {
      const metadata = vmConfig(await fs.readFile(path.join(dir, name), 'utf8'));
      if (Number(metadata['snapshot.numsnapshots'] || 0) !== 0 || Object.keys(metadata).some(k => /^snapshot\d+\./.test(k))) fail('UNSAFE_VM', 'Snapshot metadata prevents safe disk edits.');
    }
    return { vmx, text, config };
  }
  async references(info, extra) {
    const inventory = await this.backend.listVMs();
    if (inventory.warnings.length) fail('INVENTORY_UNAVAILABLE', 'Cannot verify disk references because inventory is unavailable.', { action: 'Restore a readable VMware inventory; include relevant unregistered VMs in vmx_paths.' });
    const raw = await fs.readFile(this.backend.inventoryPath, 'utf8');
    const candidates = [...inventory.vms.map(v => v.vmx), ...extra];
    const inventoryKeys = new Set();
    for (const line of raw.split(/\r?\n/)) if (/^\s*vmlist\d+\.config\b/i.test(line)) {
      const match = line.match(/^\s*(vmlist\d+\.config)\s*=\s*".*"\s*$/i);
      if (!match || inventoryKeys.has(match[1].toLowerCase())) fail('INVENTORY_UNAVAILABLE', 'Malformed/duplicate VMware inventory prevents disk-reference checks.');
      inventoryKeys.add(match[1].toLowerCase());
      const value = parseAssignments(line)[match[1]];
      if (!value) continue;
      if (!path.isAbsolute(value) || path.extname(value).toLowerCase() !== '.vmx') fail('INVENTORY_UNAVAILABLE', 'Inventory VMX paths must be absolute.');
      candidates.push(value);
    }
    // Also inspect unregistered VMX files next to this disk.
    for (const name of await fs.readdir(path.dirname(info.disk))) if (/\.vmx$/i.test(name)) candidates.push(path.join(path.dirname(info.disk), name));
    const references = []; const seen = new Set();
    const paths = new Set(info.files.map(f => key(f.path)));
    for (const input of candidates) {
      if (!await exists(input) && !extra.includes(input)) continue;
      const vmx = await this.backend.vmx(input); if (seen.has(key(vmx))) continue; seen.add(key(vmx));
      const text = await fs.readFile(vmx, 'utf8'); const config = vmConfig(text);
      for (const [name, value] of Object.entries(config)) if (/^(scsi|sata|ide|nvme)\d+:\d+\.filename$/.test(name) && /\.vmdk$/i.test(value)) {
        const backing = await this.diskPath(path.resolve(path.dirname(vmx), value));
        if (paths.has(key(backing))) references.push({ vmx, slot: name.replace(/\.filename$/, ''), text });
        else {
          const other = await this.inspect({ disk: backing });
          if (other.files.some(f => paths.has(key(f.path))) || (!other.independent && other.parent_cid === info.cid.toLowerCase())) fail('UNSAFE_CHAIN', 'Another VM references a shared extent or dependent disk chain.');
        }
      }
    }
    return references;
  }
  async preflight(info, extra) {
    if (!info.independent || info.create_type === 'streamOptimized') fail('UNSAFE_CHAIN', 'Snapshots, linked/backing chains and stream-optimized source disks are refused. Prepare an independent Workstation disk.');
    if ((await fs.readdir(path.dirname(info.disk))).some(name => /\.(lck|vmss|vmem|vmsn)$/i.test(name))) fail('UNSAFE_DISK', 'Disk directory contains locks or saved/snapshot state.');
    for (const f of info.files) if ((await fs.stat(f.path)).nlink > 1) fail('UNSAFE_DISK', 'Hard-linked disk files are unsafe to modify.');
    // Child descriptors beside an unregistered disk must not be silently invalidated.
    for (const name of await fs.readdir(path.dirname(info.disk))) {
      if (!/\.vmdk$/i.test(name) || info.files.some(f => key(f.path) === key(path.join(path.dirname(info.disk), name)))) continue;
      let descriptor;
      try { descriptor = await readDiskDescriptor(await this.diskPath(path.join(path.dirname(info.disk), name))); }
      catch (e) { if (e.code === 'UNSUPPORTED_DISK' && /extent has no embedded|Unrecognized VMDK/.test(e.message) && /-(?:flat|[sf]\d+)\.vmdk$/i.test(name)) continue; throw e; }
      if (descriptor.parent_cid === info.cid.toLowerCase() || descriptor.has_parent_hint) fail('UNSAFE_CHAIN', 'A dependent/snapshot disk descriptor is present beside this disk.');
      for (const extent of descriptor.extents) {
        const backing = await this.backend.hostPath(path.join(path.dirname(info.disk), extent.name), 'input-file');
        if (info.files.some(f => key(f.path) === key(backing))) fail('SHARED_DISK', 'Another local descriptor references this disk or its extents.');
      }
    }
    const references = await this.references(info, extra);
    if (references.length > 1) fail('SHARED_DISK', 'Disk is referenced by multiple VM devices. Detach other references before editing.');
    for (const reference of references) await this.safeVM(reference.vmx);
    return references;
  }
  async freeSpace(directory, bytes) {
    const space = await this.space(directory); const free = Number(space.bavail) * Number(space.bsize);
    const required = Math.ceil(bytes * 1.1 + 64 * 1024 * 1024);
    if (!Number.isSafeInteger(required) || !Number.isFinite(free) || free < required) fail('INSUFFICIENT_SPACE', 'Insufficient or unknown free space for a conservative disk operation estimate.', { required_bytes: required, available_bytes: free });
  }
  async output(input) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.vmdk$/i.test(path.basename(input))) fail('UNSAFE_PATH', 'Destination needs a simple .vmdk filename.');
    const disk = await this.backend.hostPath(input, 'output-file'); const directory = path.dirname(disk);
    await this.backend.hostPath(directory, 'destination-directory');
    await this.backend.hostPath(path.dirname(directory), 'directory');
    if (await exists(directory)) fail('TARGET_EXISTS', 'Disk output requires a NEW parent directory to protect all companion extents.');
    return { disk, directory };
  }
  async run(status, args, seconds, partial) {
    try { await this.backend.execute(status.executable, args, { shell: false, windowsHide: true, timeout: seconds * 1000, maxBuffer: 1024 * 1024, encoding: 'utf8' }); }
    catch (e) { fail('DISK_OPERATION_FAILED', `Disk manager failed (${e.killed ? 'timeout' : e.code || 'execution error'}). Inspect state before retrying.`, { partial_output: partial, action: 'No automatic rollback or deletion. Inspect retained files; remove only the new output directory after confirming its contents are disposable. In-place operations may have partially changed the original.' }); }
  }
  async perform(operation, input) {
    const a = diskSchemas[`disk_${operation}`].parse(input); const status = await this.available(operation, a.disk_type);
    const output = a.destination ? await this.output(a.destination) : null;
    const original = a.disk ? await this.inspect({ disk: a.disk }) : null;
    const refs = original ? await this.references(original, a.vmx_paths) : [];
    const resources = [...(original ? [path.dirname(original.disk), ...original.files.map(f => f.path)] : []), ...refs.map(r => r.vmx), ...(output ? [output.directory] : [])];
    return this.backend.resources.use(resources, async () => {
      if (original) await this.preflight(original, a.vmx_paths);
      if (['compact', 'defragment'].includes(operation) && !sparse.has(original.create_type)) fail('UNSUPPORTED_DISK', 'Compaction and defragmentation require a growable Workstation disk.');
      const bytes = a.capacity_mb ? a.capacity_mb * 1024 * 1024 : original.capacity_bytes;
      if (operation === 'expand' && bytes <= original.capacity_bytes) fail('INVALID_CAPACITY', 'New capacity must exceed the existing virtual capacity. Shrinking is unsupported.');
      if ((a.adapter === 'buslogic' || original?.adapter === 'buslogic') && a.capacity_mb > 2040 * 1024) fail('INVALID_CAPACITY', 'BusLogic disks are limited to 2040 GiB.');
      await this.freeSpace(output ? path.dirname(output.directory) : path.dirname(original.disk), bytes);
      if (original) {
        const current = await this.inspect({ disk: original.disk });
        if (JSON.stringify(current) !== JSON.stringify(original)) fail('DISK_CHANGED', 'Disk changed during preflight; inspect and retry.');
        const currentRefs = await this.preflight(current, a.vmx_paths);
        if (JSON.stringify(currentRefs) !== JSON.stringify(refs)) fail('DISK_CHANGED', 'VM references changed during preflight; inspect and retry.');
      }
      if (output) await fs.mkdir(output.directory); // Atomic reservation; never overwrite a companion file.
      const disk = output?.disk || original.disk;
      const args = operation === 'create' ? ['-c', '-s', `${a.capacity_mb}MB`, '-a', a.adapter, '-t', a.disk_type, disk]
        : operation === 'convert' ? ['-r', original.disk, '-t', a.disk_type, disk]
          : operation === 'expand' ? ['-x', `${a.capacity_mb}MB`, disk] : [flags[operation], disk];
      await this.run(status, args, a.timeout_seconds, output?.directory || disk);
      let result;
      try { result = await this.inspect({ disk }); }
      catch { fail('OUTPUT_UNVERIFIED', 'Disk manager returned success but the result could not be inspected.', { partial_output: output?.directory || disk, action: 'Inspect retained files before retrying. Original conversion source was preserved.' }); }
      if ((operation === 'create' || operation === 'expand') && result.capacity_bytes !== bytes) fail('OUTPUT_UNVERIFIED', 'Disk manager result capacity differs from the request.', { partial_output: output?.directory || disk });
      return { operation, ...result, source_preserved: operation === 'convert' ? true : undefined, cleanup: output ? 'Output and any partial files are retained. No existing files were overwritten.' : 'In-place change; no automatic rollback.', checked_vms: refs.map(r => r.vmx), note: 'Increasing VMDK capacity does not resize guest partitions or filesystems. Reservations cover this server only; keep VMware GUIs and other disk writers closed.' };
    });
  }
  async edit(input, detach) {
    const a = diskSchemas[detach ? 'disk_detach' : 'disk_attach'].parse(input);
    const max = { scsi: 15, sata: 29, ide: 1, nvme: 14 }[a.controller];
    if (a.unit > max || (a.controller === 'scsi' && a.unit === 7) || (a.controller === 'ide' && a.controller_index > 1)) fail('INVALID_SLOT', 'Invalid controller/unit index; SCSI unit 7 is reserved.');
    const vmx = await this.backend.vmx(a.vmx); const info = await this.inspect({ disk: a.disk });
    return this.backend.resources.use([vmx, path.dirname(info.disk)], async () => {
      const vm = await this.safeVM(vmx); const prefix = `${a.controller}${a.controller_index}:${a.unit}`;
      if (await fs.stat(vmx).then(s => s.nlink > 1)) fail('UNSAFE_VM', 'Hard-linked VMX files cannot be edited safely.');
      const refs = await this.preflight(info, [...a.vmx_paths, vmx]);
      const existing = vm.config[`${prefix}.filename`];
      if (detach) {
        if (!existing || key(await this.diskPath(path.resolve(path.dirname(vmx), existing))) !== key(info.disk)) fail('SLOT_MISMATCH', 'Selected slot does not reference the expected VMDK.');
      } else {
        if (Object.keys(vm.config).some(k => k.startsWith(prefix + '.'))) fail('SLOT_OCCUPIED', 'Slot already has settings. Choose an unused slot.');
        if (refs.length) fail('SHARED_DISK', 'Disk is already referenced by a VM device. Detach it first.');
        if (a.controller !== 'ide' && !/^true$/i.test(vm.config[`${a.controller}${a.controller_index}.present`] || '')) fail('CONTROLLER_MISSING', 'Controller is not present. Create/configure the controller explicitly before attaching.');
        if (a.controller === 'scsi' && !['lsilogic', 'lsisas1068', 'pvscsi', 'buslogic'].includes(vm.config[`scsi${a.controller_index}.virtualdev`])) fail('CONTROLLER_MISSING', 'SCSI controller type is missing or unsupported.');
        const adapter = a.controller === 'ide' ? 'ide' : a.controller === 'scsi' && vm.config[`scsi${a.controller_index}.virtualdev`] === 'buslogic' ? 'buslogic' : 'lsilogic';
        if (info.adapter !== adapter) fail('ADAPTER_MISMATCH', 'Disk adapter metadata does not match the selected controller. Prepare a disk with the matching adapter before attaching.', { expected_adapter: adapter, actual_adapter: info.adapter });
      }
      const settings = detach ? Object.fromEntries(Object.keys(vm.config).filter(k => k.startsWith(prefix + '.')).map(k => [k, null]))
        : { [`${prefix}.present`]: 'TRUE', [`${prefix}.fileName`]: info.disk };
      const updated = await this.vmFiles.configure({ vmx, settings }, { expectedOriginal: vm.text, beforeCommit: async () => {
        await this.safeVM(vmx); await this.preflight(info, [...a.vmx_paths, vmx]);
        if (JSON.stringify(await this.inspect({ disk: info.disk })) !== JSON.stringify(info)) fail('DISK_CHANGED', 'Disk changed before VMX commit.');
      } });
      return { ...updated, disk: info.disk, slot: prefix, attached: !detach, disk_deleted: false, note: 'Backing VMDK and all extents are preserved. VMX backup is available at the returned path.' };
    });
  }
}
