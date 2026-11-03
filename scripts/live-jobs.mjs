// Opt-in; NEW powered-off disposable targets only. No guest or existing-VM mutation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isWithin } from '../src/workstation.mjs';
if (process.env.VMWARE_JOBS_LIVE !== '1') throw new Error('Authorize this disposable workload and set VMWARE_JOBS_LIVE=1.');
if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) throw new Error('Run on a native Windows/Linux VMware host, not WSL.');
await fs.mkdir(path.resolve('test-vms'), { recursive: true });
const base = await fs.realpath(path.resolve('test-vms'));
const root = await fs.mkdtemp(path.join(base, 'jobs-live-'));
const inventory = path.join(root, 'inventory.vmls'); await fs.writeFile(inventory, '');
const evidence = { root, started_at: new Date().toISOString(), operations: [], passed: false, limitations: ['No guest OS, boot, live cancellation or Linux hypervisor support inferred. Artifacts retained; no rollback.'] };
const client = new Client({ name: 'disposable-live-jobs', version: '0.12.0' });
const guard = async args => {
  for (const field of ['disk', 'destination', 'destination_vmx', 'directory', 'vmx']) if (args[field]) {
    let ancestor = args[field]; assert.ok(path.isAbsolute(ancestor) && isWithin(root, path.resolve(ancestor)), 'Target must stay in disposable root');
    while (true) {
      try { assert.ok(isWithin(root, await fs.realpath(ancestor)), 'Target resolves outside disposable root'); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); }
    }
  }
  for (const vmx of args.vmx_paths || []) await guard({ vmx });
};
const call = async (name, args = {}) => {
  await guard(args); for (const step of args.steps || []) await guard(step.arguments);
  const response = await client.callTool({ name, arguments: args }); assert.ok(!response.isError, JSON.stringify(response)); return JSON.parse(response.content[0].text);
};
const submit = steps => call('job_start', { confirm: true, timeout_seconds: 1800, steps });
const finish = async job => {
  for (let i = 0; i < 3600; i++) {
    const state = await call('job_status', { job_id: job.job_id });
    if (state.state !== 'running') { evidence.operations.push(state); assert.equal(state.state, 'succeeded', JSON.stringify(state)); return state; }
    await delay(500);
  }
  throw new Error('Live job exceeded harness deadline; inspect retained state.');
};
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe', env: {
    // Reference checks may read globally running VMs; guard every explicit
    // target above so all mutations remain in this newly allocated root.
    ...process.env, VMWARE_ALLOWED_ROOTS: '', VMWARE_ALLOWED_HOST_ROOTS: '', VMWARE_INVENTORY_PATH: inventory, VMWARE_JOB_DIRECTORY: path.join(root, 'journal'),
  } }));
  const running = async () => (await call('list_vms')).vms.filter(vm => vm.running).map(vm => vm.vmx).sort();
  const before = await running();
  const a = await call('create_vm', { directory: path.join(root, 'a'), name: 'Disposable job A', memory_mb: 256, cpus: 1, disk_gb: 1, network: 'none' });
  const b = await call('create_vm', { directory: path.join(root, 'b'), name: 'Disposable job B', memory_mb: 256, cpus: 1, disk_gb: 1, network: 'none' });
  // Inspect declared names rather than assuming a create_vm disk naming policy.
  const backing = async vm => {
    const details = await call('get_vm_details', { vmx: vm.vmx }); assert.equal(details.running, false);
    const name = Object.entries(details.hardware).find(([key, value]) => /\.filename$/i.test(key) && /\.vmdk$/i.test(value))?.[1];
    assert.ok(name); const target = path.resolve(path.dirname(vm.vmx), name);
    assert.ok(target.startsWith(root + path.sep)); return target;
  };
  const diskA = await backing(a), diskB = await backing(b);
  const conversion = (source, vm, name) => [{ operation: 'disk_convert', arguments: { disk: source, destination: path.join(root, name, 'disk.vmdk'), vmx_paths: [vm.vmx], confirm: true } }];
  const first = await submit(conversion(diskA, a, 'converted-a'));
  const second = await submit(conversion(diskB, b, 'converted-b'));
  await Promise.all([finish(first), finish(second)]);
  await finish(await submit([{ operation: 'disk_expand', arguments: { disk: diskA, capacity_mb: 2048, vmx_paths: [a.vmx], confirm: true } }]));
  await finish(await submit([{ operation: 'clone', arguments: { vmx: b.vmx, destination_vmx: path.join(root, 'clone-b', 'clone.vmx') } }]));
  assert.deepEqual(await running(), before); evidence.running_set_unchanged = true; evidence.passed = true;
} finally {
  await client.close(); evidence.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Evidence retained: ${path.join(root, 'evidence.json')}`);
}
