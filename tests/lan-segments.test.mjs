import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workstation, parseAssignments } from '../src/workstation.mjs';
import { VMFiles } from '../src/vm-files.mjs';
import { LanSegments, parseLanPreferences, assertLanGUIClosed, lanSegmentSchemas } from '../src/lan-segments.mjs';
import { preferencesPath } from '../src/host-platform.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const first = '52 00 01 02 03 04 05 06-07 08 09 0a 0b 0c 0d 0e';
const second = '52 10 11 12 13 14 15 16-17 18 19 1a 1b 1c 1d 1e';
const prefs = (segments = [{ name: 'Lab A', id: first }], encoding = 'UTF-8') => `.encoding = "${encoding}"\npref.namedPVNs.count = "${segments.length}"\n` + segments.map((s, i) => `pref.namedPVNs${i}.name = "${s.name}"\npref.namedPVNs${i}.pvnID = "${s.id}"\n`).join('');
const vmText = 'displayName = "Lab"\n.encoding = "UTF-8"\nmemsize = "512"\nethernet0.present = "TRUE"\nethernet0.virtualDev = "vmxnet3"\nethernet0.address = "00:50:56:00:00:01"\nethernet0.connectionType = "custom"\nethernet0.vnet = "vmnet9"\nethernet1.present = "TRUE"\nethernet1.connectionType = "nat"\n';

async function fixture(t, initial = prefs()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-lan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vmx = path.join(root, 'lab.vmx');
  const filename = path.join(root, 'preferences');
  const inventory = path.join(root, 'inventory.vmls');
  const binary = path.join(root, process.platform === 'win32' ? 'vmrun.exe' : 'vmrun');
  await fs.writeFile(binary, '', { mode: 0o755 });
  await fs.writeFile(vmx, vmText);
  await fs.writeFile(inventory, `vmlist0.config = "${vmx}"\n`);
  if (initial !== null) await fs.writeFile(filename, initial);
  let running = [], guiOpen = false;
  const backend = new Workstation({ env: { VMRUN_PATH: binary, VMWARE_INVENTORY_PATH: inventory, VMWARE_PREFERENCES_PATH: filename }, run: async () => ({ stdout: `Total running VMs: ${running.length}\n${running.join('\n')}` }) });
  const files = new VMFiles(backend);
  const protectedFiles = [];
  const options = { assertGUIClosed: async () => { if (guiOpen) throw new Error('Close the Workstation GUI first.'); }, protectFile: async file => { assert.equal((await fs.stat(file)).size, 0); protectedFiles.push(file); } };
  const lan = new LanSegments(backend, files, options);
  return { root, vmx, filename, inventory, backend, files, lan, options, protectedFiles, setRunning: value => { running = value; }, setGUI: value => { guiOpen = value; }, config: async () => parseAssignments(await fs.readFile(vmx, 'utf8')) };
}

test('preferences use platform defaults and an explicit environment override', () => {
  const home = path.resolve('home');
  assert.equal(preferencesPath({ APPDATA: home }, 'win32', home), path.join(home, 'VMware', 'preferences.ini'));
  assert.equal(preferencesPath({}, 'linux', home), path.join(home, '.vmware', 'preferences'));
  assert.equal(preferencesPath({ VMWARE_PREFERENCES_PATH: 'override' }, 'linux', home), 'override');
});

test('lists catalog and all adapter indices without modifying files, including orphaned IDs', async t => {
  const f = await fixture(t);
  await fs.appendFile(f.vmx, `ethernet1.pvnID = "${second}"\n`);
  f.setGUI(true); // Read-only listing is available while Workstation is open.
  const result = await f.lan.list({ vmx: f.vmx });
  assert.deepEqual(result.segments, [{ name: 'Lab A', id: first }]);
  assert.deepEqual(result.adapters.map(a => a.adapter), [0, 1]);
  assert.equal(result.adapters[1].segmentId, second);
  assert.equal(result.adapters[1].segmentName, null);
  assert.equal((await fs.readdir(f.root)).some(name => /backup|lock|edit-/.test(name)), false);
});

