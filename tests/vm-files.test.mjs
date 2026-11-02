import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workstation, parseAssignments } from '../src/workstation.mjs';
import { VMFiles, encodeVMX } from '../src/vm-files.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-new-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binary = path.join(root, 'vmrun.exe');
  const diskManager = path.join(root, 'vmware-vdiskmanager.exe');
  await fs.writeFile(binary, ''); await fs.writeFile(diskManager, '');
  const calls = [];
  let running = [];
  const backend = new Workstation({ env: { VMRUN_PATH: binary }, run: async (file, args, options) => {
    calls.push({ file, args, options });
    if (file === diskManager) { await fs.writeFile(args.at(-1), 'fake disk'); return { stdout: 'done' }; }
    return { stdout: `Total running VMs: ${running.length}\n${running.join('\n')}` };
  } });
  return { root, binary, diskManager, calls, backend, files: new VMFiles(backend), setRunning: value => { running = value; } };
}

test('creates a new blank VM and growable disk with selected hardware and no network', async t => {
  const f = await fixture(t);
  const result = await f.files.create({ directory: path.join(f.root, 'new-vm'), name: 'Test "VM"', memory_mb: 512, cpus: 1, disk_gb: 1, network: 'none' });
  const config = parseAssignments(await fs.readFile(result.vmx, 'utf8'));
  assert.equal(config.displayName, 'Test "VM"');
  assert.equal(config.memsize, '512'); assert.equal(config.numvcpus, '1');
  assert.equal(config['ethernet0.present'], 'FALSE'); assert.equal(result.guestOSInstalled, false);
  assert.deepEqual(f.calls[0].args.slice(0, -1), ['-c', '-s', '1GB', '-a', 'lsilogic', '-t', '0']);
  assert.equal(f.calls[0].options.shell, false);
});
test('creation refuses an existing directory before disk creation', async t => {
  const f = await fixture(t);
  await assert.rejects(f.files.create({ directory: f.root, name: 'existing' }), /EEXIST/);
  assert.equal(f.calls.length, 0);
});
test('VM creation enforces allowed roots, validates custom network and ISO source', async t => {
  const f = await fixture(t);
  const allowed = path.join(f.root, 'allowed'); await fs.mkdir(allowed);
  f.backend.env.VMWARE_ALLOWED_ROOTS = allowed;
  await assert.rejects(f.files.create({ directory: path.join(f.root, 'outside'), name: 'outside' }), /outside/);
  await assert.rejects(f.files.create({ directory: path.join(allowed, 'inside'), name: 'inside', network: 'custom' }), /requires vmnet/);
  await assert.rejects(f.files.create({ directory: path.join(allowed, 'inside'), name: 'inside', iso_path: path.join(f.root, 'missing.iso') }), /existing file/);
  assert.equal(f.calls.length, 0);
});
test('powered-off VM edits are backed up, preserve comments and remove all duplicate keys', async t => {
  const f = await fixture(t);
  const vmx = path.join(f.root, 'existing.vmx');
  const original = '# comment\n.encoding = "UTF-8"\nmemsize = "512"\nMEMSIZE = "1024"\nnumvcpus = "1"\n';
  await fs.writeFile(vmx, original);
  const result = await f.files.configure({ vmx, settings: { memsize: '2048', numvcpus: '2', displayName: 'new | name', 'unused.key': null } });
  assert.equal(await fs.readFile(result.backup, 'utf8'), original);
  const text = await fs.readFile(vmx, 'utf8');
  assert.ok(text.startsWith('# comment'));
  assert.equal(text.match(/memsize/gi).length, 1);
  assert.equal(parseAssignments(text).memsize, '2048'); assert.equal(parseAssignments(text).displayName, 'new | name');
});
test('running, locked, suspended and non-UTF8 VMs are protected from local edits', async t => {
  const f = await fixture(t);
  const vmx = path.join(f.root, 'existing.vmx'); await fs.writeFile(vmx, '.encoding = "UTF-8"\n');
  f.setRunning([vmx]);
  await assert.rejects(f.files.configure({ vmx, settings: { memsize: '2048' } }), /Power off/);
  f.setRunning([]);
  await fs.mkdir(`${vmx}.lck`);
  await assert.rejects(f.files.configure({ vmx, settings: { memsize: '2048' } }), /VMX lock/);
  await fs.rmdir(`${vmx}.lck`);
  await fs.writeFile(path.join(f.root, 'saved.vmss'), 'state');
  await fs.writeFile(vmx, 'checkpoint.vmState = "saved.vmss"\n');
  await assert.rejects(f.files.configure({ vmx, settings: { memsize: '2048' } }), /suspended/);
  await fs.writeFile(vmx, '.encoding = "windows-1252"\n');
  await assert.rejects(f.files.configure({ vmx, settings: { memsize: '2048' } }), /UTF-8/);
});
test('VMX encoder round-trips quote/pipe/newline characters and rejects duplicate update names', async t => {
  assert.equal(parseAssignments(`value = "${encodeVMX('a|"\nb')}"`).value, 'a|"\nb');
  const f = await fixture(t);
  const vmx = path.join(f.root, 'existing.vmx'); await fs.writeFile(vmx, 'memsize = "512"');
  await assert.rejects(f.files.configure({ vmx, settings: { memsize: '1024', MEMSIZE: '2048' } }), /Duplicate/);
});
test('protects VNC-sensitive VMX backups and replacement files before writing secrets', async t => {
  const f = await fixture(t);
  const vmx = path.join(f.root, 'sensitive.vmx');
  await fs.writeFile(vmx, '.encoding = "UTF-8"\nRemoteDisplay.vnc.password = "TestVNC1"\n');
  const protectedFiles = [];
  const files = new VMFiles(f.backend, { protectSensitiveFile: async filename => {
    assert.equal((await fs.stat(filename)).size, 0, 'ACL must be restricted while the new file is still empty.'); protectedFiles.push(filename);
  } });
  const result = await files.configure({ vmx, settings: { memsize: '1024' } });
  assert.equal(protectedFiles.length, 2);
  assert.equal(protectedFiles[0], result.backup);
  assert.match(await fs.readFile(vmx, 'utf8'), /TestVNC1/);
});
