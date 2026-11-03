// Explicit opt-in only: create one disposable VM and read its serial output.
// Never select an existing VM, send guest input, or use a host console/UI.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Workstation, isWithin } from '../src/workstation.mjs';

if (process.env.VMWARE_SERIAL_LIVE !== '1') throw new Error('Explicit opt-in required: VMWARE_SERIAL_LIVE=1 after authorization to create, boot and stop one disposable VM.');
if (!process.env.VMWARE_SERIAL_LIVE_ISO) throw new Error('Set VMWARE_SERIAL_LIVE_ISO to a bootable Linux ISO already configured for ttyS0 output.');
const iso = await new Workstation().hostPath(process.env.VMWARE_SERIAL_LIVE_ISO, 'input-file');
if (path.extname(iso).toLowerCase() !== '.iso') throw new Error('Live test requires a local ISO file.');
const marker = process.env.VMWARE_SERIAL_LIVE_EXPECT || 'login:';
if (marker.length > 256 || /[\x00-\x1f]/.test(marker)) throw new Error('Expected marker must be 1-256 printable characters.');
await fs.mkdir('test-vms', { recursive: true });
const root = await fs.realpath(await fs.mkdtemp(path.resolve('test-vms', 'serial-live-')));
const inventory = path.join(root, 'inventory.vmls'); await fs.writeFile(inventory, '');
const evidence = { root, started_at: new Date().toISOString(), platform: process.platform, passed: false, operations: [], limitations: ['Disposable Linux ISO boot only; no guest commands, ESXi console, or host UI interaction. Artifacts retained. No serial transcript is saved.'] };
const client = new Client({ name: 'disposable-live-serial-validation', version: '0.7.0' });
let vmx; let startAttempted = false;
async function call(name, args = {}) {
  for (const key of ['vmx', 'vm_id', 'directory']) if (args[key]) {
    assert.ok(path.isAbsolute(args[key]) && isWithin(root, path.resolve(args[key])), 'Mutation/read target must remain in disposable root.');
    let ancestor = args[key];
    while (true) {
      try { assert.ok(isWithin(root, await fs.realpath(ancestor)), 'Target must not escape through links.'); break; }
      catch (e) { if (e.code !== 'ENOENT') throw e; ancestor = path.dirname(ancestor); }
    }
  }
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  const value = JSON.parse(result.content[0].text);
  evidence.operations.push({ name, bytes: value.bytes, timed_out: value.timed_out });
  return value;
}
try {
  // A fresh inventory and root restrict all VM targets. The ISO is the sole
  // explicitly selected read-only external input to create_vm.
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('vmware-workstation/server/server.cjs')], env: { ...process.env, VMWARE_INVENTORY_PATH: inventory, VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: [root, path.dirname(iso)].join(path.delimiter) }, stderr: 'pipe' }));
  const before = (await call('list_vms')).vms.filter(vm => vm.running).map(vm => vm.vmx).sort();
  const created = await call('create_vm', { directory: path.join(root, 'vm'), name: 'Disposable serial validation', iso_path: iso, network: 'none', disk_gb: 1, memory_mb: 1024, cpus: 1 });
  vmx = created.vmx; evidence.vmx = vmx;
  await call('serial_configure', { vm_id: vmx, confirm: true });
  startAttempted = true;
  await call('vm_power', { vmx, action: 'start', gui: false });
  // Native VMware creates its pipe/socket asynchronously after power-on.
  const deadline = Date.now() + 30000; let connected = false;
  while (Date.now() < deadline && !connected) {
    try { await call('serial_connect', { vm_id: vmx, timeout_ms: 10000 }); connected = true; }
    catch (e) { if (Date.now() >= deadline) throw e; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  assert.ok(connected, 'Serial endpoint did not become available.');
  let output = Buffer.alloc(0); const digest = createHash('sha256'); const bootDeadline = Date.now() + 120000;
  while (Date.now() < bootDeadline && output.length < 1024 * 1024) {
    const read = await call('serial_read', { vm_id: vmx, max_bytes: 65536, timeout_ms: 1000 });
    const bytes = Buffer.from(read.data, 'base64'); output = Buffer.concat([output, bytes]); digest.update(bytes);
    if (output.includes(Buffer.from(marker))) break;
  }
  evidence.serial_bytes = output.length; evidence.serial_sha256 = digest.digest('hex');
  evidence.marker_seen = output.includes(Buffer.from(marker)); assert.ok(evidence.marker_seen, 'Expected guest serial marker was not observed within bounds.');
  await call('serial_disconnect', { vm_id: vmx });
  // Hard stop is explicitly part of opting into this disposable workload.
  await call('vm_power', { vmx, action: 'stop', mode: 'hard' }); startAttempted = false;
  await call('serial_configure', { vm_id: vmx, enabled: false, confirm: true });
  const after = (await call('list_vms')).vms.filter(vm => vm.running).map(vm => vm.vmx).sort();
  assert.deepEqual(after, before, 'Existing running VM set must stay unchanged.'); evidence.passed = true;
} finally {
  if (vmx && startAttempted) {
    await call('serial_disconnect', { vm_id: vmx }).catch(e => { evidence.disconnect_error = e.message; });
    await call('vm_power', { vmx, action: 'stop', mode: 'hard' }).catch(e => { evidence.stop_error = e.message; });
  }
  evidence.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  await client.close(); console.log(`Serial validation evidence: ${path.join(root, 'evidence.json')}`);
}