test('creates unique VMware-format IDs, backs up preferences privately, and preserves unrelated Windows bytes', async t => {
  const original = Buffer.from(prefs([{ name: 'Caf\xe9', id: first }], 'windows-1252').replaceAll('\n', '\r\n') + 'unrelated = "\x80\xe9|7C"\r\n', 'latin1');
  const f = await fixture(t, original);
  const created = await f.lan.create({ name: 'Réseau "B" | test' });
  assert.equal(created.created, true);
  assert.match(created.segment.id, /^52 (?:[a-f0-9]{2} ){6}[a-f0-9]{2}-(?:[a-f0-9]{2} ){7}[a-f0-9]{2}$/);
  assert.deepEqual(await fs.readFile(created.backup), original);
  const after = await fs.readFile(f.filename);
  assert.ok(after.includes(Buffer.from('unrelated = "\x80\xe9|7C"\r\n', 'latin1')));
  assert.equal(parseLanPreferences(after).segments[1].name, 'Réseau "B" | test');
  assert.equal(parseLanPreferences(after).segments[0].name, 'Café');
  assert.equal(f.protectedFiles.length, 2);
  const repeated = await f.lan.create({ name: 'réseau "b" | TEST' });
  assert.equal(repeated.created, false);
  assert.equal(repeated.segment.id, created.segment.id);
  await assert.rejects(f.lan.create({ name: '研究' }), /represented/);
  assert.deepEqual(await fs.readFile(f.filename), after);
});

test('UTF-8 Unicode names and BOM survive updates; missing preferences can be initialized', async t => {
  const f = await fixture(t, '\uFEFF' + prefs());
  await f.lan.create({ name: '研究 réseau' });
  assert.equal((await f.lan.list()).segments[1].name, '研究 réseau');
  assert.equal((await fs.readFile(f.filename, 'utf8')).charCodeAt(0), 0xfeff);
  await fs.unlink(f.filename);
  assert.deepEqual((await f.lan.list()).segments, []);
  const result = await f.lan.create({ name: 'New lab' });
  assert.equal(result.backup, null);
  assert.equal((await f.lan.list()).segments[0].name, 'New lab');
});

test('malformed, incomplete, duplicate and unsupported catalogs fail without writes', async t => {
  const f = await fixture(t);
  for (const text of [
    prefs().replace('count = "1"', 'count = "2"'),
    prefs() + `pref.namedPVNs0.pvnID = "${first}"\n`,
    prefs([{ name: 'A', id: first }, { name: 'B', id: first }]),
    prefs().replace(first, 'not-an-id'),
    prefs().replace('UTF-8', 'UTF-16'),
    prefs() + 'pref.namedPVNs0.unknown = "value"\n',
    prefs().replace('pref.namedPVNs0.name = "Lab A"', 'pref.namedPVNs0.name = broken'),
  ]) {
    await fs.writeFile(f.filename, text);
    await assert.rejects(f.lan.create({ name: 'New' }));
    assert.equal(await fs.readFile(f.filename, 'utf8'), text);
  }
  assert.equal((await fs.readdir(f.root)).some(name => /backup|lock|edit-/.test(name)), false);
});

test('duplicate names require ID selection and removal compacts indices', async t => {
  const f = await fixture(t, prefs([{ name: 'Same', id: first }, { name: 'Same', id: second }]));
  await assert.rejects(f.lan.create({ name: 'same' }), /ambiguous/);
  await assert.rejects(f.lan.attach({ vmx: f.vmx, adapter: 0, segment: 'Same' }), /ambiguous/);
  const result = await f.lan.remove({ segment: first });
  assert.equal(result.removed, true);
  assert.equal(result.checkedVMs, 1);
  assert.deepEqual((await f.lan.list()).segments, [{ name: 'Same', id: second }]);
  const text = await fs.readFile(f.filename, 'utf8');
  assert.match(text, /pref.namedPVNs0.pvnID/); assert.doesNotMatch(text, /pref.namedPVNs1\./);
});

