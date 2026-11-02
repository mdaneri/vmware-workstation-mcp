// Explicitly creates/modifies ONE disposable VM when the user has authorized it.
// Never run this as part of the default test/smoke commands.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const parent = path.resolve('test-vms');
await fs.mkdir(parent, { recursive: true });
const directory = path.join(parent, `plugin-validation-${Date.now()}`);
const client = new Client({ name: 'authorized-disposable-vm-validation', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe' }));
const evidence = { createdAt: new Date().toISOString(), directory, results: [] };
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, JSON.stringify({ name, result }));
  const data = JSON.parse(result.content[0].text);
  evidence.results.push({ tool: name, data });
  console.log(JSON.stringify({ tool: name, data }));
  return data;
}
try {
  const created = await call('create_vm', { directory, name: 'Codex VMware Plugin Validation', memory_mb: 512, cpus: 1, disk_gb: 1, network: 'none' });
  evidence.vmx = created.vmx;
  await call('configure_vm', { vmx: created.vmx, settings: { memsize: '1024', numvcpus: '2', displayName: 'Codex VMware Plugin Validation - Modified' } });
  const details = await call('get_vm_details', { vmx: created.vmx });
  assert.equal(details.hardware.memsize, '1024'); assert.equal(details.hardware.numvcpus, '2'); assert.equal(details.running, false);
  await call('vmrun_list_snapshots', { vmx: created.vmx });
  evidence.passed = true;
} finally {
  await client.close();
  await fs.writeFile(path.join(parent, 'latest-validation.json'), JSON.stringify(evidence, null, 2) + '\n');
}
