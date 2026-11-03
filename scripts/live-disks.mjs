// Opt-in only. Creates disposable, powered-off VMs/disks; never opens an existing VM.
// Run after explicit authorization for this workload. No hosted CI or automatic cleanup.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve('test-vms', `disk-live-${Date.now()}`); await fs.mkdir(root, { recursive: true });
const inventory = path.join(root, 'inventory.vmls'); await fs.writeFile(inventory, '');
const evidence = { root, started_at: new Date().toISOString(), operations: [], passed: false, limitations: ['Powered-off disposable disks only. No guest filesystem resize or boot tested. Native Linux VMware needs a separate authorized run. All artifacts retained.'] };
const client = new Client({ name: 'isolated-live-disk-validation', version: '0.6.0' });
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 3600000 });
  evidence.operations.push({ name, args, result });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return JSON.parse(result.content[0].text);
}
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('vmware-workstation/server/server.cjs')], env: { ...process.env, VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root, VMWARE_INVENTORY_PATH: inventory }, stderr: 'pipe' }));
  const status = await call('disk_manager_status'); assert.equal(status.available, true);
  const vm = await call('create_vm', { directory: path.join(root, 'vm'), name: 'Disposable disk validation', disk_gb: 1, memory_mb: 256, cpus: 1, network: 'none' });
  const disk = path.join(root, 'extra', 'data.vmdk');
  await call('disk_create', { destination: disk, capacity_mb: 8 });
  assert.equal((await call('disk_inspect', { disk })).capacity_bytes, 8 * 1024 * 1024);
  await call('disk_expand', { disk, capacity_mb: 16, confirm: true });
  assert.equal((await call('disk_inspect', { disk })).capacity_bytes, 16 * 1024 * 1024);
  for (const type of status.disk_types.filter(type => ['0', '1', '2', '3'].includes(type.id))) {
    await call('disk_create', { destination: path.join(root, `create-${type.id}`, 'disk.vmdk'), capacity_mb: 8, disk_type: type.id });
    const converted = await call('disk_convert', { disk, destination: path.join(root, `convert-${type.id}`, 'disk.vmdk'), disk_type: type.id, confirm: true });
    assert.equal(converted.source_preserved, true); assert.equal(converted.capacity_bytes, 16 * 1024 * 1024);
  }
  const slot = { vmx: vm.vmx, disk, controller: 'scsi', controller_index: 0, unit: 1, confirm: true };
  await call('disk_attach', slot);
  await call('disk_expand', { disk, capacity_mb: 24, vmx_paths: [vm.vmx], confirm: true });
  await call('disk_detach', slot); await fs.access(disk);
  for (const [operation, name] of [['compact', 'disk_compact'], ['defragment', 'disk_defragment']]) if (status.operations[operation]) await call(name, { disk, confirm: true });
  assert.equal((await call('disk_inspect', { disk })).capacity_bytes, 24 * 1024 * 1024);
  evidence.passed = true;
} finally {
  await client.close(); evidence.finished_at = new Date().toISOString();
  const output = path.join(root, 'evidence.json'); await fs.writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Evidence: ${output}`);
}
