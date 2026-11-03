import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workstation, parseAssignments } from '../src/workstation.mjs';
import { VMFiles } from '../src/vm-files.mjs';
import { DiskManager, diskSchemas, readDiskDescriptor } from '../src/disks.mjs';
import { RestClient, restOperations } from '../src/rest.mjs';

const help = `VMware Virtual Disk Manager - build test.
Usage: vmware-vdiskmanager OPTIONS <disk-name>
 -c : create disk
 -r <source> : convert
 -x <capacity> : expand
 -k : shrink
 -d : defragment
 -a <adapter> : adapter
 -s <size> : capacity
 -t <type> : disk type
Disk types:
 0 : single growable
 1 : split growable
 2 : preallocated
 3 : split preallocated
 5 : streaming
`;
const descriptor = (name = 'disk.vmdk', mb = 1, type = 'monolithicSparse', parent = 'ffffffff') => `# Disk DescriptorFile
version=1
CID=12345678
parentCID=${parent}
createType="${type}"
RW ${mb * 2048} SPARSE "${name}"
ddb.adapterType = "lsilogic"
`;
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-disks-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binary = path.join(root, process.platform === 'win32' ? 'vmrun.exe' : 'vmrun');
  const diskManager = path.join(root, process.platform === 'win32' ? 'vmware-vdiskmanager.exe' : 'vmware-vdiskmanager');
  const inventory = path.join(root, 'inventory.vmls');
  await Promise.all([fs.writeFile(binary, '', { mode: 0o755 }), fs.writeFile(diskManager, '', { mode: 0o755 }), fs.writeFile(inventory, '')]);
  const directory = path.join(root, 'source'); await fs.mkdir(directory);
  const disk = path.join(directory, 'disk.vmdk'); await fs.writeFile(disk, descriptor());
  const vmx = path.join(directory, 'machine.vmx');
  const originalVM = '.encoding = "UTF-8"\nscsi0.present = "TRUE"\nscsi0.virtualDev = "lsilogic"\n';
  await fs.writeFile(vmx, originalVM);
  const calls = []; let running = []; let snapshots = []; let currentHelp = help; let intercept;
  const backend = new Workstation({ env: { VMRUN_PATH: binary, VMWARE_VDISKMANAGER_PATH: diskManager, VMWARE_INVENTORY_PATH: inventory, VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root }, run: async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === diskManager) {
      if (!args.length) return { stdout: currentHelp };
      if (intercept) await intercept(args);
      const target = args.at(-1);
      const mb = args[0] === '-r' ? (await readDiskDescriptor(args[1])).capacity_bytes / 1048576 : args[0] === '-c' || args[0] === '-x' ? Number(args[args.indexOf(args[0] === '-c' ? '-s' : '-x') + 1].replace(/MB$/, '')) : null;
      if (mb) await fs.writeFile(target, descriptor(path.basename(target), mb, args.includes('-t') && args[args.indexOf('-t') + 1] === '5' ? 'streamOptimized' : 'monolithicSparse'));
      return { stdout: 'done' };
    }
    const operation = args[2];
    if (operation === 'listSnapshots') return { stdout: `Total snapshots: ${snapshots.length}\n${snapshots.join('\n')}` };
    return { stdout: `Total running VMs: ${running.length}\n${running.join('\n')}` };
  } });
  const vmFiles = new VMFiles(backend); const disks = new DiskManager({ backend, vmFiles, space: async () => ({ bavail: 1e12, bsize: 4096 }) });
  return { root, directory, disk, vmx, originalVM, backend, vmFiles, disks, calls, inventory, diskManager,
    setRunning: value => { running = value; }, setSnapshots: value => { snapshots = value; }, setHelp: value => { currentHelp = value; }, intercept: value => { intercept = value; },
    attach: async () => fs.writeFile(vmx, originalVM + 'scsi0:0.present = "TRUE"\nscsi0:0.fileName = "disk.vmdk"\n') };
}
const nativeCalls = f => f.calls.filter(c => c.file === f.diskManager && c.args.length);

