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
import { LanSegments } from '../src/lan-segments.mjs';
import { TemplateManager, builtinTemplates } from '../src/templates.mjs';
import { LabManager, orderLab } from '../src/labs.mjs';

async function fixture(t, platform = process.platform) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'labs-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [], running = new Set(), ext = process.platform === 'win32' ? '.exe' : '';
  for (const n of ['vmrun', 'vmware-vmx', 'vmware-vdiskmanager']) await fs.writeFile(path.join(root, n + ext), '', { mode: 0o755 });
  const backend = new Workstation({ env: { VMRUN_PATH: path.join(root, 'vmrun' + ext), VMWARE_VMX_PATH: path.join(root, 'vmware-vmx' + ext), VMWARE_VDISKMANAGER_PATH: path.join(root, 'vmware-vdiskmanager' + ext), VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root, VMWARE_PREFERENCES_PATH: path.join(root, 'preferences'), VMWARE_INVENTORY_PATH: path.join(root, 'inventory') }, run: async (binary, args, options) => {
    assert.equal(options.shell, false); calls.push({ binary, args });
    if (binary === 'pwsh' || binary.includes('vmware-vmx')) return { stdout: 'VMware Workstation 26.0.1 build-25688693' };
    if (binary.includes('vmware-vdiskmanager')) {
      if (!args.length) return { stdout: 'VMware Virtual Disk Manager\nUsage:\n -c : create\n -s : size\n -a : adapter\n -t : type\nDisk types:\n 0 : sparse\n' };
      const mb = Number(args[args.indexOf('-s') + 1].replace('MB', ''));
      await fs.writeFile(args.at(-1), `# Disk DescriptorFile\nversion=1\nCID=12345678\nparentCID=ffffffff\ncreateType="monolithicSparse"\nRW ${mb * 2048} SPARSE "disk.vmdk"\nddb.adapterType="lsilogic"\n`); return { stdout: '' };
    }
    if (args[2] === 'start') running.add(args[3]);
    if (args[2] === 'stop') running.delete(args[3]);
    if (args[2] === 'listSnapshots') return { stdout: 'Total snapshots: 0' };
    return { stdout: `Total running VMs: ${running.size}\n${[...running].join('\n')}` };
  } });
  backend.inventoryPath = path.join(root, 'inventory'); await fs.writeFile(backend.inventoryPath, '');
  const protectFile = async file => { await fs.chmod(file, 0o600); };
  const vmFiles = new VMFiles(backend, { protectSensitiveFile: protectFile });
  const lan = new LanSegments(backend, vmFiles, { assertGUIClosed: async () => {}, protectFile });
  const disks = new DiskManager({ backend, vmFiles, space: async () => ({ bavail: 1e12, bsize: 4096 }) });
  const hardware = new HardwareManager({ backend, vmFiles, disks, lan, platform, assertGUIClosed: async () => {} });
  hardware.assertGUIClosed = async () => {};
  const templates = new TemplateManager({ backend, hardware });
  const readinessCalls = [], readiness = { wait: async (kind, a) => { readinessCalls.push({ kind, id: path.basename(path.dirname(a.vmx)) }); return { ready: true }; } };
  const manager = new LabManager({ backend, templates, lan, readiness, protectFile });
  const template = structuredClone(builtinTemplates[0]); template.disks[0].capacity_mb = 1;
  const lab = { schema_version: '1.0', id: 'test', networks: { private: { kind: 'private_lan' } }, vms: [
    { id: 'client', template, networks: { primary: 'private' }, depends_on: ['gateway'], readiness: { kind: 'ip', timeout_seconds: 1, attempts: 2 } },
    { id: 'gateway', template, networks: { primary: 'private' }, readiness: { kind: 'boot', timeout_seconds: 1 } },
  ] };
  const args = { lab, directory: path.join(root, 'lab') };
  const deploy = extra => manager.deploy({ ...args, dry_run: false, confirm: true, ...extra });
  return { root, manager, lab, args, deploy, backend, lan, templates, hardware, calls, running, readiness, readinessCalls };
}

