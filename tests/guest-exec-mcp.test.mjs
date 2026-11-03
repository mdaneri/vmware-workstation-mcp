import { assertCompatibleTool } from './tool-compatibility.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('bundled MCP guest_exec uses private transfers, explicit profiles and preserves all previous tools', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'guest-exec-mcp-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vmx = path.join(root, 'selected.vmx'); await fs.writeFile(vmx, '');
  const binary = path.join(root, process.platform === 'win32' ? 'vmrun.exe' : 'vmrun'); await fs.writeFile(binary, '', { mode: 0o755 });
  const preload = path.join(root, 'mock.cjs');
  await fs.writeFile(preload, String.raw`
const { promisify } = require('node:util');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const native = require('node:child_process').execFile;
const stub = (...args) => native(...args);
let request;
stub[promisify.custom] = async (binary, args, options) => {
  if (binary !== process.env.VMRUN_PATH) return promisify(native)(binary, args, options);
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.equal(args[4], '-gp');
  const command = args[6], parameters = args.slice(8);
  if (command === 'checkToolsState') return { stdout: 'running' };
  if (command === 'CopyFileFromHostToGuest' && parameters[1].endsWith('request.json')) {
    if (process.platform === 'linux') assert.equal(fs.statSync(parameters[0]).mode & 0o777, 0o600);
    request = JSON.parse(fs.readFileSync(parameters[0], 'utf8'));
  }
  if (command === 'fileExistsInGuest') return { stdout: 'The file exists.' };
  if (command === 'CopyFileFromGuestToHost') fs.writeFileSync(parameters[1], JSON.stringify({
    protocol: 1, nonce: request.nonce, status: 'completed', exit_code: 8, timed_out: false,
    stdout_base64: Buffer.from('captured ' + process.env.VMWARE_GUEST_LAB_PASSWORD).toString('base64'),
    stderr_base64: Buffer.from('error').toString('base64'), stdout_truncated: false, stderr_truncated: false
  }));
  return { stdout: '' };
};
require('node:child_process').execFile = stub;
`);
  const client = new Client({ name: 'guest-exec-mcp-test', version: '1' }); t.after(() => client.close());
  const password = 'generated-fixture-password';
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--require', preload, path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe', env: {
    ...process.env, VMRUN_PATH: binary, VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root, VMWARE_GUEST_EXEC_ROOT: root,
    VMWARE_GUEST_LAB_USERNAME: 'test-user', VMWARE_GUEST_LAB_PASSWORD: password,
  } }));
  const tools = (await client.listTools()).tools; assert.equal(tools.length, 148);
  const previous = JSON.parse(await fs.readFile('tests/fixtures/pre-guest-exec-tool-schemas.json', 'utf8'));
  for (const prior of previous.tools) assertCompatibleTool(tools.find(tool => tool.name === prior.name), prior);
  const args = { vmx, guest_profile: 'lab', guest_os: 'linux', program: '/usr/bin/id', confirm: true };
  const response = await client.callTool({ name: 'guest_exec', arguments: args });
  assert.ok(!response.isError, JSON.stringify(response));
  assert.ok(!JSON.stringify(response).includes(password));
  const result = JSON.parse(response.content[0].text);
  assert.equal(result.status, 'completed'); assert.equal(result.exit_code, 8);
  assert.equal(result.stdout, 'captured [REDACTED]'); assert.equal(result.stderr, 'error');
  assert.equal(result.cleanup.guest, 'removed'); assert.equal(result.cleanup.host, 'removed');
  for (const patch of [{ confirm: false }, { guest_profile: undefined }, { password: 'rejected' }]) {
    const rejected = await client.callTool({ name: 'guest_exec', arguments: { ...args, ...patch } });
    assert.equal(rejected.isError, true);
  }
});