test('attach and detach preserve other adapters, MAC and hardware; removal refuses referenced segments', async t => {
  const f = await fixture(t);
  const attached = await f.lan.attach({ vmx: f.vmx, adapter: 0, segment: 'Lab A' });
  assert.equal(attached.attached, true);
  assert.equal(await fs.readFile(attached.backup, 'utf8'), vmText);
  const config = await f.config();
  assert.equal(config['ethernet0.connectionType'], 'pvn');
  assert.equal(config['ethernet0.pvnID'], first);
  assert.equal(config['ethernet0.vnet'], undefined);
  assert.equal(config['ethernet0.startConnected'], 'TRUE');
  assert.equal(config['ethernet0.address'], '00:50:56:00:00:01');
  assert.equal(config['ethernet0.virtualDev'], 'vmxnet3');
  assert.equal(config['ethernet1.connectionType'], 'nat');
  await assert.rejects(f.lan.remove({ segment: first }), /detach them/);
  const detached = await f.lan.detach({ vmx: f.vmx, adapter: 0, segment: first, network: 'custom', vmnet: 'vmnet7' });
  assert.equal(detached.attached, false);
  const after = await f.config();
  assert.equal(after['ethernet0.connectionType'], 'custom');
  assert.equal(after['ethernet0.pvnID'], undefined);
  assert.equal(after['ethernet0.vnet'], 'vmnet7');
  assert.equal(after['ethernet0.startConnected'], 'FALSE');
  assert.equal(after['ethernet0.connected'], 'FALSE');
  assert.equal(after['ethernet0.present'], 'TRUE');
  await f.lan.remove({ segment: 'Lab A' });
  assert.deepEqual((await f.lan.list()).segments, []);
});

test('detach defaults to disconnected NAT and accepts orphaned IDs without catalog mutation', async t => {
  const f = await fixture(t, prefs([]));
  await fs.writeFile(f.vmx, vmText.replace('connectionType = "custom"', 'connectionType = "pvn"') + `ethernet0.pvnID = "${first}"\n`);
  await f.lan.detach({ vmx: f.vmx, adapter: 0, segment: first });
  const config = await f.config();
  assert.equal(config['ethernet0.connectionType'], 'nat');
  assert.equal(config['ethernet0.startConnected'], 'FALSE');
  assert.equal(config['ethernet0.vnet'], undefined);
  assert.deepEqual((await f.lan.list()).segments, []);
});

test('adapter validation rejects missing adapters, wrong segment and custom-network mistakes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.lan.attach({ vmx: f.vmx, adapter: 2, segment: first }), /not present/);
  await assert.rejects(f.lan.detach({ vmx: f.vmx, adapter: 0, segment: first }), /not attached/);
  await assert.rejects(f.lan.detach({ vmx: f.vmx, adapter: 0, segment: first, network: 'custom' }), /requires vmnet/);
  await assert.rejects(f.lan.detach({ vmx: f.vmx, adapter: 0, segment: first, network: 'nat', vmnet: 'vmnet7' }), /only with/);
  await assert.rejects(f.lan.attach({ vmx: f.vmx, adapter: -1, segment: first }));
  assert.equal(await fs.readFile(f.vmx, 'utf8'), vmText);
});

test('running, locked and suspended VM edits are refused', async t => {
  const f = await fixture(t);
  const args = { vmx: f.vmx, adapter: 0, segment: first };
  f.setRunning([f.vmx]);
  await assert.rejects(f.lan.attach(args), /Power off/);
  f.setRunning([]);
  await fs.mkdir(`${f.vmx}.lck`);
  await assert.rejects(f.lan.attach(args), /lock/);
  await fs.rmdir(`${f.vmx}.lck`);
  await fs.writeFile(path.join(f.root, 'saved.vmss'), 'saved');
  await fs.appendFile(f.vmx, 'Checkpoint.VMState = "saved.vmss"\n');
  await assert.rejects(f.lan.attach(args), /suspended/);
});

test('VMX case variants work and duplicate/malformed settings or invalid encodings refuse edits', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.vmx, '\uFEFF' + vmText.replace('ethernet0.present', 'ETHERNET0.PRESENT'));
  await f.lan.attach({ vmx: f.vmx, adapter: 0, segment: first });
  for (const text of [vmText + 'Ethernet0.Present = "FALSE"\n', vmText + 'ethernet0.pvnID = broken\n', vmText.replace('UTF-8', 'windows-1252')]) {
    await fs.writeFile(f.vmx, text);
    await assert.rejects(f.lan.attach({ vmx: f.vmx, adapter: 0, segment: first }));
    assert.equal(await fs.readFile(f.vmx, 'utf8'), text);
  }
});

