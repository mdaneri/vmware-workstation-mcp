// Opt-in only. Creates NEW powered-off labs/private LANs and retains everything.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Workstation, isWithin } from '../src/workstation.mjs';

assert.equal(process.env.VMWARE_LABS_LIVE, '1', 'Requires separate disposable-workload authorization and VMWARE_LABS_LIVE=1. Creates private LAN catalog entries; close Workstation GUI.');
assert.ok(['win32', 'linux'].includes(process.platform) && !process.env.WSL_DISTRO_NAME, 'Native Workstation required; WSL live mutation refused.');
const backend = new Workstation(), before = await backend.run(['list']);
await fs.mkdir('test-vms', { recursive: true });
const parent = await fs.realpath('test-vms'), root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'labs-live-')));
assert.ok(isWithin(parent, root) && parent !== root);
const client = new Client({ name: 'disposable-lab-validation', version: '0.14.0' });
const evidence = { platform: process.platform, power_on: false, registration: false, guest_connectivity: 'not tested', teardown: 'not tested; artifacts and catalog entries retained', labs: [] };
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe', env: {
    ...process.env, VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root,
  } }));
  const call = async (name, args) => {
    if (args.directory) assert.ok(isWithin(root, args.directory) && args.directory !== root);
    if (args.vmx) assert.ok(isWithin(root, await fs.realpath(args.vmx)));
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
    assert.ok(!r.isError, JSON.stringify(r)); return JSON.parse(r.content[0].text);
  };
  const listed = await call('template_list', {}), caps = await call('vm_hardware_capabilities', {});
  assert.equal(caps.available, true);
  for (const example of ['two-vm', 'nested-esxi']) {
    const lab = JSON.parse(await fs.readFile(`vmware-workstation/labs/${example}.json`, 'utf8'));
    for (const v of lab.vms) {
      v.template = structuredClone(listed.templates.find(t => t.id === v.template));
      v.template.hardware_version = Math.min(21, caps.maximum_hardware_version);
      v.template.disks.forEach(d => { d.capacity_mb = 4; });
    }
    const args = { lab, directory: path.join(root, example), networks: example === 'nested-esxi' ? { management: { network: 'nat' } } : {} };
    const run = { example }; evidence.labs.push(run);
    run.plan = await call('lab_validate', args); run.dry_run = await call('lab_deploy', args);
    await assert.rejects(fs.stat(args.directory), { code: 'ENOENT' });
    run.deployed = await call('lab_deploy', { ...args, dry_run: false, confirm: true });
    run.status = await call('lab_status', { directory: args.directory }); assert.ok(run.status.observations.every(v => v.running === false));
    run.hardware = [];
    for (const v of lab.vms) run.hardware.push(await call('vm_hardware_get', { vmx: path.join(args.directory, v.id, 'machine.vmx') }));
    const segment = run.deployed.manifest.segments[0].id;
    assert.ok(run.hardware.some(v => v.nics.some(n => n.segment_id === segment)));
    run.resumed = await call('lab_deploy', { ...args, dry_run: false, confirm: true, resume: true });
  }
  evidence.unchanged_running_set = await backend.run(['list']) === before; assert.equal(evidence.unchanged_running_set, true);
  evidence.passed = true;
} catch (error) { evidence.passed = false; evidence.error = { code: error.code || 'VALIDATION_FAILED', message: error.message }; throw error; }
finally { await client.close(); await fs.writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(`Retained disposable labs, owned LAN segments and evidence: ${root}`); }
