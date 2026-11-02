import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inventoryPath, credentialsPath, findVMwareExecutable } from '../src/host-platform.mjs';
import { procAddress, parseProcListeners } from '../src/linux-listener.mjs';

test('host defaults retain Windows locations and use Linux inventory/XDG credentials', () => {
  const home = path.resolve('test-home');
  const roaming = path.join(home, 'Roaming');
  assert.equal(inventoryPath({ APPDATA: roaming }, 'win32', home), path.join(roaming, 'VMware', 'inventory.vmls'));
  assert.equal(credentialsPath({ APPDATA: roaming }, 'win32', home), path.join(roaming, 'VMwareWorkstationPlugin', 'credentials.json'));
  assert.equal(inventoryPath({}, 'linux', home), path.join(home, '.vmware', 'inventory.vmls'));
  assert.equal(credentialsPath({}, 'linux', home), path.join(home, '.config', 'vmware-workstation-mcp', 'credentials.json'));
  assert.equal(credentialsPath({ XDG_CONFIG_HOME: roaming }, 'linux', home), path.join(roaming, 'vmware-workstation-mcp', 'credentials.json'));
  assert.equal(credentialsPath({ XDG_CONFIG_HOME: 'relative' }, 'linux', home), credentialsPath({}, 'linux', home));
  assert.equal(inventoryPath({ VMWARE_INVENTORY_PATH: 'override' }, 'linux', home), 'override');
  assert.equal(credentialsPath({ VMWARE_CREDENTIALS_FILE: 'override' }, 'linux', home), 'override');
});

test('native executable discovery handles PATH, explicit overrides and sibling disk manager', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-executable-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const binary = path.join(root, `vmrun${suffix}`);
  const disk = path.join(root, `vmware-vdiskmanager${suffix}`);
  await fs.writeFile(binary, '', { mode: 0o755 }); await fs.writeFile(disk, '', { mode: 0o755 });
  assert.equal(await findVMwareExecutable('vmrun', { env: { PATH: root } }), binary);
  assert.equal(await findVMwareExecutable('vmrun', { env: { VMRUN_PATH: binary } }), binary);
  assert.equal(await findVMwareExecutable('vmware-vdiskmanager', { env: {}, beside: binary }), disk);
  const ovfDirectory = path.join(root, 'OVFTool'); await fs.mkdir(ovfDirectory);
  const ovf = path.join(ovfDirectory, `ovftool${suffix}`); await fs.writeFile(ovf, '', { mode: 0o755 });
  assert.equal(await findVMwareExecutable('ovftool', { env: {}, beside: binary }), ovf);
  assert.equal(await findVMwareExecutable('ovftool', { env: { VMWARE_OVFTOOL_PATH: ovf } }), ovf);
  await assert.rejects(findVMwareExecutable('vmrun', { env: { VMRUN_PATH: 'relative/vmrun' } }), /absolute path/);
  await assert.rejects(findVMwareExecutable('vmrun', { env: { VMRUN_PATH: disk } }), /absolute path/);
  if (process.platform === 'linux') {
    await fs.chmod(binary, 0o644);
    await assert.rejects(findVMwareExecutable('vmrun', { env: { VMRUN_PATH: binary } }), { code: 'EACCES' });
    // Preserve appLoader's symlink name rather than returning its realpath.
    await fs.rename(disk, path.join(root, 'appLoader'));
    await fs.symlink('appLoader', disk);
    assert.equal(await findVMwareExecutable('vmware-vdiskmanager', { env: { VMWARE_VDISKMANAGER_PATH: disk } }), disk);
  }
});

test('Linux TCP parser identifies IPv4/IPv6 loopback and wildcard listeners in native word order', () => {
  assert.equal(procAddress('0100007F', 'LE'), '127.0.0.1');
  assert.equal(procAddress('7F000001', 'BE'), '127.0.0.1');
  assert.equal(procAddress('00000000000000000000000001000000', 'LE'), '::1');
  assert.equal(procAddress('00000000000000000000000000000001', 'BE'), '::1');
  assert.equal(procAddress('00000000000000000000000000000000'), '::');
  assert.equal(procAddress('00000000'), '0.0.0.0');
  assert.throws(() => procAddress('invalid'), /address/);
  const table = 'header\n0: 0100007F:170D 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 12345 1\n1: 00000000:170D 00000000:0000 01 00000000:00000000 00:00000000 00000000 1000 0 56789 1';
  assert.deepEqual(parseProcListeners(table, 5901), [{ address: procAddress('0100007F'), port: 5901, inode: '12345' }]);
  assert.deepEqual(parseProcListeners(table, 5902), []);
  assert.throws(() => parseProcListeners('header\nmalformed', 5901), /parse/);
});
