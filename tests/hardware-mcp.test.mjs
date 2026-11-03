import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { assertCompatibleTool } from './tool-compatibility.mjs';

test('bundled typed hardware tools preserve prior contracts and execute typed create/get/set headlessly', async t => {
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
  const tools = (await client.listTools()).tools; assert.equal(tools.length, 137);
  const previous = JSON.parse(await fs.readFile('tests/fixtures/pre-hardware-tool-schemas.json', 'utf8'));
  for (const prior of previous.tools) assertCompatibleTool(tools.find(t => t.name === prior.name), prior);
  const call = async (name, args) => { const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
  assert.equal((await call('vm_hardware_capabilities', {})).available, true);
  const created = await call('create_vm', { directory: path.join(root, 'nested'), name: 'Nested ESXi fixture', guest_os: 'vmkernel8', cpus: 4, cores_per_socket: 2, memory_mb: 8192, nested_virtualization: true,
    controllers: [{ type: 'lsilogic', index: 0 }, { type: 'nvme', index: 0 }],
    disks: [{ controller: 'scsi', controller_index: 0, unit: 0, capacity_mb: 1 }, { controller: 'nvme', controller_index: 0, unit: 0, capacity_mb: 1 }],
    nics: [{ index: 0, model: 'vmxnet3', network: 'custom', vmnet: 'vmnet2' }, { index: 1, model: 'e1000e', network: 'custom', vmnet: 'vmnet2' }] });
  const details = await call('get_vm_details', { vmx: created.vmx });
  assert.equal(details.hardware.displayName, 'Nested ESXi fixture');
  assert.equal(details.hardware.guestOS, 'vmkernel8');
  assert.equal(details.hardware['virtualHW.version'], '21');
  assert.equal(details.hardware['scsi0:0.fileName'], path.relative(path.dirname(created.vmx), created.disks[0]));
  assert.equal(details.hardware['nvme0:0.fileName'], path.relative(path.dirname(created.vmx), created.disks[1]));
  assert.equal(details.hardware['ethernet0.connectionType'], 'custom');
  assert.equal(details.hardware['ethernet1.connectionType'], 'custom');
  let got = await call('vm_hardware_get', { vmx: created.vmx }); assert.equal(got.disks.length, 2); assert.equal(got.nics.length, 2); assert.equal(got.nested_virtualization, true);
  await call('vm_hardware_set', { vmx: created.vmx, confirm: true, memory_mb: 16384 }); got = await call('vm_hardware_get', { vmx: created.vmx }); assert.equal(got.memory_mb, 16384);
  const error = await client.callTool({ name: 'vm_hardware_set', arguments: { vmx: created.vmx, confirm: true, vtpm: true } });
  assert.equal(error.isError, true); assert.equal(JSON.parse(error.content[0].text).code, 'UNSUPPORTED_CAPABILITY');
  assert.equal((await client.callTool({ name: 'vm_hardware_set', arguments: { vmx: created.vmx, memory_mb: 8192 } })).isError, true);
});