test('disk output directories honor host-file roots independently of VMX roots', async t => {
  const f = await fixture(t);
  const storage = path.join(f.root, 'disk-storage'); await fs.mkdir(storage);
  f.backend.env.VMWARE_ALLOWED_ROOTS = f.directory;
  f.backend.env.VMWARE_ALLOWED_HOST_ROOTS = storage;
  const disk = path.join(storage, 'created', 'data.vmdk');
  await f.disks.perform('create', { destination: disk, capacity_mb: 1 });
  const converted = path.join(storage, 'converted', 'data.vmdk');
  await f.disks.perform('convert', { disk, destination: converted, confirm: true });
  await fs.access(converted);
  for (const operation of ['create', 'convert']) {
    const destination = path.join(f.directory, `forbidden-${operation}`, 'disk.vmdk');
    const args = operation === 'create' ? { destination, capacity_mb: 1 } : { destination, disk, confirm: true };
    await assert.rejects(f.disks.perform(operation, args), /outside the configured allowed roots/);
    await assert.rejects(fs.stat(path.dirname(destination)), { code: 'ENOENT' });
  }
  const occupied = path.join(storage, 'occupied'); await fs.writeFile(occupied, 'retained file');
  await assert.rejects(f.disks.perform('create', { destination: path.join(occupied, 'disk.vmdk'), capacity_mb: 1 }), /directory|ENOTDIR/);
  if (process.platform !== 'win32') {
    await fs.symlink(f.directory, path.join(storage, 'escape'));
    await assert.rejects(f.disks.perform('create', { destination: path.join(storage, 'escape', 'new', 'disk.vmdk'), capacity_mb: 1 }), /outside/);
  }
});

test('runtime help parses exact case-sensitive flags and advertised types; missing/unsupported capabilities are actionable', async t => {
  const f = await fixture(t); const status = await f.disks.status();
  assert.equal(status.available, true); assert.equal(status.operations.convert, true); assert.ok(status.disk_types.some(t => t.id === '3'));
  f.setHelp(help.replace(' -r <source> : convert', ' -R : repair'));
  await assert.rejects(f.disks.perform('convert', { disk: f.disk, destination: path.join(f.root, 'new', 'disk.vmdk'), confirm: true }), e => e.code === 'UNSUPPORTED_CAPABILITY' && e.details.required_flags.includes('-r'));
  assert.equal(nativeCalls(f).length, 0);
  f.backend.env.VMWARE_VDISKMANAGER_PATH = path.join(f.root, 'missing', path.basename(f.diskManager));
  assert.equal((await f.disks.status()).available, false);
  await assert.rejects(f.disks.perform('expand', { disk: f.disk, capacity_mb: 2, confirm: true }), { code: 'CAPABILITY_UNAVAILABLE' });
});

test('inspect reads text and embedded sparse descriptors without scanning guest data', async t => {
  const f = await fixture(t); const info = await f.disks.inspect({ disk: f.disk });
  assert.equal(info.capacity_bytes, 1048576); assert.equal(info.independent, true);
  const metadata = Buffer.from(descriptor()); const binary = Buffer.alloc(2048); binary.write('KDMV'); binary.writeBigUInt64LE(1n, 28); binary.writeBigUInt64LE(2n, 36); metadata.copy(binary, 512);
  await fs.writeFile(f.disk, binary);
  assert.equal((await f.disks.inspect({ disk: f.disk })).capacity_bytes, 1048576);
  binary.writeBigUInt64LE(10000000000000000n, 28); await fs.writeFile(f.disk, binary);
  await assert.rejects(f.disks.inspect({ disk: f.disk }), { code: 'UNSUPPORTED_DISK' });
  await fs.writeFile(f.disk, 'guest data ' + descriptor());
  await assert.rejects(f.disks.inspect({ disk: f.disk }), /Unrecognized/);
});

