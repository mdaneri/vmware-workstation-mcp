import { assertCompatibleTool } from './tool-compatibility.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('bundled ISO MCP tools preserve all 129 previous definitions and return structured capability failures', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'iso-mcp-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vmx = path.join(root, 'selected.vmx'), iso = path.join(root, 'fixture.iso');
  await fs.writeFile(vmx, '.encoding = "UTF-8"\nvirtualHW.version = "21"\n'); await fs.writeFile(iso, 'fixture ISO');
  const binary = path.join(root, process.platform === 'win32' ? 'vmrun.exe' : 'vmrun'); await fs.writeFile(binary, '', { mode: 0o755 });
  const preload = path.join(root, 'mock.cjs');
  await fs.writeFile(preload, String.raw`
const { promisify } = require('node:util');
const assert = require('node:assert/strict');
const stub = () => { throw new Error('Unexpected callback process invocation'); };
stub[promisify.custom] = async (binary, args, options) => {
  assert.equal(binary, process.env.VMRUN_PATH); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  if (!args.length) return { stdout: 'vmrun version 1.17.0.25688693\nUsage: vmrun' };
  assert.deepEqual(args, ['-T', 'ws', 'list']); return { stdout: 'Total running VMs: 0' };
};
require('node:child_process').execFile = stub;
`);
  const client = new Client({ name: 'iso-mcp-test', version: '1' }); t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--require', preload, path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe', env: {
    ...process.env, VMRUN_PATH: binary, VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root,
  } }));
  const tools = (await client.listTools()).tools; assert.equal(tools.length, 153);
  const previous = JSON.parse(await fs.readFile('tests/fixtures/pre-iso-tool-schemas.json', 'utf8'));
  assert.equal(previous.tools.length, 129);
  for (const prior of previous.tools) assertCompatibleTool(tools.find(tool => tool.name === prior.name), prior);
  async function call(name, args) {
    const response = await client.callTool({ name, arguments: args }); assert.ok(!response.isError, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  }
  assert.equal((await call('iso_list', { vmx })).devices.length, 0);
  const mounted = await call('iso_mount', { vmx, iso_path: iso, start_connected: false, confirm: true });
  assert.equal(mounted.device, 'ide0:0');
  assert.equal((await call('iso_list', { vmx })).devices[0].start_connected, false);
  assert.equal((await call('iso_eject', { vmx, device: mounted.device, confirm: true })).iso_deleted, false);
  assert.equal((await call('vm_boot_status', { vmx })).boot_order_supported, false);
  const response = await client.callTool({ name: 'vm_boot_configure', arguments: { vmx, firmware_once: true, confirm: true } });
  assert.equal(response.isError, true); assert.equal(JSON.parse(response.content[0].text).code, 'UNSUPPORTED_CAPABILITY');
  for (const args of [{ vmx, iso_path: iso }, { vmx, iso_path: iso, confirm: false }, { vmx, iso_path: iso, confirm: true, arbitrary: true }]) {
    assert.equal((await client.callTool({ name: 'iso_mount', arguments: args })).isError, true);
  }
});
