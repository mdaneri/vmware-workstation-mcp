import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workstation, parseAssignments } from '../src/workstation.mjs';
import { VMFiles } from '../src/vm-files.mjs';
import { IsoManager, isoSchemas } from '../src/iso.mjs';

async function fixture(t, extra = '') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'iso-media-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vmx = path.join(root, 'test.vmx'), iso = path.join(root, process.platform === 'win32' ? 'installer [test] & space.iso' : 'installer | " test.iso');
  const original = '# preserve comment\n.encoding = "UTF-8"\nvirtualHW.version = "21"\nfirmware = "efi"\nscsi0:0.fileName = "disk.vmdk"\nmemsize = "256"\n' + extra;
  await fs.writeFile(vmx, original); await fs.writeFile(iso, 'disposable ISO fixture');
  const backend = new Workstation({ env: { VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root } });
  let running = false;
  backend.details = async () => ({ running });
  backend.help = async () => 'vmrun version 1.17.0.25688693\nUsage: vmrun';
  const vmFiles = new VMFiles(backend), media = new IsoManager({ backend, vmFiles });
  return { root, vmx, iso, original, backend, vmFiles, media, setRunning: value => { running = value; },
    args: { vmx, iso_path: iso, confirm: true }, config: async () => parseAssignments(await fs.readFile(vmx, 'utf8')) };
}

