import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import pngjs from 'pngjs';
import { inspectLinuxListener } from '../src/linux-listener.mjs';

const execute = promisify(execFile);
const bundled = path.resolve('vmware-workstation/server/server.cjs');
const textResult = result => {
  assert.ok(!result.isError, JSON.stringify(result.content));
  return JSON.parse(result.content.find(block => block.type === 'text').text);
};
const image = result => {
  assert.ok(!result.isError, JSON.stringify(result.content));
  return pngjs.PNG.sync.read(Buffer.from(result.content.find(block => block.type === 'image').data, 'base64'));
};

test('Linux bundled MCP uses real child processes, private console setup and native socket inspection', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-linux-integration-'));
  const workers = []; const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    for (const worker of workers) {
      const exit = once(worker, 'exit'); worker.disconnect(); await exit;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const binary = path.join(root, 'vmrun');
  // A fake VIX command executes through the real Linux execFile path, without a shell.
  await fs.writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2);\nwhile (['-T', '-gu', '-gp', '-vp'].includes(args[0])) args.splice(0, 2);\nif (args[0] === 'list') console.log('Total running VMs: 0');\nelse if (args[0] === 'runProgramInGuest') console.log(args.slice(1).join('|'));\nelse if (args[0] === 'CopyFileFromHostToGuest' || args[0] === 'CopyFileFromGuestToHost') fs.copyFileSync(args[2], args[3]);\nelse if (args[0] !== undefined) console.log('test double: ' + args[0]);\n`, { mode: 0o755 });
  const env = { ...process.env, VMRUN_PATH: binary, VMWARE_CREDENTIALS_FILE: path.join(root, 'credentials.json'), VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root };
  await fs.writeFile(env.VMWARE_CREDENTIALS_FILE, '{}', { mode: 0o600 });
  const client = new Client({ name: 'linux-integration-test', version: '1' }); clients.push(client);
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bundled], env, stderr: 'pipe' }));
  assert.equal((await client.listTools()).tools.length, 93);
  assert.equal(textResult(await client.callTool({ name: 'workstation_status', arguments: {} })).executable, binary);

  const workerBinary = path.join(root, 'vmware-vmx');
  await fs.copyFile(process.execPath, workerBinary, constants.COPYFILE_FICLONE); await fs.chmod(workerBinary, 0o755);
  const entries = { guest: { default: { username: 'tester', password: 'TestVNC1' } }, console: {} };
  const states = [];
  for (const alias of ['bios', 'uefi']) {
    const vmx = path.join(root, `${alias} with spaces.vmx`);
    await fs.writeFile(vmx, '.encoding = "UTF-8"\n');
    const worker = spawn(workerBinary, [path.resolve('tests/fixtures/linux-rfb-worker.mjs'), vmx], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); workers.push(worker);
    const events = []; worker.on('message', message => events.push(message));
    const [ready] = await once(worker, 'message');
    assert.equal(ready.kind, 'ready');
    entries.console[alias] = { vmx, password: 'TestVNC1' };
    await fs.writeFile(env.VMWARE_CREDENTIALS_FILE, JSON.stringify(entries));
    const setup = await execute(process.execPath, [path.resolve('vmware-workstation/server/configure-console.cjs'), '--vmx', vmx, '--port', String(ready.port), '--profile', alias], { env });
    const configured = JSON.parse(setup.stdout);
    for (const file of [vmx, configured.backup]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    const listeners = await inspectLinuxListener(ready.port);
    assert.ok(listeners.some(item => item.pid === worker.pid && item.processName === 'vmware-vmx' && item.arguments.includes(vmx)));
    states.push({ alias, vmx, events, port: ready.port });
  }
  const call = (name, vm, extra = {}) => client.callTool({ name, arguments: { vm_id: vm.alias, ...extra } });
  const before = await Promise.all(states.map(vm => call('console_screenshot', vm)));
  for (const result of before) assert.deepEqual([...image(result).data.subarray(0, 4)], [255, 0, 0, 255]);
  for (const vm of states) {
    textResult(await call('console_key', vm, { key: 'F2' }));
    textResult(await call('console_click', vm, { x: 3, y: 4, button: 'right' }));
    textResult(await call('console_type', vm, { text: 'Az!' }));
    textResult(await call('console_scroll', vm, { direction: 'down', amount: 2 }));
    assert.equal(textResult(await call('console_status', vm)).connected, true);
    assert.deepEqual([...image(await call('console_screenshot', vm)).data.subarray(0, 4)], [0, 0, 255, 255]);
  }
  for (let attempts = 0; attempts < 100 && states.some(vm => vm.events.filter(event => event.kind === 'pointer').length < 6); attempts++) await delay(10);
  for (const vm of states) {
    assert.equal(vm.events.filter(event => event.kind === 'pointer').length, 6);
    assert.ok(vm.events.some(event => event.kind === 'key' && event.down));
  }
  const guest = textResult(await client.callTool({ name: 'vmrun_run_program_in_guest', arguments: { vmx: states[0].vmx, program: '/usr/bin/printf', arguments: ['hello $(literal) & world'] } }));
  // vmrun puts authentication before the operation. Verify transport at the actual process boundary.
  assert.ok(guest.commandSucceeded);
  assert.ok(guest.output.includes('hello $(literal) & world'));
  const source = path.join(root, 'host-source.txt'); const guestFile = path.join(root, 'guest-file.txt'); const output = path.join(root, 'host-output.txt');
  await fs.writeFile(source, 'round trip through Linux execFile');
  textResult(await client.callTool({ name: 'vmrun_copy_file_from_host_to_guest', arguments: { vmx: states[0].vmx, host_path: source, guest_path: guestFile } }));
  textResult(await client.callTool({ name: 'vmrun_copy_file_from_guest_to_host', arguments: { vmx: states[0].vmx, guest_path: guestFile, host_path: output } }));
  assert.equal(await fs.readFile(output, 'utf8'), await fs.readFile(source, 'utf8'));
});
