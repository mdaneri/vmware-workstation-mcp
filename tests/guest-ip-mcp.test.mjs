import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('bundled MCP preserves IP failures, separate Tools diagnostics and credential redaction', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-ip-mcp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binary = path.join(root, process.platform === 'win32' ? 'vmrun.exe' : 'vmrun');
  const vmx = path.join(root, 'Test VM.vmx');
  const scenario = path.join(root, 'scenario.json');
  const calls = path.join(root, 'calls.jsonl');
  const preload = path.join(root, 'fake-vmrun.cjs');
  await fs.writeFile(binary, 'test executable placeholder', { mode: 0o755 });
  await fs.writeFile(vmx, 'displayName = "Test VM"\n');
  // Substitute only promisified execFile in the isolated MCP child process.
  // This exercises the shipped bundle and real stdio protocol on both hosts.
  await fs.writeFile(preload, `
const fs = require('node:fs');
const { promisify } = require('node:util');
const execFile = () => { throw new Error('Expected promisified execFile'); };
execFile[promisify.custom] = async (binary, args, options) => {
  if (binary !== process.env.VMRUN_PATH) throw new Error('Unexpected executable');
  fs.appendFileSync(process.env.VMWARE_TEST_CALLS, JSON.stringify({ args, timeout: options.timeout }) + '\\n');
  const scenario = JSON.parse(fs.readFileSync(process.env.VMWARE_TEST_SCENARIO, 'utf8'));
  if (args[2] === 'getGuestIPAddress') {
    if (scenario.ipOutput !== undefined) return { stdout: scenario.ipOutput };
    throw Object.assign(new Error('native failure'), { code: 4294967295, stderr: scenario.ipError });
  }
  if (args[2] === 'checkToolsState') {
    if (scenario.toolsError) throw Object.assign(new Error('probe failure'), { killed: true, stderr: scenario.toolsError });
    return { stdout: scenario.toolsOutput };
  }
  throw new Error('Unexpected command');
};
require('node:child_process').execFile = execFile;
`);
  const client = new Client({ name: 'guest-ip-regression', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ['--require', preload, path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe',
    env: { ...process.env, VMRUN_PATH: binary, VMWARE_ALLOWED_ROOTS: root, VMWARE_VM_DEFAULT_PASSWORD: 'test-password', VMWARE_TEST_CALLS: calls, VMWARE_TEST_SCENARIO: scenario },
  }));
  const call = async input => {
    await fs.writeFile(scenario, JSON.stringify(input));
    return client.callTool({ name: 'get_guest_ip', arguments: { vmx } });
  };
  const nativeError = 'Error: The VMware Tools are not running in the virtual machine';
  const result = await call({ ipError: `${nativeError} test-password`, toolsOutput: 'running\r\n' });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /test-password/);
  const details = JSON.parse(result.content[0].text);
  assert.equal(details.code, 'GUEST_IP_UNAVAILABLE');
  assert.equal(details.message, `vmrun getGuestIPAddress failed (4294967295). ${nativeError} [REDACTED]`);
  assert.equal(details.vmx, await fs.realpath(vmx));
  assert.equal(details.addressAvailable, false);
  assert.deepEqual(details.toolsState, { state: 'running', output: 'running' });
  assert.match(details.action, /vmrun_get_guest_ip_address.*wait=true.*timeout_seconds/);
  assert.doesNotMatch(JSON.stringify(details), /DISK_PREFLIGHT|disk_manager_status/);

  const failedProbe = await call({ ipError: nativeError, toolsError: 'probe timeout test-password' });
  assert.equal(failedProbe.isError, true);
  const unknown = JSON.parse(failedProbe.content[0].text);
  assert.ok(unknown.message.includes(nativeError));
  assert.equal(unknown.toolsState.state, 'unknown');
  assert.match(unknown.toolsState.error, /timeout.*probe timeout \[REDACTED\]/);

  for (const ipOutput of ['', 'Error-looking success output']) {
    const invalid = await call({ ipOutput, toolsOutput: 'unexpected Tools state' });
    assert.equal(invalid.isError, true);
    const data = JSON.parse(invalid.content[0].text);
    assert.ok(data.message.includes(ipOutput || '(empty)'));
    assert.deepEqual(data.toolsState, { state: 'unknown', output: 'unexpected Tools state' });
  }

  const recovered = await call({ ipOutput: '192.0.2.10' });
  assert.ok(!recovered.isError);
  assert.deepEqual(JSON.parse(recovered.content[0].text), { vmx: await fs.realpath(vmx), address: '192.0.2.10' });
  const log = (await fs.readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.map(call => call.args[2]), [...Array(4).fill(['getGuestIPAddress', 'checkToolsState']).flat(), 'getGuestIPAddress']);
  assert.ok(log.every(call => call.args.length === 4 && call.args[3] === details.vmx));
  assert.ok(log.filter(call => call.args[2] === 'checkToolsState').every(call => call.timeout === 5000));
});