test('versioned graph rejects cycles, missing/duplicate IDs, unknown mappings and invalid readiness', () => {
  const node = id => ({ id, template: 'linux' });
  const lab = { schema_version: '1.0', id: 'lab', networks: {}, vms: [node('one'), { ...node('two'), depends_on: ['one'] }] };
  assert.deepEqual(orderLab(lab).order, ['one', 'two']);
  for (const patch of [
    { schema_version: '2' }, { credentials: {} }, { vms: [node('one'), node('one')] },
    { vms: [{ ...node('one'), depends_on: ['absent'] }] },
    { vms: [{ ...node('one'), depends_on: ['two'] }, { ...node('two'), depends_on: ['one'] }] },
    { vms: [{ ...node('one'), networks: { primary: 'absent' } }] },
    { vms: [{ ...node('one'), readiness: { kind: 'service' } }] },
  ]) assert.throws(() => orderLab({ ...lab, ...patch }));
});

test('published lab input schema accepts portable examples/defaults and rejects unknown fields', async () => {
  const ajv = new Ajv({ strict: false }), schema = JSON.parse(await fs.readFile('vmware-workstation/labs/schema-v1.json', 'utf8'));
  for (const name of ['two-vm', 'nested-esxi']) {
    const lab = JSON.parse(await fs.readFile(`vmware-workstation/labs/${name}.json`, 'utf8'));
    assert.ok(ajv.validate(schema, lab), JSON.stringify(ajv.errors)); orderLab(lab);
    assert.equal(ajv.validate(schema, { ...lab, credentials: 'forbidden' }), false);
  }
  const minimal = { schema_version: '1.0', id: 'minimal', networks: {}, vms: [{ id: 'one', template: 'linux' }] };
  assert.ok(ajv.validate(schema, minimal), JSON.stringify(ajv.errors));
});

for (const platform of ['win32', 'linux']) test(`${platform}: private two-VM plan writes nothing; deploy/resume/start/stop/destroy preserve unowned files/networks`, async t => {
  const f = await fixture(t, platform), before = await fs.readdir(f.root);
  const plan = await f.manager.validate(f.args); assert.deepEqual(plan.plan.order, ['gateway', 'client']);
  assert.deepEqual(await fs.readdir(f.root), before);
  assert.equal((await f.manager.deploy(f.args)).dry_run, true);
  await assert.rejects(f.manager.deploy({ ...f.args, dry_run: false }), { code: 'CONFIRM_REQUIRED' });
  const external = await f.lan.create({ name: 'external' });
  const created = await f.deploy(); assert.equal(created.manifest.state, 'deployed');
  const segment = created.manifest.segments[0];
  for (const v of created.manifest.vms) assert.match(await fs.readFile(path.join(f.args.directory, v.id, 'machine.vmx'), 'utf8'), new RegExp(segment.id));
  const diskCreates = () => f.calls.filter(c => c.binary.includes('vdiskmanager') && c.args.includes('-c')).length;
  const count = diskCreates(); await f.deploy({ resume: true }); assert.equal(diskCreates(), count);
  await assert.rejects(f.deploy({ resume: true, lab: { ...f.lab, id: 'different' } }), { code: 'RECIPE_CHANGED' });
  for (const action of ['start', 'stop', 'destroy']) {
    assert.equal((await f.manager.action(action, { directory: f.args.directory })).dry_run, true);
    await assert.rejects(f.manager.action(action, { directory: f.args.directory, dry_run: false }), { code: 'CONFIRM_REQUIRED' });
  }
  await f.manager.action('start', { directory: f.args.directory, dry_run: false, confirm: true });
  assert.deepEqual(f.readinessCalls.map(c => c.id), ['gateway', 'client']);
  const starts = f.calls.filter(c => c.args[2] === 'start'); assert.ok(starts.every(c => c.args.at(-1) === 'nogui'));
  await f.manager.action('start', { directory: f.args.directory, dry_run: false, confirm: true }); assert.equal(f.calls.filter(c => c.args[2] === 'start').length, 2);
  await assert.rejects(f.manager.action('destroy', { directory: f.args.directory, dry_run: false, confirm: true }), e => e.details.failure.code === 'VM_RUNNING');
  await f.manager.action('stop', { directory: f.args.directory, dry_run: false, confirm: true });
  assert.deepEqual(f.calls.filter(c => c.args[2] === 'stop').map(c => path.basename(path.dirname(c.args[3]))), ['client', 'gateway']);
  const unknown = path.join(f.args.directory, 'gateway', 'user.txt'); await fs.writeFile(unknown, 'keep');
  const result = await f.manager.action('destroy', { directory: f.args.directory, dry_run: false, confirm: true });
  assert.equal(result.manifest.state, 'destroyed'); assert.equal(await fs.readFile(unknown, 'utf8'), 'keep');
  assert.equal((await f.lan.list()).segments[0].id, external.segment.id); assert.equal((await f.lan.list()).segments.length, 1);
  assert.ok((await f.manager.status({ directory: f.args.directory })).manifest);
  await assert.rejects(fs.stat(path.join(f.args.directory, 'gateway', 'machine.vmx')), { code: 'ENOENT' });
  await f.manager.action('destroy', { directory: f.args.directory, dry_run: false, confirm: true });
});