test('create, expand, convert, compact and defragment use shell-free documented argv and preserve conversion source', async t => {
  const f = await fixture(t); const destination = path.join(f.root, 'created', 'new.vmdk');
  const created = await f.disks.perform('create', { destination, capacity_mb: 1, disk_type: '1' });
  assert.equal(created.capacity_bytes, 1048576);
  assert.deepEqual(nativeCalls(f)[0].args, ['-c', '-s', '1MB', '-a', 'lsilogic', '-t', '1', destination]);
  await f.attach();
  const expanded = await f.disks.perform('expand', { disk: f.disk, capacity_mb: 2, confirm: true });
  assert.equal(expanded.capacity_bytes, 2097152); assert.deepEqual(expanded.checked_vms, [f.vmx]);
  const before = await fs.readFile(f.disk);
  const output = path.join(f.root, 'converted', 'new.vmdk');
  const converted = await f.disks.perform('convert', { disk: f.disk, destination: output, disk_type: '5', confirm: true });
  assert.equal(converted.source_preserved, true); assert.equal(converted.create_type, 'streamOptimized');
  assert.deepEqual(await fs.readFile(f.disk), before);
  await f.disks.perform('compact', { disk: f.disk, confirm: true });
  await f.disks.perform('defragment', { disk: f.disk, confirm: true });
  assert.deepEqual(nativeCalls(f).slice(1).map(c => c.args), [['-x', '2MB', f.disk], ['-r', f.disk, '-t', '5', output], ['-k', f.disk], ['-d', f.disk]]);
  for (const c of nativeCalls(f)) { assert.equal(c.options.shell, false); assert.equal(c.options.windowsHide, true); }
});

test('all local create/convert types are passed only when advertised', async t => {
  const f = await fixture(t);
  for (const type of ['0', '1', '2', '3']) {
    await f.disks.perform('create', { destination: path.join(f.root, `type-${type}`, 'disk.vmdk'), capacity_mb: 1, disk_type: type });
    await f.disks.perform('convert', { disk: f.disk, destination: path.join(f.root, `convert-${type}`, 'disk.vmdk'), disk_type: type, confirm: true });
  }
  f.setHelp(help.replace(' 3 : split preallocated\n', ''));
  await assert.rejects(f.disks.perform('create', { destination: path.join(f.root, 'unsupported', 'disk.vmdk'), capacity_mb: 1, disk_type: '3' }), { code: 'UNSUPPORTED_CAPABILITY' });
});

test('new output directory prevents existing descriptor and companion overwrite, including after partial failure', async t => {
  const f = await fixture(t); const original = await fs.readFile(f.disk);
  await assert.rejects(f.disks.perform('create', { destination: path.join(f.directory, 'other.vmdk'), capacity_mb: 1 }), { code: 'TARGET_EXISTS' });
  await assert.rejects(f.disks.perform('convert', { disk: f.disk, destination: f.disk, confirm: true }), /exists/);
  const destination = path.join(f.root, 'partial', 'disk.vmdk');
  f.intercept(async args => { await fs.writeFile(args.at(-1), 'partial'); throw Object.assign(new Error('secret output must not escape'), { code: 1, stderr: 'secret output' }); });
  await assert.rejects(f.disks.perform('convert', { disk: f.disk, destination, confirm: true }), e => e.code === 'DISK_OPERATION_FAILED' && e.details.partial_output === path.dirname(destination) && !e.message.includes('secret'));
  assert.equal(await fs.readFile(destination, 'utf8'), 'partial'); assert.deepEqual(await fs.readFile(f.disk), original);
  await assert.rejects(f.disks.perform('convert', { disk: f.disk, destination, confirm: true }), /exists/);
});

