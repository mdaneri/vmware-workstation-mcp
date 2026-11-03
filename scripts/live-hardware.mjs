// Opt-in disposable, powered-off hardware configuration validation only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Workstation, isWithin } from '../src/workstation.mjs';

assert.equal(process.env.VMWARE_HARDWARE_LIVE, '1', 'Requires explicit disposable workload authorization and VMWARE_HARDWARE_LIVE=1.');
assert.ok(['win32', 'linux'].includes(process.platform) && !process.env.WSL_DISTRO_NAME, 'Native Windows/Linux Workstation required; no WSL live mutations.');
const backend = new Workstation(), before = await backend.run(['list']);
const parent = await fs.realpath(await fs.mkdir(path.resolve('test-vms'), { recursive: true }).then(() => path.resolve('test-vms')));
const root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'hardware-live-')));
assert.ok(isWithin(parent, root) && parent !== root);
const client = new Client({ name: 'disposable-hardware-validation', version: '0.11.0' });
const evidence = { native_platform: process.platform, guest_execution: 'not tested', power_on: false };
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe', env: {
    ...process.env, VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root,
  } }));
  const call = async (name, args) => {
    if (args.vmx) assert.ok(isWithin(root, await fs.realpath(args.vmx)));
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text);
  };
  evidence.capabilities = await call('vm_hardware_capabilities', {}); assert.equal(evidence.capabilities.available, true);
  const created = await call('create_vm', { directory: path.join(root, 'vm'), name: 'Disposable nested ESXi hardware', guest_os: 'vmkernel8', cpus: 4, cores_per_socket: 2,
    hardware_version: Math.min(21, evidence.capabilities.maximum_hardware_version), memory_mb: 8192, firmware: 'efi', nested_virtualization: true,
    controllers: [{ type: 'lsilogic', index: 0 }, { type: 'pvscsi', index: 1 }, { type: 'sata', index: 0 }, { type: 'nvme', index: 0 }],
    disks: ['scsi', 'sata', 'nvme'].map(controller => ({ controller, controller_index: 0, unit: 0, capacity_mb: 4 })), nics: [] });
  evidence.created = created;
  evidence.before = await call('vm_hardware_get', { vmx: created.vmx }); assert.equal(evidence.before.disks.length, 3);
  evidence.edit = await call('vm_hardware_set', { vmx: created.vmx, confirm: true, cpus: 8, cores_per_socket: 4, secure_boot: true });
  evidence.after = await call('vm_hardware_get', { vmx: created.vmx }); assert.equal(evidence.after.sockets, 2); assert.equal(evidence.after.secure_boot, true);
  evidence.unchanged_running_set = await backend.run(['list']) === before; assert.equal(evidence.unchanged_running_set, true);
  evidence.passed = true;
} catch (e) { evidence.passed = false; evidence.error = { code: e.code || 'VALIDATION_FAILED', message: e.message }; throw e; }
finally { await client.close(); await fs.writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(`Retained disposable files and evidence: ${root}`); }
