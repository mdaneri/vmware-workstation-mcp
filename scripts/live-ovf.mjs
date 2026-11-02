// Opt-in: creates one disposable powered-off VM and appliance round trips under test-vms/.
// Never registers, powers on, deletes or modifies an existing VM. Never used in hosted CI.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve('test-vms', `ovf-live-${Date.now()}`); await fs.mkdir(root, { recursive: true });
const evidence = { started_at: new Date().toISOString(), root, operations: [], passed: false, limitations: ['No guest OS, registration, power-on or remote deployment tested. Test artifacts are retained for inspection.'] };
const client = new Client({ name: 'isolated-live-ovf-validation', version: '0.5.0' });
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return JSON.parse(result.content[0].text);
}
async function transfer(name, args) {
  const job = await call(name, args); let state;
  do { await delay(250); state = await call('job_status', { job_id: job.job_id }); } while (state.state === 'running');
  const log = await call('job_logs', { job_id: job.job_id });
  evidence.operations.push({ name, args, state, log });
  assert.equal(state.state, 'succeeded', JSON.stringify({ name, state, log }));
  console.log(`${name}: ${state.state}${state.result?.destination ? ' → ' + state.result.destination : ''}`);
  return state.result;
}
try {
  const env = { ...process.env, VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root };
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('vmware-workstation/server/server.cjs')], env, stderr: 'pipe' }));
  const status = await call('ovf_tool_status'); evidence.tool = status; assert.equal(status.available, true, JSON.stringify(status));
  const created = await call('create_vm', { directory: path.join(root, 'source'), name: 'MCP OVF Isolated Validation', memory_mb: 256, cpus: 1, disk_gb: 1, network: 'none' });
  evidence.source_vmx = created.vmx;
  const ova = await transfer('ovf_export', { vmx: created.vmx, destination: path.join(root, 'exported.ova') });
  await transfer('ovf_inspect', { source: ova.destination });
  await transfer('ovf_validate', { source: ova.destination });
  const imported = await transfer('ovf_import', { source: ova.destination, directory: path.join(root, 'imported'), name: 'MCP OVF Imported Validation' });
  assert.equal((await call('get_vm_details', { vmx: imported.destination })).running, false);
  const ovf = await transfer('ovf_convert', { source: ova.destination, destination: path.join(root, 'ovf-package', 'appliance.ovf') });
  await transfer('ovf_inspect', { source: ovf.destination });
  await transfer('ovf_validate', { source: ovf.destination });
  await transfer('ovf_convert', { source: ovf.destination, destination: path.join(root, 'repacked.ova') });
  // A schema failure must be reported as failed without modifying the descriptor.
  const malformed = path.join(root, 'invalid.ovf'); const invalid = '<Envelope xmlns="http://schemas.dmtf.org/ovf/envelope/1"><Unexpected/></Envelope>';
  await fs.writeFile(malformed, invalid);
  const job = await call('ovf_validate', { source: malformed }); let failed;
  do { await delay(100); failed = await call('job_status', { job_id: job.job_id }); } while (failed.state === 'running');
  evidence.negative_validation = failed; assert.equal(failed.state, 'failed'); assert.equal(await fs.readFile(malformed, 'utf8'), invalid);
  evidence.passed = true;
} finally {
  await client.close();
  evidence.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Evidence: ${path.join(root, 'evidence.json')}`);
}