test('input schemas require explicit confirmation and reject arbitrary flags and invalid capacities', () => {
  for (const name of ['disk_expand', 'disk_convert', 'disk_compact', 'disk_defragment', 'disk_attach', 'disk_detach']) assert.equal(diskSchemas[name].safeParse({ disk: '/tmp/disk.vmdk' }).success, false);
  assert.equal(diskSchemas.disk_create.safeParse({ destination: '/tmp/new/disk.vmdk', capacity_mb: 0 }).success, false);
  assert.equal(diskSchemas.disk_create.safeParse({ destination: '/tmp/new/disk.vmdk', capacity_mb: 1, disk_type: '4' }).success, false);
  assert.equal(diskSchemas.disk_create.safeParse({ destination: '/tmp/new/disk.vmdk', capacity_mb: 1, flags: '-R' }).success, false);
});

test('paths, extent traversal, raw types, incomplete flat extents and allowed roots fail before execution', async t => {
  const f = await fixture(t);
  await assert.rejects(f.disks.inspect({ disk: 'relative.vmdk' }), /absolute/);
  const allowed = path.join(f.root, 'allowed'); await fs.mkdir(allowed); f.backend.env.VMWARE_ALLOWED_HOST_ROOTS = allowed;
  await assert.rejects(f.disks.inspect({ disk: f.disk }), /outside/); f.backend.env.VMWARE_ALLOWED_HOST_ROOTS = f.root;
  for (const text of [descriptor('../escape.vmdk'), descriptor('disk.vmdk', 1, 'fullDevice'), descriptor().replace('SPARSE', 'FLAT'), descriptor() + 'CID=23456789\n']) {
    await fs.writeFile(f.disk, text); await assert.rejects(f.disks.inspect({ disk: f.disk }), /flat local|unsupported|shorter|exactly one/i);
  }
  assert.equal(nativeCalls(f).length, 0);
});

test('snapshot, linked-parent and child-descriptor constraints protect original disks', async t => {
  const f = await fixture(t);
  for (const text of [descriptor('disk.vmdk', 1, 'monolithicSparse', '11111111'), descriptor() + 'parentFileNameHint="parent.vmdk"\n', descriptor('disk.vmdk', 1, 'streamOptimized')]) {
    await fs.writeFile(f.disk, text);
    await assert.rejects(f.disks.perform('expand', { disk: f.disk, capacity_mb: 2, confirm: true }), { code: 'UNSAFE_CHAIN' });
  }
  await fs.writeFile(f.disk, descriptor());
  await fs.writeFile(path.join(f.directory, 'child.vmdk'), descriptor('child.vmdk', 1, 'monolithicSparse', '12345678'));
  await assert.rejects(f.disks.perform('expand', { disk: f.disk, capacity_mb: 2, confirm: true }), { code: 'UNSAFE_CHAIN' });
  assert.equal(nativeCalls(f).length, 0);
});

test('running, locked, suspended, encrypted and snapshot VM references block disk mutations', async t => {
  const f = await fixture(t); await f.attach();
  f.setRunning([f.vmx]); await assert.rejects(f.disks.perform('expand', { disk: f.disk, capacity_mb: 2, confirm: true }), /Power off/); f.setRunning([]);
  f.setSnapshots(['saved']); await assert.rejects(f.disks.perform('compact', { disk: f.disk, confirm: true }), /Snapshots/); f.setSnapshots([]);
  for (const extension of ['lck', 'vmss', 'vmem', 'vmsn']) {
    const state = path.join(f.directory, `state.${extension}`); await fs.writeFile(state, 'state');
    await assert.rejects(f.disks.perform('compact', { disk: f.disk, confirm: true }), /locks|saved|suspended/i); await fs.unlink(state);
  }
  for (const setting of ['checkpoint.vmState = "outside.vmss"', 'encryption.keySafe = "encrypted"', 'vtpm.present = "TRUE"']) {
    await f.attach(); await fs.appendFile(f.vmx, setting + '\n');
    await assert.rejects(f.disks.perform('compact', { disk: f.disk, confirm: true }), /Snapshots|Encrypted/);
  }
  assert.equal(nativeCalls(f).length, 0);
});

