import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { Workstation } from '../src/workstation.mjs';
import { VMFiles } from '../src/vm-files.mjs';
import { HardwareManager } from '../src/hardware.mjs';
import { DiskManager } from '../src/disks.mjs';
import { TemplateManager, builtinTemplates, validateTemplate } from '../src/templates.mjs';

async function fixture(t, platform = process.platform) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'templates-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ext = process.platform === 'win32' ? '.exe' : '', calls = [];
  for (const n of ['vmrun', 'vmware-vmx', 'vmware-vdiskmanager']) await fs.writeFile(path.join(root, n + ext), '', { mode: 0o755 });
  let version = 'VMware Workstation 26.0.1 build-25688693';
  const backend = new Workstation({ env: { VMRUN_PATH: path.join(root, 'vmrun' + ext), VMWARE_VMX_PATH: path.join(root, 'vmware-vmx' + ext), VMWARE_VDISKMANAGER_PATH: path.join(root, 'vmware-vdiskmanager' + ext), VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root }, run: async (binary, args, options) => {
    calls.push({ binary, args }); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    if (binary === 'pwsh' || binary.includes('vmware-vmx')) return { stdout: version };
    if (binary.includes('vmware-vdiskmanager')) {
      if (!args.length) return { stdout: 'VMware Virtual Disk Manager\nUsage:\n -c : create\n -s : size\n -a : adapter\n -t : type\nDisk types:\n 0 : sparse\n' };
      const mb = Number(args[args.indexOf('-s') + 1].replace('MB', ''));
      await fs.writeFile(args.at(-1), `# Disk DescriptorFile\nversion=1\nCID=12345678\nparentCID=ffffffff\ncreateType="monolithicSparse"\nRW ${mb * 2048} SPARSE "disk.vmdk"\nddb.adapterType="lsilogic"\n`); return { stdout: '' };
    }
    return { stdout: 'Total running VMs: 0' };
  } });
  const vmFiles = new VMFiles(backend), disks = new DiskManager({ backend, vmFiles, space: async () => ({ bavail: 1e12, bsize: 4096 }) });
  const hardware = new HardwareManager({ backend, vmFiles, disks, platform });
  const restCalls = [], rest = { request: async (...args) => { restCalls.push(args); return []; } };
  const manager = new TemplateManager({ backend, hardware, rest });
  const template = structuredClone(builtinTemplates[0]); template.disks[0].capacity_mb = 1;
  const input = { template, directory: path.join(root, 'new'), networks: { primary: { network: 'nat' } } };
  return { root, manager, backend, hardware, rest, restCalls, calls, template, input, setVersion: v => { version = v; } };
}

test('published JSON schema validates all examples; portable schema rejects host paths, secrets and unknown fields', async () => {
  const ajv = new Ajv({ strict: false }); const schema = JSON.parse(await fs.readFile('vmware-workstation/templates/schema-v1.json', 'utf8'));
  for (const example of builtinTemplates) { assert.ok(ajv.validate(schema, example)); validateTemplate(example); }
  for (const change of [{ schema_version: '2.0' }, { iso_path: '/host.iso' }, { credentials: {} }, { name: 'C:\\VMs\\guest' }, { guest_os: '../guest' }, { nics: [{ index: 0, model: 'vmxnet3', network: 'primary', start_connected: true, mac: '00:50:56:00:00:00' }] }]) {
    const t = { ...builtinTemplates[0], ...change }; assert.equal(ajv.validate(schema, t), false); assert.throws(() => validateTemplate(t));
  }
});

