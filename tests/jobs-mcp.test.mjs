import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { assertCompatibleTool } from './tool-compatibility.mjs';

test('bundled job submission preserves all prior inputs; verifies disk, clone, power batches and crash recovery', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-mcp-')));
  const clients = []; t.after(async () => { for (const client of clients) await client.close(); await delay(1200); await fs.rm(root, { recursive: true, force: true }); });
  const ext = process.platform === 'win32' ? '.exe' : '';
  const vmrun = path.join(root, 'vmrun' + ext), diskManager = path.join(root, 'vmware-vdiskmanager' + ext);
  await fs.writeFile(vmrun, '', { mode: 0o755 }); await fs.writeFile(diskManager, '', { mode: 0o755 });
  const source = path.join(root, 'source'); await fs.mkdir(source);
  const vmx = path.join(source, 'source.vmx'), disk = path.join(source, 'disk.vmdk');
  await fs.writeFile(vmx, '.encoding = "UTF-8"\nscsi0.present = "TRUE"\nscsi0.virtualDev = "lsilogic"\nscsi0:0.present = "TRUE"\nscsi0:0.fileName = "disk.vmdk"\n');
  await fs.writeFile(disk, '# Disk DescriptorFile\nversion=1\nCID=12345678\nparentCID=ffffffff\ncreateType="monolithicSparse"\nRW 2048 SPARSE "disk.vmdk"\nddb.adapterType="lsilogic"\n');
  const inventory = path.join(root, 'inventory.vmls'); await fs.writeFile(inventory, '');
  const preload = path.join(root, 'runner.cjs');
  await fs.writeFile(preload, String.raw`
const cp = require('node:child_process'), {promisify} = require('node:util'), path = require('node:path');
const nativeExecute = promisify(cp.execFile), nativeSpawn = cp.spawn;
const stub = () => { throw new Error('Unexpected process callback'); };
stub[promisify.custom] = async (file, args, options) => {
  if (file === process.env.VMWARE_VDISKMANAGER_PATH && !args.length) return {stdout:'VMware Virtual Disk Manager\nUsage:\n -r : convert\n -x : expand\n -t : type\nDisk types:\n 0 : sparse\n'};
  return nativeExecute(file, args, options);
};
cp.execFile = stub;
cp.spawn = (file, args, options) => {
  if (file === process.env.VMRUN_PATH || file === process.env.VMWARE_VDISKMANAGER_PATH) return nativeSpawn(process.execPath, [process.env.JOB_WORKER, 'backend', file === process.env.VMRUN_PATH ? 'vmrun' : 'disk', ...args], options);
  return nativeSpawn(file,args,options);
};
`);
  const connect = async (extra = {}) => {
    const client = new Client({ name: 'jobs-mcp', version: '1' }); clients.push(client);
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--require', preload, path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe', env: {
      ...process.env, VMRUN_PATH: vmrun, VMWARE_VDISKMANAGER_PATH: diskManager, VMWARE_INVENTORY_PATH: inventory,
      VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root, VMWARE_JOB_DIRECTORY: path.join(root, 'journal'),
      JOB_CALLS: path.join(root, 'calls.jsonl'), JOB_WORKER: path.resolve('tests/fixtures/job-worker.mjs'), ...extra,
    } });
    await client.connect(transport);
    const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, JSON.stringify(r)); return JSON.parse(r.content[0].text); };
    const finish = async job => { for (let i = 0; i < 200; i++) { const state = await call('job_status', { job_id: job.job_id }); if (state.state !== 'running') return state; await delay(50); } throw new Error('Job did not finish'); };
    return { client, transport, call, finish };
  };
  const f = await connect();
  const tools = (await f.client.listTools()).tools; assert.equal(tools.length, 150);
  const prior = JSON.parse(await fs.readFile('tests/fixtures/pre-jobs-tool-schemas.json', 'utf8'));
  for (const tool of prior.tools) assertCompatibleTool(tools.find(t => t.name === tool.name), tool);
  assert.equal((await f.client.callTool({ name: 'job_start', arguments: { steps: [] } })).isError, true);
  assert.equal((await f.client.callTool({ name: 'job_start', arguments: { confirm: true, steps: [{ operation: 'shell', arguments: {} }] } })).isError, true);
  const converted = path.join(root, 'converted', 'disk.vmdk');
  const job = await f.call('job_start', { confirm: true, steps: [
    { operation: 'disk_convert', arguments: { disk, destination: converted, confirm: true } },
    { operation: 'disk_expand', arguments: { disk, capacity_mb: 2, confirm: true } },
    { operation: 'clone', arguments: { vmx, destination_vmx: path.join(root, 'clone', 'clone.vmx') } },
    { operation: 'vm_power', arguments: { vmx, action: 'stop' } },
  ] });
  const done = await f.finish(job); assert.equal(done.state, 'succeeded', done.error);
  assert.equal(done.result.completed_steps.length, 4); assert.equal(done.progress, null);
  assert.equal(done.result.completed_steps[0].result.capacity_bytes, 1048576);
  assert.equal(done.result.completed_steps[1].result.capacity_bytes, 2097152);
  assert.equal(done.result.completed_steps[2].result.output_verified, true);
  const calls = (await fs.readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(c => c.args.includes('clone') && c.args.includes('full')));
  assert.ok(!calls.some(c => c.args.includes('gui')));
  await f.client.close();
  const slow = await connect({ JOB_TEST_DELAY: '1000' });
  assert.equal((await slow.call('job_status', { job_id: job.job_id })).state, 'succeeded');
  const interrupted = await slow.call('job_start', { confirm: true, steps: [{ operation: 'vm_power', arguments: { vmx, action: 'stop' } }] });
  await delay(700); process.kill(slow.transport.pid, 'SIGKILL'); await slow.client.close();
  const restarted = await connect();
  const recovered = await restarted.call('job_status', { job_id: interrupted.job_id });
  assert.equal(recovered.state, 'interrupted'); assert.match(recovered.error, /unknown/); assert.equal(recovered.result, undefined);
  assert.ok((await restarted.call('job_list')).jobs.some(j => j.job_id === job.job_id));
});