test('registered external VM references, duplicate slots, shared extents and absent inventory fail closed', async t => {
  const f = await fixture(t); await f.attach();
  const otherDir = path.join(f.root, 'external'); await fs.mkdir(otherDir); const otherVM = path.join(otherDir, 'other.vmx');
  await fs.writeFile(otherVM, f.originalVM + `scsi0:0.fileName = "${f.disk.replaceAll('\\', '/')}"\n`);
  await fs.writeFile(f.inventory, `vmlist0.config = "${otherVM.replaceAll('\\', '/')}"\n`);
  await assert.rejects(f.disks.perform('compact', { disk: f.disk, confirm: true }), { code: 'SHARED_DISK' });
  await fs.writeFile(f.inventory, `VMLIST0.CONFIG = "${otherVM.replaceAll('\\', '/')}"\n`);
  await assert.rejects(f.disks.perform('compact', { disk: f.disk, confirm: true }), { code: 'SHARED_DISK' });
  await fs.writeFile(f.inventory, ''); await fs.appendFile(f.vmx, 'scsi0:1.fileName = "disk.vmdk"\n');
  await assert.rejects(f.disks.perform('compact', { disk: f.disk, confirm: true }), { code: 'SHARED_DISK' });
  await f.attach(); await fs.unlink(f.inventory);
  await assert.rejects(f.disks.perform('compact', { disk: f.disk, confirm: true }), { code: 'INVENTORY_UNAVAILABLE' });
  assert.equal(nativeCalls(f).length, 0);
});

test('attach/detach backs up VMX, checks explicit slot/expected backing and never deletes disk', async t => {
  const f = await fixture(t); const original = await fs.readFile(f.disk); const args = { vmx: f.vmx, disk: f.disk, controller: 'scsi', controller_index: 0, unit: 2, confirm: true };
  const attached = await f.disks.edit(args, false);
  assert.equal(await fs.readFile(attached.backup, 'utf8'), f.originalVM);
  assert.equal(parseAssignments(await fs.readFile(f.vmx, 'utf8'))['scsi0:2.fileName'], f.disk);
  await assert.rejects(f.disks.edit(args, false), { code: 'SLOT_OCCUPIED' });
  await assert.rejects(f.disks.edit({ ...args, unit: 3 }, true), { code: 'SLOT_MISMATCH' });
  const detached = await f.disks.edit(args, true);
  assert.equal(detached.disk_deleted, false); assert.deepEqual(await fs.readFile(f.disk), original);
  assert.equal(parseAssignments(await fs.readFile(f.vmx, 'utf8'))['scsi0:2.fileName'], undefined);
  assert.match(await fs.readFile(detached.backup, 'utf8'), /scsi0:2/);
});

test('slot bounds, absent controller and stale slot settings are rejected', async t => {
  const f = await fixture(t); const args = { vmx: f.vmx, disk: f.disk, controller: 'scsi', controller_index: 0, unit: 7, confirm: true };
  await assert.rejects(f.disks.edit(args, false), { code: 'INVALID_SLOT' });
  await assert.rejects(f.disks.edit({ ...args, controller: 'ide', controller_index: 2, unit: 0 }, false), { code: 'INVALID_SLOT' });
  await assert.rejects(f.disks.edit({ ...args, controller: 'nvme', unit: 0 }, false), { code: 'CONTROLLER_MISSING' });
  await assert.rejects(f.disks.edit({ ...args, controller: 'ide', unit: 0 }, false), { code: 'ADAPTER_MISMATCH' });
  await fs.appendFile(f.vmx, 'scsi0:0.deviceType = "cdrom-image"\n');
  await assert.rejects(f.disks.edit({ ...args, unit: 0 }, false), { code: 'SLOT_OCCUPIED' });
});

test('conservative space checks and expand-only capacity check run before disk writes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.disks.perform('expand', { disk: f.disk, capacity_mb: 1, confirm: true }), { code: 'INVALID_CAPACITY' });
  f.disks.space = async () => ({ bavail: 1, bsize: 1 });
  const destination = path.join(f.root, 'no-space', 'disk.vmdk');
  await assert.rejects(f.disks.perform('create', { destination, capacity_mb: 1 }), { code: 'INSUFFICIENT_SPACE' });
  await assert.rejects(fs.stat(path.dirname(destination)), { code: 'ENOENT' });
  assert.equal(nativeCalls(f).length, 0);
});

