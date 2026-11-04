import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { assertCompatibleTool } from './tool-compatibility.mjs';

test('bundled template workflow preserves every previous tool and plans, deploys, inspects and exports headlessly', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hardware-mcp-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ext = process.platform === 'win32' ? '.exe' : '';
  for (const name of ['vmrun', 'vmware-vmx', 'vmware-vdiskmanager']) await fs.writeFile(path.join(root, name + ext), '', { mode: 0o755 });
  const preload = path.join(root, 'runner.cjs');
  await fs.writeFile(preload, String.raw`
const { promisify } = require('node:util');
const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
const stub = () => { throw new Error('Unexpected process callback'); };
stub[promisify.custom] = async (binary, args, options) => {
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  if (path.basename(binary).startsWith('vmware-vmx') || binary === 'pwsh' && options.env?.VMWARE_HARDWARE_VERSION_TARGET) return { stdout: 'VMware Workstation 26.0.1 build-25688693' };
  if (binary === 'pwsh') { assert.match(args.at(-1), /Get-Process/); return { stdout: '[]' }; }
  if (path.basename(binary).startsWith('vmware-vdiskmanager')) {
    if (!args.length) return { stdout: 'VMware Virtual Disk Manager\nUsage:\n -c : create\n -s : size\n -a : adapter\n -t : type\nDisk types:\n 0 : sparse\n' };
    const mb = Number(args[args.indexOf('-s') + 1].replace('MB',''));
    await fs.writeFile(args.at(-1), '# Disk DescriptorFile\nversion=1\nCID=12345678\nparentCID=ffffffff\ncreateType="monolithicSparse"\nRW '+mb*2048+' SPARSE "disk.vmdk"\nddb.adapterType="lsilogic"\n'); return { stdout: '' };
  }
  assert.deepEqual(args, ['-T', 'ws', 'list']); return { stdout: 'Total running VMs: 0' };
};
require('node:child_process').execFile = stub;
`);
  const client = new Client({ name: 'hardware-mcp', version: '1' }); t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--require', preload, path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe', env: {
    ...process.env, VMRUN_PATH: path.join(root, 'vmrun' + ext), VMWARE_VMX_PATH: path.join(root, 'vmware-vmx' + ext), VMWARE_VDISKMANAGER_PATH: path.join(root, 'vmware-vdiskmanager' + ext),
    VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root,
  } }));
  const tools = (await client.listTools()).tools; assert.equal(tools.length, 156);
  const previous = JSON.parse(await fs.readFile('tests/fixtures/pre-template-tool-schemas.json','utf8'));
  for (const prior of previous.tools) assertCompatibleTool(tools.find(t => t.name === prior.name), prior);
  const call = async (name, args) => { const r = await client.callTool({name, arguments: args}); assert.ok(!r.isError, JSON.stringify(r)); return JSON.parse(r.content[0].text); };
  const listed = await call('template_list', {}); assert.equal(listed.templates.length,3);
  const template = listed.templates.find(t => t.id === 'nested-esxi');
  template.disks.forEach(d => { d.capacity_mb = 1; });
  const args = {template, directory: path.join(root,'new'), networks:{management:{network:'nat'}, lab:{network:'hostonly'}}};
  const plan = await call('template_validate', args); assert.equal(plan.valid,true);
  assert.deepEqual((await call('template_deploy',args)).plan, plan.plan);
  await assert.rejects(fs.stat(args.directory), {code:'ENOENT'});
  assert.equal((await client.callTool({name:'template_deploy',arguments:{...args,dry_run:false}})).isError,true);
  const created = await call('template_deploy',{...args,dry_run:false,confirm:true});
  assert.equal(await fs.readFile(created.vmx,'utf8'),plan.plan.vmx_text);
  const hardware = await call('vm_hardware_get',{vmx:created.vmx}); assert.equal(hardware.disks.length,2); assert.equal(hardware.nested_virtualization,true);
  const exported = await call('template_export',{vmx:created.vmx,id:'portable',name:'Portable ESXi'});
  assert.equal(exported.template.disks.length,2); assert.ok(!JSON.stringify(exported).includes(root));
  assert.equal((await client.callTool({name:'template_validate',arguments:{...args,template:{...template,security:{secure_boot:false,vtpm:true}}}})).isError,true);
});
