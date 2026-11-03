import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workstation, parseAssignments } from '../src/workstation.mjs';
import { VMFiles } from '../src/vm-files.mjs';
import { HardwareManager, productCapabilities } from '../src/hardware.mjs';
import { hardwareSchemas } from '../src/hardware-schemas.mjs';
import { DiskManager } from '../src/disks.mjs';

const original = '# preserve this comment\n.encoding = "UTF-8"\nvirtualHW.version = "21"\nnumvcpus = "4"\ncpuid.coresPerSocket = "2"\nmemsize = "4096"\nfirmware = "efi"\nscsi0.present = "TRUE"\nscsi0.virtualDev = "lsilogic"\nscsi0:0.fileName = "keep.vmdk"\nethernet0.present = "TRUE"\nethernet0.virtualDev = "vmxnet3"\nethernet0.addressType = "generated"\nethernet0.generatedAddress = "00:0c:29:ab:cd:ef"\nethernet0.generatedAddressOffset = "0"\nethernet0.pciSlotNumber = "160"\nuuid.bios = "preserve-uuid"\ncustom.setting = "preserve"\n';
const id = '52 00 00 00 00 00 00 00-00 00 00 00 00 00 00 01';
const help = `VMware Virtual Disk Manager - build test\nUsage: vmware-vdiskmanager\n -c : create\n -t : type\n -a : adapter\n -s : capacity\nDisk types:\n 0 : growable\n`;

async function fixture(t, platform = process.platform) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'typed-hardware-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vmx = path.join(root, 'selected.vmx'), ext = process.platform === 'win32' ? '.exe' : '';
  const binary = path.join(root, `vmrun${ext}`), worker = path.join(root, `vmware-vmx${ext}`), disk = path.join(root, `vmware-vdiskmanager${ext}`);
  for (const file of [binary, worker, disk]) await fs.writeFile(file, '', { mode: 0o755 });
  await fs.writeFile(vmx, original);
  const calls = []; let running = false, version = 'VMware Workstation 26.0.1 build-25688693', gui = false;
  const preferences = path.join(root, 'preferences');
  await fs.writeFile(preferences, `.encoding = "UTF-8"\npref.namedPVNs.count = "1"\npref.namedPVNs0.name = "isolated"\npref.namedPVNs0.pvnID = "${id}"\n`);
  const backend = new Workstation({ env: { VMRUN_PATH: binary, VMWARE_VMX_PATH: worker, VMWARE_VDISKMANAGER_PATH: disk, VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root, VMWARE_PREFERENCES_PATH: preferences }, run: async (file, args, options) => {
    calls.push({ file, args, options }); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    if (file === worker) { assert.deepEqual(args, ['-v']); return { stdout: version }; }
    if (file === 'pwsh') { assert.equal(options.env.VMWARE_HARDWARE_VERSION_TARGET, worker); return { stdout: version }; }
    if (file === disk) {
      if (!args.length) return { stdout: help };
      const target = args.at(-1), mb = Number(args[args.indexOf('-s') + 1].replace('MB', ''));
      await fs.writeFile(target, `# Disk DescriptorFile\nversion=1\nCID=12345678\nparentCID=ffffffff\ncreateType="monolithicSparse"\nRW ${mb * 2048} SPARSE "disk.vmdk"\nddb.adapterType="lsilogic"\n`);
      return { stdout: '' };
    }
    return { stdout: `Total running VMs: ${running ? 1 : 0}${running ? '\n' + vmx : ''}` };
  } });
  const vmFiles = new VMFiles(backend), disks = new DiskManager({ backend, vmFiles, space: async () => ({ bavail: 1e12, bsize: 4096 }) });
  const manager = new HardwareManager({ backend, vmFiles, disks, platform, assertGUIClosed: async () => { if (gui) throw new Error('Close GUI'); } });
  return { root, vmx, backend, vmFiles, manager, calls, preferences, setVersion: v => { version = v; }, setRunning: v => { running = v; }, setGUI: v => { gui = v; }, config: async () => parseAssignments(await fs.readFile(vmx, 'utf8')) };
}

for (const platform of ['win32', 'linux']) test(`native ${platform} capability evidence uses metadata/version only, rejects unrecognized/future releases`, async t => {
  const f = await fixture(t, platform);
  const caps = await f.manager.capabilities(); assert.equal(caps.available, true); assert.equal(caps.maximum_hardware_version, 22); assert.equal(caps.vtpm.configurable, false);
  assert.equal(f.calls[0].file === 'pwsh', platform === 'win32');
  for (const output of ['vmrun version 1.17.0', 'VMware Workstation 27.0.0 build-123', 'VMware Fusion 26.0.0 build-123', 'VMware Workstation 16.2.0 build-123']) {
    f.setVersion(output); assert.equal((await f.manager.capabilities()).available, false);
  }
  assert.equal(productCapabilities('VMware Workstation 17.6.4 build-123').maximum_hardware_version, 21);
  assert.equal(productCapabilities('VMware Workstation 17.0.0 build-123').maximum_hardware_version, 20);
});

