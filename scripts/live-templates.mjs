// Opt-in: only NEW powered-off disposable targets; retain files and evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Workstation, isWithin } from '../src/workstation.mjs';

assert.equal(process.env.VMWARE_TEMPLATES_LIVE, '1', 'Requires disposable-workload authorization and VMWARE_TEMPLATES_LIVE=1.');
assert.ok(['win32', 'linux'].includes(process.platform) && !process.env.WSL_DISTRO_NAME, 'Native Workstation required; WSL live mutation refused.');
const backend = new Workstation(), before = await backend.run(['list']);
await fs.mkdir('test-vms', { recursive: true });
const parent = await fs.realpath('test-vms'), root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'templates-live-')));
assert.ok(isWithin(parent, root) && parent !== root);
const client = new Client({ name: 'disposable-template-validation', version: '0.13.0' });
const evidence = { platform: process.platform, power_on: false, registration: false, guest_boot: 'not tested' };
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe', env: {
    ...process.env, VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root,
  } }));
  const call = async (name, args) => {
    if (args.vmx) assert.ok(isWithin(root, await fs.realpath(args.vmx)));
    if (args.directory) assert.ok(isWithin(root, args.directory) && args.directory !== root);
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text);
  };
  const listed = await call('template_list', {}), caps = await call('vm_hardware_capabilities', {});
  assert.equal(caps.available, true);
  const template = listed.templates.find(t => t.id === 'nested-esxi');
  template.hardware_version = Math.min(21, caps.maximum_hardware_version);
  template.disks.forEach(d => { d.capacity_mb = 4; }); template.nics = [];
  const args = { template, directory: path.join(root, 'first') };
  evidence.plan = await call('template_validate', args);
  evidence.dry_run = await call('template_deploy', args);
  await assert.rejects(fs.stat(args.directory), { code: 'ENOENT' });
  evidence.created = await call('template_deploy', { ...args, dry_run: false, confirm: true });
  assert.equal(await fs.readFile(evidence.created.vmx, 'utf8'), evidence.plan.plan.vmx_text);
  evidence.inspected = await call('vm_hardware_get', { vmx: evidence.created.vmx }); assert.equal(evidence.inspected.disks.length, 2);
  evidence.exported = await call('template_export', { vmx: evidence.created.vmx, id: 'copy', name: 'Disposable portable copy' });
  evidence.copy = await call('template_deploy', { template: evidence.exported.template, directory: path.join(root, 'copy'), dry_run: false, confirm: true });
  evidence.unchanged_running_set = await backend.run(['list']) === before; assert.equal(evidence.unchanged_running_set, true);
  evidence.passed = true;
} catch (error) { evidence.passed = false; evidence.error = { code: error.code || 'VALIDATION_FAILED', message: error.message }; throw error; }
finally { await client.close(); await fs.writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(`Retained disposable files and evidence: ${root}`); }