test('same-VM conflicts cannot race; unrelated VM operations continue; reservations release on failure', async t => {
  const f = await fixture(t); await f.attach();
  let release; let started;
  const entered = new Promise(resolve => { started = resolve; });
  f.intercept(async () => { started(); await new Promise(resolve => { release = resolve; }); });
  const operation = f.disks.perform('expand', { disk: f.disk, capacity_mb: 2, confirm: true }); await entered;
  await assert.rejects(f.disks.perform('compact', { disk: f.disk, confirm: true }), { code: 'RESOURCE_BUSY' });
  await assert.rejects(f.vmFiles.configure({ vmx: f.vmx, settings: { memsize: '512' } }), { code: 'RESOURCE_BUSY' });
  await assert.rejects(f.backend.power(f.vmx, 'start'), { code: 'RESOURCE_BUSY' });
  await assert.rejects(f.backend.snapshot(f.vmx, 'snapshot', 'saved'), { code: 'RESOURCE_BUSY' });
  const other = path.join(f.root, 'other.vmx'); await fs.writeFile(other, '');
  assert.equal((await f.backend.power(other, 'start')).commandSucceeded, true);
  await f.vmFiles.configure({ vmx: other, settings: { memsize: '512' } });
  release(); await operation; assert.equal(f.backend.resources.active.size, 0);
  f.intercept(() => { throw new Error('failed'); });
  await assert.rejects(f.disks.perform('compact', { disk: f.disk, confirm: true }), { code: 'DISK_OPERATION_FAILED' });
  assert.equal(f.backend.resources.active.size, 0);
});

test('coordinated REST VM mutation refuses an active disk edit and holds reservation through HTTP completion', async t => {
  const f = await fixture(t); let release; let started;
  const entered = new Promise(resolve => { started = resolve; });
  const client = new RestClient({ backend: f.backend, coordinateDiskEdits: true });
  client.request = async (method) => method === 'GET' ? { data: [{ id: 'vm', path: f.vmx }] } : (started(), await new Promise(resolve => { release = () => resolve({ status: 200 }); }));
  const op = restOperations.find(o => o.id === 'changePowerState');
  assert.ok(op);
  const request = client.execute(op, { id: 'vm', operation: 'on' }); await entered;
  await assert.rejects(f.backend.resources.use([f.vmx], async () => {}), { code: 'RESOURCE_BUSY' });
  release(); await request;
  const gate = Promise.withResolvers(); const held = Promise.withResolvers();
  const reservation = f.backend.resources.use([f.vmx], async () => { held.resolve(); await gate.promise; });
  await held.promise;
  await assert.rejects(client.execute(op, { id: 'vm', operation: 'on' }), { code: 'RESOURCE_BUSY' });
  gate.resolve(); await reservation;
});

test('canonical symlink escapes and hard-linked backing files are refused', async t => {
  const f = await fixture(t);
  const linked = path.join(f.root, 'hardlink.vmdk'); await fs.link(f.disk, linked);
  await assert.rejects(f.disks.perform('compact', { disk: f.disk, confirm: true }), /Hard-linked/);
  if (process.platform === 'win32') return; // Native symlink creation may need privilege on Windows.
  const dir = path.join(f.root, 'allowed'); await fs.mkdir(dir);
  await fs.symlink(f.disk, path.join(dir, 'outside.vmdk'));
  f.backend.env.VMWARE_ALLOWED_HOST_ROOTS = dir;
  await assert.rejects(f.disks.inspect({ disk: path.join(dir, 'outside.vmdk') }), /outside/);
});