test('typed getter returns topology/devices without leaking unrelated VMX values or inferring defaults', async t => {
  const f = await fixture(t); const result = await f.manager.get({ vmx: f.vmx });
  assert.equal(result.sockets, 2); assert.equal(result.memory_mb, 4096); assert.equal(result.nested_virtualization, null);
  assert.equal(result.nics[0].mac, '00:0c:29:ab:cd:ef'); assert.equal(result.controllers[0].type, 'lsilogic');
  assert.equal(result.disks[0].file, 'keep.vmdk'); assert.ok(!JSON.stringify(result).includes('preserve-uuid'));
});

test('typed patches back up exact VMX, preserve devices/comments/NIC identity, and support nested ESXi topology', async t => {
  const f = await fixture(t);
  const updated = await f.manager.set({ vmx: f.vmx, confirm: true, cpus: 8, cores_per_socket: 4, memory_mb: 16384, nested_virtualization: true,
    controllers: [{ type: 'pvscsi', index: 1 }, { type: 'nvme', index: 0 }], nics: [{ index: 0, network: 'custom', vmnet: 'vmnet2' }, { index: 1, model: 'e1000e', network: 'lan_segment', segment: 'isolated' }] });
  assert.equal(await fs.readFile(updated.backup, 'utf8'), original);
  const config = await f.config();
  for (const field of ['generatedAddress', 'generatedAddressOffset', 'pciSlotNumber']) assert.equal(config[`ethernet0.${field}`], parseAssignments(original)[`ethernet0.${field}`]);
  assert.equal(config['scsi0:0.fileName'], 'keep.vmdk'); assert.equal(config['scsi1.virtualDev'], 'pvscsi'); assert.equal(config['nvme0.present'], 'TRUE');
  assert.equal(config['ethernet1.pvnID'], id); assert.equal(config['ethernet0.vnet'], 'vmnet2'); assert.equal(config['vhv.enable'], 'TRUE');
  assert.equal((await f.manager.get({ vmx: f.vmx })).sockets, 2); assert.match(await fs.readFile(f.vmx, 'utf8'), /# preserve this comment/);
});

test('explicit firmware/security and MAC changes are bounded and do not mutate TPM/encryption', async t => {
  const f = await fixture(t);
  await f.manager.set({ vmx: f.vmx, confirm: true, secure_boot: true, nics: [{ index: 0, mac: '00:50:56:01:02:03' }] });
  const config = await f.config(); assert.equal(config['uefi.secureBoot.enabled'], 'TRUE'); assert.equal(config['ethernet0.addressType'], 'static'); assert.equal(config['ethernet0.generatedAddress'], undefined);
  await assert.rejects(f.manager.set({ vmx: f.vmx, confirm: true, firmware: 'bios' }), { code: 'INCOMPATIBLE_HARDWARE' });
  for (const vtpm of [true, false]) await assert.rejects(f.manager.set({ vmx: f.vmx, confirm: true, vtpm }), { code: 'UNSUPPORTED_CAPABILITY' });
  await f.manager.set({ vmx: f.vmx, confirm: true, firmware: 'bios', secure_boot: false });
  assert.equal((await f.config()).firmware, 'bios');
});

test('invalid topology, occupied controllers, NIC replacement, network ambiguity and duplicates fail before edits', async t => {
  const f = await fixture(t);
  for (const change of [
    { cpus: 3 }, { controllers: [{ type: 'pvscsi', index: 0 }] },
    { nics: [{ index: 0, model: 'e1000' }] }, { nics: [{ index: 1 }, { index: 1 }] },
    { nics: [{ index: 1, network: 'custom' }] }, { nics: [{ index: 1, segment: 'isolated' }] },
    { nics: [{ index: 1, network: 'lan_segment', segment: 'missing' }] },
    { nics: [{ index: 1, mac: '00:50:56:01:02:03' }, { index: 2, mac: '00:50:56:01:02:03' }] },
    { controllers: [{ type: 'lsilogic', index: 1 }, { type: 'pvscsi', index: 1 }] },
  ]) await assert.rejects(f.manager.set({ vmx: f.vmx, confirm: true, ...change }));
  assert.equal(await fs.readFile(f.vmx, 'utf8'), original);
});

test('power, GUI, lock/suspend/encryption, malformed and hard-linked files block edits', async t => {
  const f = await fixture(t), input = { vmx: f.vmx, confirm: true, memory_mb: 8192 };
  f.setRunning(true); await assert.rejects(f.manager.set(input), { code: 'VM_RUNNING' }); f.setRunning(false);
  f.setGUI(true); await assert.rejects(f.manager.set(input), /Close GUI/); f.setGUI(false);
  for (const name of ['selected.vmx.lck', 'saved.vmss', 'saved.vmem']) {
    const file = path.join(f.root, name); await fs.writeFile(file, ''); await assert.rejects(f.manager.set(input)); await fs.unlink(file);
  }
  for (const extra of ['encryption.keySafe = "secret"', 'vtpm.present = "TRUE"', 'checkpoint.vmState = "missing.vmss"', 'MEMSIZE = "2048"', 'broken line', '.encoding = "windows-1252"']) {
    await fs.writeFile(f.vmx, original + extra + '\n'); await assert.rejects(f.manager.set(input));
  }
  await fs.writeFile(f.vmx, original); const other = path.join(f.root, 'other'); await fs.mkdir(other); await fs.writeFile(path.join(other, 'saved.vmss'), '');
  await fs.appendFile(f.vmx, 'workingDir = "other"\n'); await assert.rejects(f.manager.set(input), { code: 'VM_LOCKED_OR_SUSPENDED' });
  await fs.writeFile(f.vmx, original); await fs.link(f.vmx, path.join(f.root, 'alias.vmx')); await assert.rejects(f.manager.set(input), { code: 'UNSAFE_VM' });
});

test('detects concurrent VMX, catalog, power and capability changes without replacing the VMX', async t => {
  const f = await fixture(t); const configure = f.vmFiles.configure.bind(f.vmFiles);
  const input = { vmx: f.vmx, confirm: true, cpus: 8 };
  f.vmFiles.configure = async (...args) => { await fs.appendFile(f.vmx, 'external.setting = "keep"\n'); return configure(...args); };
  await assert.rejects(f.manager.set(input), /changed before editing/);
  f.vmFiles.configure = async (...args) => { f.setRunning(true); return configure(...args); };
  await assert.rejects(f.manager.set(input)); f.setRunning(false);
  f.vmFiles.configure = async (...args) => { f.setVersion('VMware Workstation 17.6.4 build-123'); return configure(...args); };
  await assert.rejects(f.manager.set(input), { code: 'CAPABILITY_CHANGED' }); f.setVersion('VMware Workstation 26.0.1 build-25688693');
  f.vmFiles.configure = async (...args) => { await fs.appendFile(f.preferences, '# external change\n'); return configure(...args); };
  await assert.rejects(f.manager.set({ ...input, nics: [{ index: 1, network: 'lan_segment', segment: 'isolated' }] }), /changed concurrently/);
  assert.equal((await f.config()).numvcpus, '4');
});

test('declarative nested ESXi VM creates multiple controllers, sparse disks, isolated NICs and collision-free ISO', async t => {
  const f = await fixture(t), iso = path.join(f.root, 'test.iso'); await fs.writeFile(iso, 'test media');
  const result = await f.manager.create({ directory: path.join(f.root, 'nested-esxi'), name: 'Nested ESXi', guest_os: 'vmkernel8', cpus: 4, cores_per_socket: 2, memory_mb: 8192,
    hardware_version: 21, firmware: 'efi', nested_virtualization: true, secure_boot: false, timeout_seconds: 30, iso_path: iso,
    controllers: [{ type: 'lsilogic', index: 0 }, { type: 'pvscsi', index: 1 }, { type: 'sata', index: 0 }, { type: 'nvme', index: 0 }],
    disks: [{ controller: 'scsi', controller_index: 0, unit: 0, capacity_mb: 1 }, { controller: 'scsi', controller_index: 1, unit: 1, capacity_mb: 2 }, { controller: 'sata', controller_index: 0, unit: 0, capacity_mb: 3 }, { controller: 'nvme', controller_index: 0, unit: 0, capacity_mb: 4 }],
    nics: [{ index: 0, model: 'vmxnet3', network: 'lan_segment', segment: id }, { index: 1, model: 'e1000e', network: 'lan_segment', segment: 'isolated', mac: '00:50:56:01:02:03' }] });
  const got = await f.manager.get({ vmx: result.vmx }); assert.equal(got.disks.length, 4); assert.equal(got.controllers.length, 4); assert.equal(got.nics.length, 2); assert.equal(got.sockets, 2);
  const config = parseAssignments(await fs.readFile(result.vmx, 'utf8')); assert.equal(config['sata0:1.filename'], iso); assert.match(config['sata0:0.filename'], /disk-2/);
  assert.equal(result.poweredOn, false); assert.equal(result.registered, false);
  assert.ok(!f.calls.some(c => c.args.includes('start'))); assert.equal((await f.config()).numvcpus, '4');
});

test('typed create rejects impossible layouts and unsafe roots without creating output directories', async t => {
  const f = await fixture(t), directory = path.join(f.root, 'invalid');
  const base = { directory, name: 'bad', guest_os: 'otherlinux-64', cpus: 2, memory_mb: 2048, disk_gb: 1, hardware_version: 21, firmware: 'bios', network: 'none', timeout_seconds: 30, nics: [] };
  for (const change of [
    { hardware_version: 99 }, { cpus: 64 }, { cores_per_socket: 3 }, { secure_boot: true }, { vtpm: true },
    { controllers: [{ type: 'nvme', index: 0 }] },
    { disks: [{ controller: 'scsi', controller_index: 0, unit: 7, capacity_mb: 1 }] },
    { disks: [{ controller: 'scsi', controller_index: 0, unit: 0, capacity_mb: 1 }, { controller: 'scsi', controller_index: 0, unit: 0, capacity_mb: 1 }] },
  ]) { await assert.rejects(f.manager.create({ ...base, ...change })); await assert.rejects(fs.stat(directory), { code: 'ENOENT' }); }
  const allowed = path.join(f.root, 'allowed'); await fs.mkdir(allowed); f.backend.env.VMWARE_ALLOWED_HOST_ROOTS = allowed;
  await assert.rejects(f.manager.create(base), /outside/); await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('typed schemas require explicit confirmation, bounds and known fields', () => {
  const schema = hardwareSchemas.vm_hardware_set;
  for (const input of [{ vmx: '/v.vmx', cpus: 2 }, { vmx: '/v.vmx', confirm: false, cpus: 2 }, { vmx: '/v.vmx', confirm: true }, { vmx: '/v.vmx', confirm: true, cpus: 33 }, { vmx: '/v.vmx', confirm: true, raw: {} }, { vmx: '/v.vmx', confirm: true, nics: [{ index: 10 }] }, { vmx: '/v.vmx', confirm: true, nics: [{ index: 0, mac: 'ff:ff:ff:ff:ff:ff' }] }]) assert.equal(schema.safeParse(input).success, false);
});

test('typed creation dispatch applies defaults and partial disk failures retain only disposable output', async t => {
  const f = await fixture(t), directory = path.join(f.root, 'typed-defaults');
  const created = await f.vmFiles.create({ directory, name: 'typed defaults', nics: [], disks: [{ controller: 'scsi', controller_index: 0, unit: 0, capacity_mb: 1 }] });
  const got = await f.manager.get({ vmx: created.vmx }); assert.equal(got.cpus, 2); assert.equal(got.memory_mb, 2048); assert.equal(got.nics.length, 0); assert.equal(got.controllers[0].type, 'lsilogic');
  const perform = f.manager.disks.perform.bind(f.manager.disks); let count = 0;
  f.manager.disks.perform = async (...args) => { if (++count === 2) throw Object.assign(new Error('test failure'), { code: 'DISK_OPERATION_FAILED' }); return perform(...args); };
  const failed = path.join(f.root, 'partial');
  await assert.rejects(f.manager.create({ directory: failed, name: 'partial', guest_os: 'otherlinux-64', cpus: 2, memory_mb: 2048, hardware_version: 21, firmware: 'bios', timeout_seconds: 30, nics: [],
    disks: [{ controller: 'scsi', controller_index: 0, unit: 0, capacity_mb: 1 }, { controller: 'scsi', controller_index: 0, unit: 1, capacity_mb: 1 }] }), { code: 'DISK_OPERATION_FAILED' });
  await fs.access(path.join(failed, 'disk-0', 'disk.vmdk')); await assert.rejects(fs.stat(path.join(failed, 'machine.vmx')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(f.vmx, 'utf8'), original);
});

test('resource conflicts and invalid PCIe roots cannot overwrite an existing device', async t => {
  const f = await fixture(t); let entered; const ready = new Promise(resolve => { entered = resolve; }); let release;
  const hold = f.backend.resources.use([f.vmx], async () => { entered(); await new Promise(resolve => { release = resolve; }); }); await ready;
  try { await assert.rejects(f.manager.set({ vmx: f.vmx, confirm: true, cpus: 8 }), { code: 'RESOURCE_BUSY' }); } finally { release(); await hold; }
  await fs.appendFile(f.vmx, 'pciBridge4.present = "FALSE"\n');
  await assert.rejects(f.manager.set({ vmx: f.vmx, confirm: true, controllers: [{ type: 'nvme', index: 0 }] }), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.equal((await f.config())['pciBridge4.present'], 'FALSE');
});
