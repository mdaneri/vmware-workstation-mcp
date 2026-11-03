import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';


test('bundled labs preserve all previous contracts and deploy private two/three-VM labs headlessly with manifest recovery', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hardware-mcp-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ext = process.platform === 'win32' ? '.exe' : '';
  for (const name of ['vmrun', 'vmware-vmx', 'vmware-vdiskmanager']) await fs.writeFile(path.join(root, name + ext), '', { mode: 0o755 });
  const preload = path.join(root, 'runner.cjs');
  await fs.writeFile(preload, String.raw`
const { promisify } = require('node:util');
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
const running = new Set();
const stub = () => { throw new Error('Unexpected process callback'); };
stub[promisify.custom] = async (binary, args, options) => {
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  if (path.basename(binary).startsWith('vmware-vmx') || binary === 'pwsh' && options.env?.VMWARE_HARDWARE_VERSION_TARGET) return { stdout: 'VMware Workstation 26.0.1 build-25688693' };
  if (binary === 'pwsh') { if (!args.includes('-File')) assert.match(args.at(-1), /Get-Process/); return { stdout: '[]' }; }
  if (path.basename(binary).startsWith('vmware-vdiskmanager')) {
    if (!args.length) return { stdout: 'VMware Virtual Disk Manager\nUsage:\n -c : create\n -s : size\n -a : adapter\n -t : type\nDisk types:\n 0 : sparse\n' };
    const mb = Number(args[args.indexOf('-s') + 1].replace('MB',''));
    await fs.writeFile(args.at(-1), '# Disk DescriptorFile\nversion=1\nCID=12345678\nparentCID=ffffffff\ncreateType="monolithicSparse"\nRW '+mb*2048+' SPARSE "disk.vmdk"\nddb.adapterType="lsilogic"\n'); return { stdout: '' };
  }
  if (args[2] === 'start') running.add(args[3]);
  if (args[2] === 'stop') running.delete(args[3]);
  if (args[2] === 'listSnapshots') return { stdout: 'Total snapshots: 0' };
  return { stdout: 'Total running VMs: '+running.size+'\n'+[...running].join('\n') };
};
require('node:child_process').execFile = stub;
`);
  await fs.writeFile(path.join(root,'inventory'), '');
  let client = new Client({ name: 'labs-mcp', version: '1' }); t.after(() => client.close());
  const connection = { command: process.execPath, args: ['--require', preload, path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe', env: {
    ...process.env, VMRUN_PATH: path.join(root, 'vmrun' + ext), VMWARE_VMX_PATH: path.join(root, 'vmware-vmx' + ext), VMWARE_VDISKMANAGER_PATH: path.join(root, 'vmware-vdiskmanager' + ext),
    VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root, VMWARE_PREFERENCES_PATH: path.join(root, 'preferences'), VMWARE_INVENTORY_PATH: path.join(root, 'inventory'),
  } };
  await client.connect(new StdioClientTransport(connection));
  const tools = (await client.listTools()).tools; assert.equal(tools.length, 148);
  const previous = JSON.parse(await fs.readFile('tests/fixtures/pre-lab-tool-schemas.json','utf8'));
  for (const prior of previous.tools) assert.deepEqual(tools.find(t => t.name === prior.name), prior);
  const call = async (name, args) => { const r = await client.callTool({name, arguments: args}); assert.ok(!r.isError, JSON.stringify(r)); return JSON.parse(r.content[0].text); };
  const listed = await call('template_list', {});
  for (const example of ['two-vm', 'nested-esxi']) {
    const lab = JSON.parse(await fs.readFile(`vmware-workstation/labs/${example}.json`, 'utf8'));
    for (const v of lab.vms) { v.template = structuredClone(listed.templates.find(t => t.id === v.template)); v.template.disks.forEach(d => { d.capacity_mb = 1; }); }
    const args = { lab, directory: path.join(root,example), networks: example === 'nested-esxi' ? { management: { network: 'nat' } } : {} };
    const plan = await call('lab_validate', args); assert.equal(plan.valid,true);
    assert.deepEqual((await call('lab_deploy',args)).plan, plan.plan);
    await assert.rejects(fs.stat(args.directory), {code:'ENOENT'});
    assert.equal((await client.callTool({name:'lab_deploy',arguments:{...args,dry_run:false}})).isError,true);
    const deployed = await call('lab_deploy',{...args,dry_run:false,confirm:true});
    const status = await call('lab_status',{directory:args.directory}); assert.equal(status.observations.length,lab.vms.length);
    const segment = deployed.manifest.segments[0].id;
    const selected = example === 'two-vm' ? 'gateway' : 'esxi';
    const hardware = await call('vm_hardware_get',{vmx:path.join(args.directory,selected,'machine.vmx')});
    assert.ok(hardware.nics.some(n => n.segment_id === segment));
    if (example === 'nested-esxi') assert.equal(hardware.nested_virtualization,true);
    if (example === 'two-vm') { await client.close(); client = new Client({ name: 'labs-restart', version: '1' }); await client.connect(new StdioClientTransport(connection)); }
    await call('lab_deploy',{...args,dry_run:false,confirm:true,resume:true});
    await call('lab_start',{directory:args.directory,dry_run:false,confirm:true});
    assert.ok((await call('lab_status',{directory:args.directory})).observations.every(v=>v.running));
    await call('lab_stop',{directory:args.directory,dry_run:false,confirm:true});
    const retained = path.join(args.directory,selected,'user-file.txt'); await fs.writeFile(retained,'keep');
    const destroyed = await call('lab_destroy',{directory:args.directory,dry_run:false,confirm:true}); assert.equal(destroyed.manifest.state,'destroyed');
    assert.equal(await fs.readFile(retained,'utf8'),'keep');
  }
});