test('sibling descriptors sharing an extent and retained snapshot metadata are refused', async t => {
  const f = await fixture(t);
  const other = path.join(f.directory, 'other.vmdk'); await fs.writeFile(other, descriptor('disk.vmdk'));
  await assert.rejects(f.disks.perform('compact', { disk: f.disk, confirm: true }), { code: 'SHARED_DISK' });
  await fs.unlink(other); await f.attach();
  await fs.writeFile(path.join(f.directory, 'machine.vmsd'), 'snapshot.numSnapshots = "1"\n');
  await assert.rejects(f.disks.perform('compact', { disk: f.disk, confirm: true }), /Snapshot metadata/);
  assert.equal(nativeCalls(f).length, 0);
});

test('separate registered descriptor sharing a source extent is refused', async t => {
  const f = await fixture(t);
  const second = path.join(f.directory, 'second.vmdk'); await fs.writeFile(second, descriptor('disk.vmdk'));
  const other = path.join(f.root, 'other.vmx');
  await fs.writeFile(other, `scsi0:0.fileName = "${second.replaceAll('\\', '/')}"\n`);
  await fs.writeFile(f.inventory, `vmlist0.config = "${other.replaceAll('\\', '/')}"\n`);
  await assert.rejects(f.disks.perform('compact', { disk: f.disk, confirm: true }), { code: 'UNSAFE_CHAIN' });
});

test('remote REST origins retain their prior request contract without local VMX resolution', async t => {
  const f = await fixture(t); const requests = [];
  const client = new RestClient({ env: { VMWARE_REST_URL: 'https://example.invalid' }, backend: f.backend, coordinateDiskEdits: true });
  client.request = async (method, route) => { requests.push({ method, route }); return { status: 200 }; };
  await client.execute(restOperations.find(o => o.id === 'changePowerState'), { id: 'remote-vm', operation: 'on' });
  assert.deepEqual(requests, [{ method: 'PUT', route: '/api/vms/remote-vm/power' }]);
});

test('VMX replacement rechecks disk state and retains the original on an external disk change', async t => {
  const f = await fixture(t); const originalConfigure = f.vmFiles.configure.bind(f.vmFiles);
  f.vmFiles.configure = async (input, options) => {
    await fs.writeFile(f.disk, descriptor('disk.vmdk', 2));
    return originalConfigure(input, options);
  };
  await assert.rejects(f.disks.edit({ vmx: f.vmx, disk: f.disk, controller: 'scsi', controller_index: 0, unit: 1, confirm: true }, false), { code: 'DISK_CHANGED' });
  assert.equal(await fs.readFile(f.vmx, 'utf8'), f.originalVM);
});

test('attach captures the VMX baseline after native snapshot discovery normalizes it', async t => {
  const f = await fixture(t); let normalized = false;
  f.backend.snapshots = async () => {
    if (!normalized) { normalized = true; await fs.writeFile(f.vmx, (f.originalVM + 'extendedConfigFile = "machine.vmxf"\n').replaceAll('\n', '\r\n')); }
    return { vmx: f.vmx, snapshots: [] };
  };
  const result = await f.disks.edit({ vmx: f.vmx, disk: f.disk, controller: 'scsi', controller_index: 0, unit: 1, confirm: true }, false);
  assert.equal(result.attached, true);
  assert.match(await fs.readFile(result.backup, 'utf8'), /extendedConfigFile = "machine.vmxf"\r\n/);
  assert.equal(parseAssignments(await fs.readFile(f.vmx, 'utf8'))['scsi0:1.fileName'], f.disk);
});

test('unsafe VM state is refused before native snapshot discovery can normalize the VMX', async t => {
  const f = await fixture(t);
  f.backend.snapshots = async () => { assert.fail('Unsafe VMX must be refused before native discovery.'); };
  for (const setting of ['encryption.keySafe = "encrypted"', 'checkpoint.vmState = "saved.vmss"']) {
    await fs.writeFile(f.vmx, f.originalVM + setting + '\n');
    await assert.rejects(f.disks.safeVM(f.vmx), { code: 'UNSAFE_VM' });
  }
});
