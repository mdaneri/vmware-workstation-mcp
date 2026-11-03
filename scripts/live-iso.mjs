// Opt-in only, after authorization for a new disposable VM/installer workload.
// No existing VM mutation, host UI, implicit hard shutdown or deletion.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Workstation, isWithin } from '../src/workstation.mjs';
import { IsoManager } from '../src/iso.mjs';

assert.equal(process.env.VMWARE_ISO_LIVE, '1', 'Requires VMWARE_ISO_LIVE=1 after explicit workload authorization.');
assert.equal(process.env.VMWARE_ISO_LIVE_HARD_STOP, '1', 'Requires explicit hard-shutdown authorization for the new disposable installer VM.');
assert.ok(['win32', 'linux'].includes(process.platform) && !process.env.WSL_DISTRO_NAME, 'Run on native Windows/Linux VMware, not WSL.');
const iso = await new IsoManager({ backend: new Workstation() }).isoPath(process.env.VMWARE_ISO_LIVE_PATH);
const firmware = process.env.VMWARE_ISO_LIVE_FIRMWARE || 'bios'; assert.ok(['bios', 'efi'].includes(firmware));
await fs.mkdir(path.resolve('test-vms'), { recursive: true });
const root = await fs.realpath(await fs.mkdtemp(path.resolve('test-vms', 'iso-live-')));
const inventory = path.join(root, 'inventory.vmls'); await fs.writeFile(inventory, '');
const client = new Client({ name: 'disposable-iso-validation', version: '0.10.0' });
const evidence = { root, platform: process.platform, operations: [], passed: false, limitations: ['Headless power-on and media configuration only; installer/OS readiness is not asserted.', 'No boot-order or firmware-entry compatibility is claimed.', 'All VM, disk, backup and evidence artifacts are retained.'] };
let vmx, started = false;
const digest = async file => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
async function call(name, args = {}) {
  for (const field of ['vmx', 'directory']) if (args[field]) {
    assert.ok(path.isAbsolute(args[field]) && isWithin(root, path.resolve(args[field])), 'Mutation/inspection target must be inside new disposable root.');
    const existing = field === 'directory' ? path.dirname(args[field]) : args[field];
    assert.ok(isWithin(root, await fs.realpath(existing)), 'Canonical target escapes disposable root.');
  }
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  evidence.operations.push({ name, is_error: !!response.isError });
  assert.ok(!response.isError, `${name}: ${JSON.stringify(response.content)}`);
  return JSON.parse(response.content[0].text);
}
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe', env: {
    ...process.env, VMWARE_INVENTORY_PATH: inventory, VMWARE_ALLOWED_ROOTS: root,
    VMWARE_ALLOWED_HOST_ROOTS: [root, path.dirname(iso)].join(path.delimiter),
  } }));
  evidence.running_before = (await call('list_vms')).vms.filter(v => v.running).map(v => v.vmx).sort();
  evidence.iso_hash_before = await digest(iso);
  vmx = (await call('create_vm', { directory: path.join(root, 'vm'), name: 'Disposable ISO validation', firmware, disk_gb: 1, memory_mb: 1024, cpus: 1, network: 'none' })).vmx;
  assert.equal((await call('iso_list', { vmx })).devices.length, 0);
  const mounted = await call('iso_mount', { vmx, iso_path: iso, confirm: true });
  const selected = (await call('iso_list', { vmx })).devices.find(d => d.device === mounted.device);
  assert.equal(selected.iso_path, iso); assert.equal(selected.start_connected, true);
  await call('vm_power', { vmx, action: 'start', gui: false }); started = true;
  assert.equal((await call('get_vm_details', { vmx })).running, true);
  assert.equal((await call('iso_list', { vmx })).devices[0].iso_path, iso);
  // A blank installer VM has no Tools for a guaranteed soft stop. Hard stop is
  // deliberately not implicit: only this fresh disposable VM may be stopped,
  // and the workload's opt-in explicitly covers its hard shutdown.
  await call('vm_power', { vmx, action: 'stop', mode: 'hard' }); started = false;
  const ejected = await call('iso_eject', { vmx, device: mounted.device, confirm: true });
  assert.equal(ejected.iso_deleted, false);
  const after = (await call('iso_list', { vmx })).devices[0]; assert.equal(after.present, false); assert.equal(after.iso_path, null);
  assert.equal(await digest(iso), evidence.iso_hash_before);
  evidence.running_after = (await call('list_vms')).vms.filter(v => v.running).map(v => v.vmx).sort();
  assert.deepEqual(evidence.running_after, evidence.running_before);
  evidence.passed = true;
} finally {
  evidence.disposable_vm = vmx || null; evidence.disposable_vm_may_be_running = started;
  // Never hide a failed run by stopping/deleting a VM without its explicit flag.
  if (started && process.env.VMWARE_ISO_LIVE_HARD_STOP === '1') {
    try { await call('vm_power', { vmx, action: 'stop', mode: 'hard' }); evidence.disposable_vm_may_be_running = false; }
    catch { evidence.cleanup_failed = true; }
  }
  await client.close(); await fs.writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Retained evidence/artifacts: ${root}`);
}
