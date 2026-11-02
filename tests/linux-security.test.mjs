import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { Credentials } from '../src/credentials.mjs';
import { saveCredential } from '../src/credential-setup.mjs';
import { localFileProtector } from '../src/local-file-security.mjs';
import { Workstation } from '../src/workstation.mjs';
import { VMFiles } from '../src/vm-files.mjs';
import { inspectLinuxListener } from '../src/linux-listener.mjs';
import { ConsoleManager } from '../src/console.mjs';

const linux = { skip: process.platform !== 'linux' };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-linux-private-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { VMWARE_CREDENTIALS_FILE: path.join(root, 'config', 'credentials.json'), VMRUN_PATH: path.join(root, 'vmrun') };
  await fs.writeFile(env.VMRUN_PATH, '', { mode: 0o755 });
  const vmx = path.join(root, 'test.vmx'); await fs.writeFile(vmx, '.encoding = "UTF-8"\n', { mode: 0o600 });
  const backend = new Workstation({ env, run: async () => ({ stdout: 'Total running VMs: 0' }) });
  return { root, env, vmx, backend, credentials: new Credentials(env) };
}

test('Linux credential setup preserves profiles and protects files/directories before writing', linux, async t => {
  const f = await fixture(t);
  for (const kind of ['rest', 'guest', 'vm', 'console']) await saveCredential({ kind, profile: 'LAB', username: 'tester', password: 'TestVNC1', vmx: f.vmx, env: f.env, backend: f.backend });
  assert.deepEqual(await f.credentials.guest('lab'), { username: 'tester', password: 'TestVNC1' });
  assert.equal(await f.credentials.vm('lab'), 'TestVNC1');
  assert.equal((await f.credentials.console(f.vmx, 'lab')).password, 'TestVNC1');
  assert.match((await f.credentials.rest()).authorization, /^Basic /);
  assert.equal((await fs.stat(f.env.VMWARE_CREDENTIALS_FILE)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(f.env.VMWARE_CREDENTIALS_FILE))).mode & 0o777, 0o700);
  await assert.rejects(saveCredential({ kind: 'console', profile: 'bad', password: 'more-than-eight', vmx: f.vmx, env: f.env, backend: f.backend }), /1 to 8/);
  assert.equal(f.credentials.redact('TestVNC1'), '[REDACTED]');
});

test('Linux credentials reject readable-by-others files, symlinks and hardlinks', linux, async t => {
  const f = await fixture(t);
  const filename = f.env.VMWARE_CREDENTIALS_FILE;
  await fs.mkdir(path.dirname(filename));
  await fs.writeFile(filename, '{}', { mode: 0o644 });
  await assert.rejects(f.credentials.load(), /mode 600/);
  await localFileProtector(f.backend)(filename);
  assert.deepEqual(await f.credentials.load(), {});
  const actual = path.join(f.root, 'actual.json'); await fs.rename(filename, actual);
  await fs.symlink(actual, filename);
  await assert.rejects(f.credentials.load(), /Cannot read/);
  await assert.rejects(localFileProtector(f.backend)(filename));
  await fs.unlink(filename); await fs.link(actual, filename);
  await assert.rejects(f.credentials.load(), /Cannot read/);
});

test('Linux VMX edits retain private permissions and secure VNC replacements/backups', linux, async t => {
  const f = await fixture(t);
  const files = new VMFiles(f.backend, { protectSensitiveFile: localFileProtector(f.backend) });
  let result = await files.configure({ vmx: f.vmx, settings: { memsize: '1024' } });
  for (const filename of [f.vmx, result.backup]) assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  await fs.chmod(f.vmx, 0o644);
  result = await files.configure({ vmx: f.vmx, settings: { 'RemoteDisplay.vnc.password': 'TestVNC1' } });
  for (const filename of [f.vmx, result.backup]) assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
});

test('Linux inspects real socket owners and refuses a non-VMware listener without shell tools', linux, async t => {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const listeners = await inspectLinuxListener(port);
  assert.ok(listeners.some(item => item.address === '127.0.0.1' && item.pid === process.pid));
  const manager = new ConsoleManager({ backend: {}, credentials: {} }); t.after(() => manager.close());
  await assert.rejects(manager.verify({ host: '127.0.0.1', port, vmx: '/unrelated.vmx' }), /could not be verified/);
});

test('Linux requires an exact VMX argv token and all selected listener owners to match', linux, async t => {
  let owners = [{ address: '127.0.0.1', processName: 'vmware-vmx', arguments: ['/usr/bin/vmware-vmx', '/vm/lab.vmx.other'], commandLine: 'vmware-vmx /vm/lab.vmx.other' }];
  const manager = new ConsoleManager({ listenerInspector: async () => owners }); t.after(() => manager.close());
  const endpoint = { host: '127.0.0.1', port: 5901, vmx: '/vm/lab.vmx' };
  await assert.rejects(manager.verify(endpoint), /exact VMX/);
  owners[0].arguments[1] = endpoint.vmx;
  assert.match(await manager.verify(endpoint), /native worker/);
  owners.push({ address: '127.0.0.1', processName: null, commandLine: null });
  await assert.rejects(manager.verify(endpoint), /owner/);
});