test('removal checks extra unregistered VMs and disabled/disconnected adapter references', async t => {
  const f = await fixture(t);
  const extra = path.join(f.root, 'unregistered.vmx');
  await fs.writeFile(extra, `.encoding = "UTF-8"\nethernet8.present = "FALSE"\nethernet8.startConnected = "FALSE"\nethernet8.pvnID = "${first}"\n`);
  await assert.rejects(f.lan.remove({ segment: first, vmx_paths: [extra] }), /detach them/);
  await assert.rejects(f.lan.remove({ segment: first, vmx_paths: [path.join(f.root, 'missing.vmx')] }), /Cannot inspect/);
  await f.lan.detach({ vmx: extra, adapter: 8, segment: first });
  const disabled = parseAssignments(await fs.readFile(extra, 'utf8'));
  assert.equal(disabled['ethernet8.present'], 'FALSE');
  assert.equal(disabled['ethernet8.pvnID'], undefined);
  await f.lan.remove({ segment: first, vmx_paths: [extra] });
});

test('encrypted VMX files and noncanonical adapter indices block inspection and removal', async t => {
  const f = await fixture(t);
  for (const text of [vmText + 'encryption.encryptedData = "opaque"\n', vmText + `ethernet00.pvnID = "${first}"\n`]) {
    await fs.writeFile(f.vmx, text);
    await assert.rejects(f.lan.list({ vmx: f.vmx }));
    await assert.rejects(f.lan.remove({ segment: first }));
    assert.equal((await f.lan.list()).segments.length, 1);
  }
});

test('removal reports stale inventory entries and refuses missing/malformed inventory', async t => {
  const f = await fixture(t);
  await fs.appendFile(f.inventory, `vmlist1.config = "${path.join(f.root, 'missing.vmx')}"\n`);
  const removed = await f.lan.remove({ segment: first });
  assert.equal(removed.skippedMissingVMs.length, 1);
  await fs.writeFile(f.filename, prefs());
  await fs.writeFile(f.inventory, 'vmlist0.config = broken\n');
  await assert.rejects(f.lan.remove({ segment: first }), /Malformed VM inventory/);
  await fs.unlink(f.inventory);
  await assert.rejects(f.lan.remove({ segment: first }));
  assert.equal((await f.lan.list()).segments.length, 1);
});

test('VM allowed roots apply to attachment and usage checks, with no partial removal', async t => {
  const f = await fixture(t);
  const allowed = path.join(f.root, 'allowed'); await fs.mkdir(allowed);
  f.backend.env.VMWARE_ALLOWED_ROOTS = allowed;
  await assert.rejects(f.lan.attach({ vmx: f.vmx, adapter: 0, segment: first }), /outside/);
  await assert.rejects(f.lan.remove({ segment: first }), /outside/);
  assert.equal((await f.lan.list()).segments.length, 1);
});

test('GUI and concurrent-operation locks block all mutations while listing still works', async t => {
  const f = await fixture(t);
  f.setGUI(true);
  await assert.rejects(f.lan.create({ name: 'B' }), /GUI/);
  await assert.rejects(f.lan.remove({ segment: first }), /GUI/);
  await assert.rejects(f.lan.attach({ vmx: f.vmx, adapter: 0, segment: first }), /GUI/);
  assert.equal((await f.lan.list()).segments.length, 1);
  f.setGUI(false);
  await fs.mkdir(`${f.filename}.lan-segments.lock`);
  await assert.rejects(f.lan.create({ name: 'B' }), /edit lock/);
  await fs.rmdir(`${f.filename}.lan-segments.lock`);
  const results = await Promise.all([f.lan.create({ name: 'B' }), f.lan.create({ name: 'C' })]);
  assert.notEqual(results[0].segment.id, results[1].segment.id);
  assert.equal((await f.lan.list()).segments.length, 3);
});

test('external preference, VMX and inventory changes abort commits and clean temporary files', async t => {
  const f = await fixture(t);
  const altered = prefs([{ name: 'External', id: second }]);
  const options = { ...f.options, protectFile: async file => { if (file.includes('.edit-')) await fs.writeFile(f.filename, altered); } };
  await assert.rejects(new LanSegments(f.backend, f.files, options).create({ name: 'B' }), /concurrently/);
  assert.equal(await fs.readFile(f.filename, 'utf8'), altered);
  await fs.writeFile(f.filename, prefs());
  const prior = f.files.configure.bind(f.files);
  f.files.configure = async (...args) => { await fs.appendFile(f.vmx, 'memsize = "1024"\n'); return prior(...args); };
  await assert.rejects(f.lan.attach({ vmx: f.vmx, adapter: 0, segment: first }), /VMX changed/);
  assert.equal((await f.config())['ethernet0.connectionType'], 'custom');
  const removal = new LanSegments(f.backend, f.files, { ...f.options, protectFile: async file => { if (file.includes('.edit-')) await fs.appendFile(f.inventory, '# external change\n'); } });
  await assert.rejects(removal.remove({ segment: first }), /inventory changed/);
  assert.equal((await f.lan.list()).segments.length, 1);
  assert.equal((await fs.readdir(f.root)).some(name => /\.edit-|\.lan-segments.lock/.test(name)), false);
});