for (const platform of ['win32', 'linux']) test(`${platform}: dry-run writes nothing and deployed VMX/disks exactly match plan; exported template rebinds and redeploys`, async t => {
  const f = await fixture(t, platform), iso = path.join(f.root, 'installer.iso'); await fs.writeFile(iso, 'fixture');
  f.template.boot = { mode: 'iso', media: 'installer' };
  const input = { ...f.input, media: { installer: iso } };
  const before = await fs.readdir(f.root);
  const validated = await f.manager.validate(input), dry = await f.manager.deploy(input);
  assert.deepEqual(dry.plan, validated.plan); assert.deepEqual(await fs.readdir(f.root), before);
  assert.ok(!f.calls.some(c => c.args.includes('-c') || c.args.includes('start')));
  assert.equal(dry.plan.resources.virtual_disk_bytes, 1048576); assert.match(dry.plan.vmx_text, /sata0:0.deviceType = "cdrom-image"/);
  const created = await f.manager.deploy({ ...input, dry_run: false, confirm: true });
  assert.equal(await fs.readFile(created.vmx, 'utf8'), dry.plan.vmx_text);
  assert.deepEqual(created.disks, dry.plan.disks.map(d => d.path)); assert.equal(created.registered, false); assert.equal(created.poweredOn, false); assert.equal(f.restCalls.length, 0);
  await fs.appendFile(created.vmx, 'uuid.bios = "private-uuid"\nRemoteDisplay.vnc.password = "private-password"\nguestinfo.secret = "private-value"\nethernet0.generatedAddress = "00:0c:29:ab:cd:ef"\n');
  const exported = await f.manager.export({ vmx: created.vmx, id: 'copy', name: 'Portable copy' });
  const json = JSON.stringify(exported);
  for (const secret of [f.root, 'installer.iso', 'private-', '00:0c:29', 'vmnet', 'pvnID']) assert.ok(!json.includes(secret), secret);
  assert.deepEqual(exported.required_bindings, { networks: ['network0'], media: ['installer'] });
  const copy = await f.manager.deploy({ template: exported.template, directory: path.join(f.root, 'copy'), networks: { network0: { network: 'hostonly' } }, media: { installer: iso }, dry_run: false, confirm: true });
  assert.equal((await f.hardware.get({ vmx: copy.vmx })).disks.length, 1);
});

test('semantic, missing-media, unsupported hardware, collisions and binding failures leave destination absent', async t => {
  const f = await fixture(t);
  for (const change of [
    { cpu: { ...f.template.cpu, cpus: 3, cores_per_socket: 2 } }, { security: { secure_boot: true, vtpm: true } },
    { firmware: 'bios', security: { secure_boot: true, vtpm: false } }, { boot: { mode: 'pxe' } }, { boot: { mode: 'iso' } }, { boot: { mode: 'default', media: 'bad' } },
    { controllers: [{ type: 'lsilogic', index: 0 }, { type: 'pvscsi', index: 0 }] },
    { disks: [{ ...f.template.disks[0], unit: 7 }] }, { disks: [{ ...f.template.disks[0], controller_index: 1 }] },
    { disks: [f.template.disks[0], f.template.disks[0]] }, { nics: [f.template.nics[0], f.template.nics[0]] },
  ]) { await assert.rejects(f.manager.validate({ ...f.input, template: { ...f.template, ...change } })); await assert.rejects(fs.stat(f.input.directory), { code: 'ENOENT' }); }
  for (const change of [
    { networks: {} }, { networks: { primary: { network: 'custom' } } }, { networks: { primary: { network: 'nat', vmnet: 'vmnet2' } } },
    { networks: { primary: { network: 'nat' }, unused: { network: 'nat' } } },
    { networks: { primary: { network: 'lan_segment', segment: 'missing' } } },
    { media: { unused: '/missing.iso' } }, { template: { ...f.template, boot: { mode: 'iso', media: 'installer' } }, media: { installer: path.join(f.root, 'missing.iso') } },
    { directory: path.join(f.root, 'absent-parent', 'new') }, { directory: path.dirname(f.root) }, { template: 'missing' },
  ]) await assert.rejects(f.manager.validate({ ...f.input, ...change }));
  f.setVersion('VMware Workstation 17.0.0 build-123'); await assert.rejects(f.manager.validate(f.input), { code: 'UNSUPPORTED_CAPABILITY' });
  f.setVersion('VMware Workstation 26.0.1 build-25688693');
  f.hardware.disks.space = async () => ({ bavail: 0, bsize: 4096 }); await assert.rejects(f.manager.validate(f.input), { code: 'INSUFFICIENT_SPACE' });
  f.backend.env.VMWARE_ALLOWED_HOST_ROOTS = path.join(f.root, 'restricted'); await fs.mkdir(f.backend.env.VMWARE_ALLOWED_HOST_ROOTS);
  await assert.rejects(f.manager.validate(f.input), /outside/);
  await assert.rejects(fs.stat(f.input.directory), { code: 'ENOENT' });
});