test('mount allocates IDE, backs up exact bytes, encodes paths and preserves unrelated settings; eject disables only optical and preserves ISO', async t => {
  const f = await fixture(t); const bytes = await fs.readFile(f.iso);
  const mounted = await f.media.edit(f.args);
  assert.equal(mounted.device, 'ide0:0'); assert.equal(await fs.readFile(mounted.backup, 'utf8'), f.original);
  let config = await f.config(); assert.equal(config['ide0:0.fileName'], f.iso); assert.equal(config['ide0:0.startConnected'], 'TRUE');
  assert.equal(config['scsi0:0.fileName'], 'disk.vmdk'); assert.equal(config.firmware, 'efi');
  assert.match(await fs.readFile(f.vmx, 'utf8'), /# preserve comment/);
  const listed = await f.media.list({ vmx: f.vmx });
  assert.equal(listed.devices[0].iso_path, f.iso); assert.equal(listed.devices[0].connected, true); assert.equal(listed.devices[0].live_connection_verified, false);
  const ejected = await f.media.edit({ vmx: f.vmx, confirm: true }, true);
  assert.equal(ejected.iso_deleted, false); assert.equal((await f.config())['ide0:0.fileName'], undefined);
  assert.equal((await f.config())['ide0:0.present'], 'FALSE'); assert.deepEqual(await fs.readFile(f.iso), bytes);
  const remount = await f.media.edit({ ...f.args, start_connected: false });
  assert.equal(remount.device, mounted.device); config = await f.config(); assert.equal(config['ide0:0.startConnected'], 'FALSE');
});

test('enumerates mixed-case, relative image, physical and unsupported optical devices without claiming runtime state', async t => {
  const f = await fixture(t, 'SATA0:2.DeviceType = "CDROM-IMAGE"\nSATA0:2.FileName = "missing.iso"\nSATA0:2.StartConnected = "FALSE"\nscsi0:1.deviceType = "cdrom-raw"\nscsi0:1.fileName = "auto detect"\n');
  const { devices } = await f.media.list({ vmx: f.vmx });
  assert.equal(devices.length, 2); assert.equal(devices[0].iso_path, path.join(f.root, 'missing.iso'));
  assert.equal(devices[0].connected, null); assert.equal(devices[0].start_connected, false);
  assert.equal(devices[1].iso_path, null); assert.equal(devices[1].editable, false);
  await assert.rejects(f.media.edit(f.args), { code: 'AMBIGUOUS_DEVICE' });
});

test('existing SATA and IDE optical drives are reused, including disabled drives; ambiguous targets need explicit selection', async t => {
  const f = await fixture(t, 'sata0.present = "TRUE"\nsata0:0.deviceType = "cdrom-image"\nsata0:0.present = "FALSE"\n');
  assert.equal((await f.media.edit(f.args)).device, 'sata0:0');
  await fs.appendFile(f.vmx, 'ide1:1.deviceType = "cdrom-image"\n');
  await assert.rejects(f.media.edit(f.args), { code: 'AMBIGUOUS_DEVICE' });
  await assert.rejects(f.media.edit({ vmx: f.vmx, confirm: true }, true), { code: 'AMBIGUOUS_DEVICE' });
  assert.equal((await f.media.edit({ ...f.args, device: 'ide1:1' })).device, 'ide1:1');
});

test('creates an optical slot on an existing SATA controller, skips disabled/partial disk slots and refuses unsupported controllers', async t => {
  const f = await fixture(t, 'sata0.present = "TRUE"\nsata0:0.present = "FALSE"\nsata0:1.fileName = "disk.vmdk"\n');
  assert.equal((await f.media.edit(f.args)).device, 'sata0:2');
  for (const slot of ['sata0:0', 'sata0:1', 'scsi0:1']) await assert.rejects(f.media.edit({ ...f.args, device: slot }), { code: slot.startsWith('scsi') ? 'UNSUPPORTED_CAPABILITY' : 'SLOT_OCCUPIED' });
  await assert.rejects(f.media.edit({ ...f.args, device: 'sata1:0' }), { code: 'CONTROLLER_MISSING' });
  await fs.writeFile(f.vmx, f.original.replace('"21"', '"9"'));
  await assert.rejects(f.media.edit({ ...f.args, device: 'sata0:2' }), { code: 'UNSUPPORTED_CAPABILITY' });
});

test('strict schemas require authorization, exact bounded slots and reject arbitrary flags/keys', () => {
  for (const name of ['iso_mount', 'iso_eject', 'vm_boot_configure']) assert.equal(isoSchemas[name].safeParse({ vmx: '/tmp/v.vmx', iso_path: '/tmp/a.iso' }).success, false);
  for (const slot of ['ide2:0', 'ide0:2', 'sata0:30', 'sata4:0', 'scsi0:7', 'nvme0:0', 'sata0:0.fileName']) assert.equal(isoSchemas.iso_mount.safeParse({ vmx: '/v.vmx', iso_path: '/a.iso', confirm: true, device: slot }).success, false);
  assert.equal(isoSchemas.iso_mount.safeParse({ vmx: '/v.vmx', iso_path: '/a.iso', confirm: true, settings: {} }).success, false);
});

test('exhausted slots, non-optical eject and unsupported existing optical hardware cannot overwrite disks', async t => {
  const f = await fixture(t);
  await assert.rejects(f.media.edit({ vmx: f.vmx, confirm: true }, true), { code: 'DEVICE_NOT_FOUND' });
  await assert.rejects(f.media.edit({ vmx: f.vmx, device: 'ide0:0', confirm: true }, true), { code: 'DEVICE_NOT_FOUND' });
  for (const slot of ['ide0:0', 'ide0:1', 'ide1:0', 'ide1:1']) await fs.appendFile(f.vmx, `${slot}.fileName = "disk.vmdk"\n`);
  await assert.rejects(f.media.edit(f.args), { code: 'NO_AVAILABLE_DEVICE' });
  await fs.appendFile(f.vmx, 'scsi0:1.deviceType = "cdrom-image"\nscsi0:1.fileName = "missing.iso"\n');
  await assert.rejects(f.media.edit(f.args), { code: 'UNSUPPORTED_CAPABILITY' });
  for (const slot of ['ide0:0', 'ide0:1', 'ide1:0', 'ide1:1']) assert.equal((await f.config())[`${slot}.fileName`], 'disk.vmdk');
});

test('missing/non-ISO and separately allowlisted VM/ISO paths fail before any mutation', async t => {
  const f = await fixture(t);
  for (const iso_path of ['relative.iso', path.join(f.root, 'missing.iso'), f.vmx, f.root]) await assert.rejects(f.media.edit({ ...f.args, iso_path }));
  const allowed = path.join(f.root, 'allowed'); await fs.mkdir(allowed); f.backend.env.VMWARE_ALLOWED_HOST_ROOTS = allowed;
  await assert.rejects(f.media.edit(f.args), /outside the configured allowed roots/);
  f.backend.env.VMWARE_ALLOWED_HOST_ROOTS = f.root; f.backend.env.VMWARE_ALLOWED_ROOTS = allowed;
  await assert.rejects(f.media.edit(f.args), /outside VMWARE_ALLOWED_ROOTS/);
  assert.equal(await fs.readFile(f.vmx, 'utf8'), f.original);
});

test('canonical path checks refuse ISO/VMX junction or symlink escapes', async t => {
  const f = await fixture(t); const allowed = path.join(f.root, 'allowed'); await fs.mkdir(allowed);
  await fs.symlink(f.root, path.join(allowed, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  f.backend.env.VMWARE_ALLOWED_HOST_ROOTS = allowed;
  await assert.rejects(f.media.edit({ ...f.args, iso_path: path.join(allowed, 'escape', path.basename(f.iso)) }), /outside/);
});

test('running, locked, suspended, encrypted, hardlinked and malformed VMX files fail closed', async t => {
  const f = await fixture(t); f.setRunning(true);
  await assert.rejects(f.media.edit(f.args), { code: 'VM_RUNNING' }); f.setRunning(false);
  for (const name of ['test.vmx.lck', 'saved.vmss', 'saved.vmem']) {
    await fs.writeFile(path.join(f.root, name), ''); await assert.rejects(f.media.edit(f.args), { code: 'VM_LOCKED_OR_SUSPENDED' }); await fs.unlink(path.join(f.root, name));
  }
  for (const extra of ['checkpoint.vmState = "missing.vmss"', 'suspend.filename = "saved.vmss"', 'encryption.keySafe = "hidden"', 'MEMSIZE = "512"', 'unparsed assignment', '.encoding = "windows-1252"']) {
    await fs.writeFile(f.vmx, f.original + extra + '\n'); await assert.rejects(f.media.edit(f.args));
  }
  await fs.writeFile(f.vmx, f.original); await fs.link(f.vmx, path.join(f.root, 'alias.vmx'));
  await assert.rejects(f.media.edit(f.args), { code: 'UNSAFE_VM' });
});

test('resource reservations coordinate optical edits with existing VM operations', async t => {
  const f = await fixture(t); let entered, release;
  const held = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const job = f.backend.resources.use([f.vmx], async () => { entered(); await gate; });
  await held;
  try { await assert.rejects(f.media.edit(f.args), { code: 'RESOURCE_BUSY' }); } finally { release(); await job; }
  assert.equal(await fs.readFile(f.vmx, 'utf8'), f.original);
});

test('optimistic editing rejects external configuration changes and new power/lock state before commit', async t => {
  const f = await fixture(t); const configure = f.vmFiles.configure.bind(f.vmFiles);
  f.vmFiles.configure = async (...args) => { await fs.appendFile(f.vmx, 'numvcpus = "2"\n'); return configure(...args); };
  await assert.rejects(f.media.edit(f.args), /changed before editing/);
  f.vmFiles.configure = async (...args) => { f.setRunning(true); return configure(...args); };
  await assert.rejects(f.media.edit(f.args), /Power off/); f.setRunning(false);
  f.vmFiles.configure = configure;
  let calls = 0; f.backend.details = async () => { if (++calls === 3) await fs.writeFile(path.join(f.root, 'test.vmx.lck'), ''); return { running: false }; };
  await assert.rejects(f.media.edit(f.args), { code: 'VM_LOCKED_OR_SUSPENDED' });
  assert.equal((await f.config())['ide0:0.fileName'], undefined);
});

test('boot status separates version discovery from compatibility; all unproven boot writes fail without changing bytes', async t => {
  const f = await fixture(t, 'bios.forceSetupOnce = "TRUE"\nbios.bootOrder = "cdrom,hdd"\n');
  const status = await f.media.bootStatus({ vmx: f.vmx });
  assert.equal(status.vmrun_version, '1.17.0.25688693'); assert.equal(status.firmware, 'efi');
  assert.equal(status.configured_firmware_once, true); assert.equal(status.boot_order_supported, false);
  for (const requested of [{ firmware_once: true }, { boot_order: ['cdrom', 'hdd'] }]) await assert.rejects(f.media.configureBoot({ vmx: f.vmx, confirm: true, ...requested }), { code: 'UNSUPPORTED_CAPABILITY' });
  f.backend.help = async () => { throw new Error('missing VMware'); };
  assert.equal((await f.media.bootStatus({ vmx: f.vmx })).help_verified, false);
  assert.equal(await fs.readFile(f.vmx, 'utf8'), f.original);
});