test('native GUI inspection uses process metadata on both hosts and fails closed', async t => {
  const f = await fixture(t);
  let output = '[]';
  const backend = { execute: async (file, args, options) => { assert.equal(file, 'pwsh'); assert.equal(options.shell, false); assert.equal(options.windowsHide, true); return { stdout: output }; } };
  await assertLanGUIClosed(backend, 'win32');
  output = '["vmware"]'; await assert.rejects(assertLanGUIClosed(backend, 'win32'), /Close/);
  output = 'bad JSON'; await assert.rejects(assertLanGUIClosed(backend, 'win32'));
  const proc = path.join(f.root, 'proc'); await fs.mkdir(path.join(proc, '123'), { recursive: true });
  await fs.writeFile(path.join(proc, '123', 'comm'), 'vmware-vmx\n');
  await assertLanGUIClosed(backend, 'linux', proc);
  await fs.writeFile(path.join(proc, '123', 'comm'), 'vmplayer\n');
  await assert.rejects(assertLanGUIClosed(backend, 'linux', proc), /Close/);
  await assert.rejects(assertLanGUIClosed(backend, 'linux', path.join(f.root, 'missing')));
});

test('LAN schemas reject extra arguments, blank names, controls and injected adapter identifiers', () => {
  for (const name of ['', ' ', ' A', 'A\nB']) assert.throws(() => lanSegmentSchemas.create_lan_segment.parse({ name }));
  assert.throws(() => lanSegmentSchemas.create_lan_segment.parse({ name: 'A', force: true }));
  assert.throws(() => lanSegmentSchemas.attach_vm_adapter_to_lan_segment.parse({ vmx: '/lab.vmx', adapter: '0.pvnID', segment: first }));
});

test('bundled MCP discovers five LAN tools and lists an isolated catalog and VM adapters', async t => {
  const f = await fixture(t);
  const client = new Client({ name: 'lan-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('vmware-workstation/server/server.cjs')], env: { ...process.env, VMWARE_PREFERENCES_PATH: f.filename }, stderr: 'pipe' }));
  const { tools } = await client.listTools();
  for (const name of Object.keys(lanSegmentSchemas)) {
    const tool = tools.find(item => item.name === name);
    assert.ok(tool, name); assert.equal(tool.annotations.readOnlyHint, name === 'list_lan_segments');
  }
  const result = await client.callTool({ name: 'list_lan_segments', arguments: { vmx: f.vmx } });
  assert.ok(!result.isError, JSON.stringify(result));
  const data = JSON.parse(result.content[0].text);
  assert.deepEqual(data.segments, [{ name: 'Lab A', id: first }]);
  assert.equal(data.adapters.length, 2);
});

test('Linux bundled MCP performs a complete LAN lifecycle with native guards and private files', { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
  const f = await fixture(t, prefs([]));
  const binary = f.backend.env.VMRUN_PATH;
  await fs.writeFile(binary, `#!${process.execPath}\nconsole.log('Total running VMs: 0');\n`, { mode: 0o755 });
  const client = new Client({ name: 'lan-lifecycle-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('vmware-workstation/server/server.cjs')], env: { ...process.env, ...f.backend.env }, stderr: 'pipe' }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const created = await call('create_lan_segment', { name: 'MCP lab' });
  for (const file of [f.filename, created.backup]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await call('attach_vm_adapter_to_lan_segment', { vmx: f.vmx, adapter: 0, segment: created.segment.id });
  const blocked = await client.callTool({ name: 'remove_lan_segment', arguments: { segment: created.segment.id } });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /detach them/);
  await call('detach_vm_adapter_from_lan_segment', { vmx: f.vmx, adapter: 0, segment: created.segment.id });
  await call('remove_lan_segment', { segment: created.segment.id });
  assert.deepEqual((await call('list_lan_segments', {})).segments, []);
  assert.equal((await f.config())['ethernet0.startConnected'], 'FALSE');
});
