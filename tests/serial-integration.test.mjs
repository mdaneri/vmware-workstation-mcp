import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { constants } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connectSerial } from '../src/serial-transport.mjs';

test('bundled MCP serial uses native local streams, exact worker ownership and two isolated VMs', { timeout: 60000 }, async t => {
  // Hosted Windows TEMP uses an 8.3 alias. Launch the worker with the same
  // canonical VMX spelling returned by Workstation.resolveVM, so strict argv
  // verification measures VM isolation rather than a fixture path mismatch.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ser-i-')));
  const clients = []; const workers = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    for (const worker of workers) if (worker.exitCode === null) { const exited = once(worker, 'exit'); worker.disconnect(); await exited; }
    await fs.rm(root, { recursive: true, force: true });
  });
  const extension = process.platform === 'win32' ? '.exe' : '';
  const vmrun = path.join(root, 'vmrun' + extension); const vmworker = path.join(root, 'vmware-vmx' + extension);
  await fs.copyFile(process.execPath, vmworker, constants.COPYFILE_FICLONE); await fs.chmod(vmworker, 0o755);
  const running = path.join(root, 'running.txt'); await fs.writeFile(running, 'Total running VMs: 0');
  if (process.platform === 'win32') {
    const source = path.join(root, 'vmrun.cs');
    await fs.writeFile(source, `class FakeVmrun { static void Main() { System.Console.WriteLine(System.IO.File.ReadAllText(${JSON.stringify(running)})); } }`);
    await promisify(execFile)(path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), ['/nologo', `/out:${vmrun}`, source], { windowsHide: true, shell: false });
  } else await fs.writeFile(vmrun, `#!${process.execPath}\nconsole.log(require('node:fs').readFileSync(${JSON.stringify(running)}, 'utf8'));\n`, { mode: 0o755 });
  const credentials = path.join(root, 'credentials.json'); await fs.writeFile(credentials, '{}', { mode: 0o600 });
  // Secure ACL is mandatory for the Windows credentials loader even for {}.
  if (process.platform === 'win32') {
    const protector = spawn('pwsh', ['-NoProfile', '-File', path.resolve('vmware-workstation/scripts/Protect-LocalFile.ps1'), '-LiteralPath', credentials], { windowsHide: true, stdio: 'pipe' });
    assert.equal((await once(protector, 'exit'))[0], 0);
  }
  const inventory = path.join(root, 'inventory.vmls'); await fs.writeFile(inventory, '');
  const client = new Client({ name: 'serial-native-test-double', version: '1' }); clients.push(client);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('vmware-workstation/server/server.cjs')], env: { ...process.env, VMRUN_PATH: vmrun, VMWARE_CREDENTIALS_FILE: credentials, VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root, VMWARE_INVENTORY_PATH: inventory }, stderr: 'pipe' }));
  async function call(name, arguments_ = {}) {
    const result = await client.callTool({ name, arguments: arguments_ }, undefined, { timeout: 20000 });
    assert.ok(!result.isError, JSON.stringify(result.content)); return JSON.parse(result.content[0].text);
  }
  const targets = []; const paths = []; const endpoints = [];
  for (const name of ['a', 'b']) {
    const vmx = path.join(root, name + '.vmx'); await fs.writeFile(vmx, '.encoding = "UTF-8"\n');
    const target = { vm_id: vmx }; targets.push(target); paths.push(vmx);
    const configured = await call('serial_configure', { ...target, confirm: true });
    endpoints.push(configured.endpoint);
    const worker = spawn(vmworker, [path.resolve('tests/fixtures/serial-worker.mjs'), configured.endpoint, vmx], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }); workers.push(worker);
    assert.equal((await once(worker, 'message'))[0].ready, true);
  }
  await fs.writeFile(running, 'Total running VMs: 2\n' + paths.join('\n'));
  for (const target of targets) assert.equal((await call('serial_connect', target)).connected, true);
  const data = Buffer.from([0, 255, 10, 13, 27, 65, 0xc3, 0xa9]);
  await call('serial_write', { ...targets[0], data: data.toString('base64'), encoding: 'base64' });
  let echoed = Buffer.alloc(0);
  while (echoed.length < data.length) {
    const read = await call('serial_read', { ...targets[0], timeout_ms: 5000 });
    assert.equal(read.timed_out, false); echoed = Buffer.concat([echoed, Buffer.from(read.data, 'base64')]);
  }
  assert.deepEqual(echoed, data);
  const drained = await call('serial_read', { ...targets[0], timeout_ms: 5 });
  assert.equal(drained.bytes, 0);
  assert.equal(drained.timed_out, true);
  assert.equal((await call('serial_read', { ...targets[1], timeout_ms: 5 })).timed_out, true);
  await call('serial_write', { ...targets[1], data: 'other-vm\r\n' });
  assert.equal((await call('serial_read', { ...targets[1], encoding: 'utf8', timeout_ms: 5000 })).data, 'other-vm\r\n');
  for (const target of targets) assert.equal((await call('serial_status', target)).runtime_verified, true);
  for (const target of targets) await call('serial_disconnect', target);
  await assert.rejects(connectSerial({ path: endpoints[0], vmx: paths[0] + '.other' }, { timeoutMs: 5000, bridgeScript: path.resolve('vmware-workstation/scripts/Serial-Bridge.ps1') }), { code: process.platform === 'win32' ? 'SERIAL_WRONG_VM' : 'SERIAL_UNAVAILABLE' });
  const result = await client.callTool({ name: 'serial_read', arguments: targets[0] }); assert.equal(result.isError, true);
});

test('native serial refuses an unrelated local listener; no arbitrary host service is exposed', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ser-bad-')); const vmx = path.join(root, 'a.vmx'); await fs.writeFile(vmx, '');
  const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\vmware-mcp-serial-0123456789abcdef0123456789abcdef-0' : path.join(root, 's.sock');
  const sockets = new Set(); const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  server.listen(endpoint); await once(server, 'listening');
  await assert.rejects(connectSerial({ vmx, path: endpoint }, { timeoutMs: 5000, bridgeScript: path.resolve('vmware-workstation/scripts/Serial-Bridge.ps1') }), { code: process.platform === 'win32' ? 'SERIAL_WRONG_WORKER' : 'SERIAL_UNAVAILABLE' });
});