test('readiness retries are bounded, gate dependents and resume does not duplicate power or disks', async t => {
  const f = await fixture(t); f.lab.vms[1].readiness.attempts = 2;
  f.readiness.wait = async () => ({ ready: false, result: 'timed_out' });
  await assert.rejects(f.deploy({ start: true }), e => e.code === 'LAB_PARTIAL_FAILURE' && e.details.failure.code === 'READINESS_FAILED');
  assert.equal(f.running.size, 1); assert.ok([...f.running][0].includes('gateway'));
  f.readiness.wait = async () => ({ ready: true }); await f.deploy({ resume: true, start: true });
  assert.equal(f.running.size, 2); assert.equal(f.calls.filter(c => c.args[2] === 'start').length, 2);
});

for (const binding of ['dot-segments', 'directory-alias']) test(`canonical ISO ${binding} bindings survive resume/start/stop/destroy without owning the ISO`, async t => {
  const f = await fixture(t), media = path.join(f.root, 'media'); await fs.mkdir(media);
  const iso = path.join(media, 'installer.iso'); await fs.writeFile(iso, 'installer');
  let input;
  if (binding === 'dot-segments') {
    await fs.mkdir(path.join(media, 'subdir')); input = `${media}${path.sep}subdir${path.sep}..${path.sep}installer.iso`;
  } else {
    const alias = path.join(f.root, 'media-alias'); await fs.symlink(media, alias, process.platform === 'win32' ? 'junction' : 'dir'); input = path.join(alias, 'installer.iso');
  }
  for (const v of f.lab.vms) { v.template.boot = { mode: 'iso', media: 'installer' }; v.media = { installer: 'install' }; }
  const args = { ...f.args, media: { install: input } }, canonical = await fs.realpath(iso);
  const plan = await f.manager.validate(args); assert.deepEqual(plan.plan.media_paths, { install: canonical });
  await f.manager.deploy({ ...args, dry_run: false, confirm: true });
  const saved = await f.manager.read(args.directory); assert.equal(saved.media.install, input); assert.equal(saved.media_paths.install, canonical);
  assert.ok((await f.manager.status({ directory: args.directory })).observations.every(v => v.running === false));
  await f.manager.deploy({ ...args, dry_run: false, confirm: true, resume: true });
  await f.manager.action('start', { directory: args.directory, dry_run: false, confirm: true }); assert.equal(f.running.size, 2);
  await f.manager.action('stop', { directory: args.directory, dry_run: false, confirm: true });
  if (binding === 'directory-alias') {
    if (process.platform === 'win32') await fs.rmdir(path.join(f.root, 'media-alias'));
    else await fs.unlink(path.join(f.root, 'media-alias'));
    const other = path.join(f.root, 'other-media'); await fs.mkdir(other); await fs.writeFile(path.join(other, 'installer.iso'), 'unselected');
    await fs.symlink(other, path.join(f.root, 'media-alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await f.manager.deploy({ ...args, dry_run: false, confirm: true, resume: true });
  }
  await f.manager.action('destroy', { directory: args.directory, dry_run: false, confirm: true });
  assert.equal(await fs.readFile(iso, 'utf8'), 'installer');
});

test('stored canonical media paths allow cleanup after source removal and reject an unselected ISO', async t => {
  const f = await fixture(t), iso = path.join(f.root, 'selected.iso'), other = path.join(f.root, 'other.iso');
  await fs.writeFile(iso, 'selected'); await fs.writeFile(other, 'unselected');
  for (const v of f.lab.vms) { v.template.boot = { mode: 'iso', media: 'installer' }; v.media = { installer: 'install' }; }
  await f.deploy({ media: { install: iso } });
  const vmx = path.join(f.args.directory, 'gateway', 'machine.vmx'), original = await fs.readFile(vmx, 'utf8');
  await fs.writeFile(vmx, original.replace(iso, other));
  await assert.rejects(f.manager.action('start', { directory: f.args.directory, dry_run: false, confirm: true }), e => e.details.failure.code === 'EXTERNAL_BACKING');
  await fs.writeFile(vmx, original); await fs.unlink(iso);
  await f.manager.action('destroy', { directory: f.args.directory, dry_run: false, confirm: true });
  assert.equal(await fs.readFile(other, 'utf8'), 'unselected');
});

test('legacy manifest media bindings resolve read-only and gain canonical paths on resume', async t => {
  const f = await fixture(t), iso = path.join(f.root, 'installer.iso'); await fs.writeFile(iso, 'installer');
  for (const v of f.lab.vms) { v.template.boot = { mode: 'iso', media: 'installer' }; v.media = { installer: 'install' }; }
  const media = { install: `${f.root}${path.sep}.${path.sep}installer.iso` }; await f.deploy({ media });
  const m = await f.manager.read(f.args.directory); delete m.media_paths; await f.manager.save(m);
  const before = await fs.readFile(path.join(f.args.directory, 'lab-manifest.json'), 'utf8');
  assert.ok((await f.manager.status({ directory: f.args.directory })).observations.every(v => v.running === false));
  assert.equal(await fs.readFile(path.join(f.args.directory, 'lab-manifest.json'), 'utf8'), before);
  await f.deploy({ media, resume: true }); assert.equal((await f.manager.read(f.args.directory)).media_paths.install, await fs.realpath(iso));
});

test('failed second VM records partial resources; restart refuses adoption and leaves first VM intact', async t => {
  const f = await fixture(t), realDeploy = f.templates.deploy.bind(f.templates);
  f.templates.deploy = async (a, extra) => { if (a.directory.endsWith('client')) { await fs.mkdir(a.directory); await fs.writeFile(path.join(a.directory, 'partial'), 'keep'); throw new Error('secret=never-journal'); } return realDeploy(a, extra); };
  await assert.rejects(f.deploy(), { code: 'LAB_PARTIAL_FAILURE' });
  const m = await f.manager.read(f.args.directory); assert.equal(m.vms.find(v => v.id === 'gateway').state, 'created'); assert.equal(m.vms[0].state, 'creating'); assert.ok(!JSON.stringify(m).includes('never-journal'));
  const restarted = new LabManager({ ...f.manager });
  await assert.rejects(restarted.deploy({ ...f.args, resume: true, dry_run: false, confirm: true }), e => e.details.failure.code === 'UNCERTAIN_RESOURCE');
  await assert.rejects(restarted.action('destroy', { directory: f.args.directory, dry_run: false, confirm: true }), e => e.details.failure.code === 'UNCERTAIN_RESOURCE');
  await fs.access(path.join(f.args.directory, 'gateway', 'machine.vmx'));
});

test('resume can retry an untouched pending destination after a command failed before creating it', async t => {
  const f = await fixture(t), realDeploy = f.templates.deploy.bind(f.templates);
  f.templates.deploy = async (a, extra) => { if (a.directory.endsWith('client')) throw new Error('before-files'); return realDeploy(a, extra); };
  await assert.rejects(f.deploy(), { code: 'LAB_PARTIAL_FAILURE' });
  f.templates.deploy = realDeploy; await f.deploy({ resume: true });
  assert.equal((await f.manager.read(f.args.directory)).state, 'deployed');
});

for (const attack of ['file', 'link', 'external', 'snapshot', 'registered', 'shared', 'unknown-disk', 'manifest']) test(`teardown fails closed for ${attack}`, async t => {
  const f = await fixture(t); await f.deploy();
  const vmx = path.join(f.args.directory, 'gateway', 'machine.vmx'), outside = path.join(f.root, 'outside'); await fs.writeFile(outside, 'never delete');
  if (attack === 'file') { await fs.rename(vmx, vmx + '.saved'); await fs.writeFile(vmx, 'replaced'); }
  if (attack === 'link') { const disk = path.join(f.args.directory, 'gateway', 'disk-0', 'disk.vmdk'); await fs.unlink(disk); await fs.link(outside, disk); }
  if (attack === 'external') await fs.appendFile(vmx, `workingDir = "${outside.replaceAll('\\', '/')}/.."\n`);
  if (attack === 'snapshot') f.backend.snapshots = async () => ({ snapshots: ['saved'] });
  if (attack === 'registered') await fs.writeFile(f.backend.inventoryPath, `vmlist0.config = "${vmx.replaceAll('\\', '/')}"\n`);
  if (attack === 'shared') {
    const externalVM = path.join(f.root, 'other.vmx'); await fs.writeFile(externalVM, `scsi0:0.fileName = "${path.join(f.args.directory, 'gateway', 'disk-0', 'disk.vmdk').replaceAll('\\', '/')}"\n`);
    await fs.writeFile(f.backend.inventoryPath, `vmlist0.config = "${externalVM.replaceAll('\\', '/')}"\n`);
  }
  if (attack === 'unknown-disk') await fs.writeFile(path.join(f.args.directory, 'gateway', 'unknown.vmdk'), 'keep');
  if (attack === 'manifest') { const m = await f.manager.read(f.args.directory); m.vms[0].files[0].path = '../outside'; await f.manager.save(m); }
  await assert.rejects(f.manager.action('destroy', { directory: f.args.directory, dry_run: false, confirm: true }));
  assert.equal(await fs.readFile(outside, 'utf8'), 'never delete'); await fs.access(path.join(f.args.directory, 'client', 'machine.vmx'));
});

test('cancellation and conflicting shared reservations leave recoverable state without starting dependents', async t => {
  const f = await fixture(t), hold = f.backend.resources.reserve([f.args.directory]);
  await assert.rejects(f.deploy(), { code: 'RESOURCE_BUSY' }); hold.release();
  await assert.rejects(f.manager.deploy({ ...f.args, dry_run: false, confirm: true }, { signal: AbortSignal.abort() }));
  await assert.rejects(fs.stat(f.args.directory), { code: 'ENOENT' });
  await f.deploy(); const controller = new AbortController();
  f.readiness.wait = async () => { controller.abort(); return { ready: false, result: 'cancelled' }; };
  await assert.rejects(f.manager.action('start', { directory: f.args.directory, dry_run: false, confirm: true }, { signal: controller.signal }), { code: 'LAB_PARTIAL_FAILURE' });
  assert.equal(f.running.size, 1);
});

test('teardown retries a failed owned-segment removal without recreating VMs or touching external segments', async t => {
  const f = await fixture(t); await f.deploy();
  const external = await f.lan.create({ name: 'keep-external' });
  const original = f.lan.remove.bind(f.lan); f.lan.remove = async () => { throw new Error('inventory changed'); };
  await assert.rejects(f.manager.action('destroy', { directory: f.args.directory, dry_run: false, confirm: true }), { code: 'LAB_PARTIAL_FAILURE' });
  assert.ok((await f.manager.read(f.args.directory)).vms.every(v => v.state === 'destroyed'));
  f.lan.remove = original;
  await f.manager.action('destroy', { directory: f.args.directory, dry_run: false, confirm: true });
  assert.deepEqual((await f.lan.list()).segments.map(s => s.id), [external.segment.id]);
});

test('stop never hard-falls back or claims power-off after an unverified native result', async t => {
  const f = await fixture(t); await f.deploy({ start: true });
  f.backend.power = async () => ({ commandSucceeded: true });
  await assert.rejects(f.manager.action('stop', { directory: f.args.directory, dry_run: false, confirm: true }), e => e.details.failure.code === 'POWER_UNVERIFIED');
  assert.equal(f.running.size, 2);
  assert.equal((await f.manager.read(f.args.directory)).vms.find(v => v.id === 'client').power_intent, 'stop');
});
