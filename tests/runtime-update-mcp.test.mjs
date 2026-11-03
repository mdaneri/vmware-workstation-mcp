import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('active Windows MCP survives cache removal with actionable errors and no empty VMX backup', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-update-')));
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    const temp = await fs.realpath(os.tmpdir());
    assert.equal(path.dirname(root).toLowerCase(), temp.toLowerCase());
    assert.ok(path.basename(root).startsWith('vmware-update-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  // This executable only reports fixture state; no VMware process is invoked.
  const vmrun = path.join(root, 'vmrun.exe'); const source = path.join(root, 'fake.cs');
  await fs.writeFile(source, 'class FakeVmrun { static void Main() { System.Console.WriteLine("Total running VMs: 0"); } }');
  await promisify(execFile)(path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'), ['/nologo', `/out:${vmrun}`, source], { windowsHide: true, shell: false });
  const credentials = path.join(root, 'credentials.json'); await fs.writeFile(credentials, '{}');
  const inventory = path.join(root, 'inventory.vmls'); await fs.writeFile(inventory, '');
  const runtime = path.join(root, 'runtime');
  await fs.mkdir(path.join(runtime, 'server'), { recursive: true }); await fs.mkdir(path.join(runtime, 'scripts'));
  const bundle = path.join(runtime, 'server/server.cjs'); const helper = path.join(runtime, 'scripts/Protect-LocalFile.ps1');
  await fs.copyFile('vmware-workstation/server/server.cjs', bundle);
  await fs.copyFile('vmware-workstation/scripts/Protect-LocalFile.ps1', helper);
  async function connect(entry) {
    const client = new Client({ name: 'runtime-update-regression', version: '1' }); clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env, VMRUN_PATH: vmrun, VMWARE_CREDENTIALS_FILE: credentials, VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root, VMWARE_INVENTORY_PATH: inventory }, stderr: 'pipe' }));
    return client;
  }
  const vmx = path.join(root, 'sensitive.vmx');
  const original = '.encoding = "UTF-8"\nRemoteDisplay.vnc.password = "TestVNC1"\nethernet1.vnet = "VMnet2"\n';
  await fs.writeFile(vmx, original);
  const old = await connect(bundle);
  assert.ok(!(await old.callTool({ name: 'get_vm_details', arguments: { vmx } })).isError);
  await fs.unlink(helper); await fs.unlink(bundle);
  const configure = client => client.callTool({ name: 'configure_vm', arguments: { vmx, settings: { 'ethernet1.vnet': 'VMnet3' } } });
  const failure = await configure(old);
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /PLUGIN_RUNTIME_MISSING:.*Reconnect.*fresh chat/);
  assert.equal(await fs.readFile(vmx, 'utf8'), original);
  assert.deepEqual((await fs.readdir(root)).filter(name => /\.(backup|edit)-/.test(name)), []);
  assert.ok(!(await old.callTool({ name: 'get_vm_details', arguments: { vmx } })).isError);
  const fresh = await connect(path.resolve('vmware-workstation/server/server.cjs'));
  const success = await configure(fresh); assert.ok(!success.isError);
  const result = JSON.parse(success.content[0].text);
  assert.equal(await fs.readFile(result.backup, 'utf8'), original);
  assert.deepEqual(result.changedSettings, ['ethernet1.vnet']);
  assert.match(await fs.readFile(vmx, 'utf8'), /ethernet1.vnet = "VMnet3"/);
});