test('deploy authorization and optional actions are explicit; failed actions retain created files with separate confirmed outcomes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.deploy({ ...f.input, dry_run: false }), { code: 'CONFIRM_REQUIRED' });
  assert.equal((await f.manager.deploy({ ...f.input, register: true, power_on: true })).dry_run, true);
  assert.deepEqual(f.restCalls.map(c => c[0]), ['GET']);
  let powered = 0; f.backend.power = async (vmx, action, mode, gui) => { assert.equal(action, 'start'); assert.equal(gui, false); powered++; };
  const result = await f.manager.deploy({ ...f.input, dry_run: false, confirm: true, register: true, power_on: true });
  assert.equal(result.registered, true); assert.equal(result.poweredOn, true); assert.equal(powered, 1);
  await assert.rejects(f.manager.deploy({ ...f.input, dry_run: false, confirm: true }), { code: 'TARGET_EXISTS' });
  const second = { ...f.input, directory: path.join(f.root, 'second'), dry_run: false, confirm: true, register: true, power_on: true };
  f.rest.request = async method => { if (method === 'POST') throw new Error('private transport details'); return []; };
  await assert.rejects(f.manager.deploy(second), e => e.code === 'POST_DEPLOY_FAILED' && e.details.registered === false && !e.message.includes('private'));
  await fs.access(path.join(second.directory, 'machine.vmx')); assert.equal(powered, 1);
  f.rest.request = async () => []; f.backend.power = async () => { throw new Error('failure'); };
  await assert.rejects(f.manager.deploy({ ...second, directory: path.join(f.root, 'third') }), e => e.details.registered === true && e.details.poweredOn === false && e.details.failed_stage === 'power_on');
});

test('registration preflight, cancellation, busy resources and partial disk failure do not silently deploy or replay', async t => {
  const f = await fixture(t);
  f.rest.request = async () => { throw new Error('REST unavailable'); };
  await assert.rejects(f.manager.deploy({ ...f.input, dry_run: false, confirm: true, register: true }));
  await assert.rejects(fs.stat(f.input.directory), { code: 'ENOENT' });
  await assert.rejects(f.manager.deploy({ ...f.input, dry_run: false, confirm: true }, { signal: AbortSignal.abort() }));
  const reservation = f.backend.resources.reserve([f.input.directory]);
  try { await assert.rejects(f.manager.deploy({ ...f.input, dry_run: false, confirm: true }), { code: 'RESOURCE_BUSY' }); } finally { reservation.release(); }
  f.template.disks.push({ ...f.template.disks[0], unit: 1 });
  const perform = f.hardware.disks.perform.bind(f.hardware.disks); let count = 0;
  f.hardware.disks.perform = (...args) => { if (++count === 2) throw Object.assign(new Error('failed'), { code: 'DISK_OPERATION_FAILED' }); return perform(...args); };
  await assert.rejects(f.manager.deploy({ ...f.input, dry_run: false, confirm: true }), { code: 'DISK_OPERATION_FAILED' });
  await fs.access(path.join(f.input.directory, 'disk-0', 'disk.vmdk')); await assert.rejects(fs.stat(path.join(f.input.directory, 'machine.vmx')), { code: 'ENOENT' });
});

test('template export rejects encrypted, running and unsupported layouts without creating output', async t => {
  const f = await fixture(t), created = await f.manager.deploy({ ...f.input, dry_run: false, confirm: true });
  const input = { vmx: created.vmx, id: 'safe', name: 'Safe export' }, original = await fs.readFile(created.vmx, 'utf8');
  for (const extra of ['encryption.keySafe = "never-export"', 'vtpm.present = "TRUE"', 'MEMSIZE = "1024"', 'broken line']) {
    await fs.writeFile(created.vmx, original + extra + '\n'); await assert.rejects(f.manager.export(input));
  }
  await fs.writeFile(created.vmx, original.replace('vhv.enable = "FALSE"', 'vhv.enable = "unknown"'));
  await assert.rejects(f.manager.export(input), { code: 'UNSUPPORTED_CAPABILITY' });
  await fs.writeFile(created.vmx, original); const details = f.backend.details;
  f.backend.details = async () => ({ running: true }); await assert.rejects(f.manager.export(input), { code: 'VM_RUNNING' }); f.backend.details = details;
  const disk = created.disks[0]; await fs.writeFile(disk, (await fs.readFile(disk, 'utf8')).replace('parentCID=ffffffff', 'parentCID=12345678'));
  await assert.rejects(f.manager.export(input), { code: 'UNSUPPORTED_DISK' });
});
