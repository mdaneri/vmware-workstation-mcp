import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, keysyms } from 'rfb2';
import pngjs from 'pngjs';
import { Workstation, isWithin } from '../src/workstation.mjs';
import { Credentials } from '../src/credentials.mjs';
import { ConsoleManager, consoleSchemas, keySequence } from '../src/console.mjs';

async function eventually(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
  assert.ok(predicate(), 'Expected RFB wire events did not arrive.');
}
async function fixture(t, { version = '3.8', password = 'testVNC1', inspector, managerOptions = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-console-test-'));
  const binary = path.join(root, process.platform === 'win32' ? 'vmrun.exe' : 'vmrun'); await fs.writeFile(binary, '', { mode: 0o755 });
  const credentialsPath = path.join(root, 'credentials.json');
  const credentialData = { console: {} };
  const env = { VMRUN_PATH: binary, VMWARE_CREDENTIALS_FILE: credentialsPath };
  const backend = new Workstation({ env, run: async () => ({ stdout: 'Total running VMs: 0' }) });
  const credentials = new Credentials(env);
  const manager = new ConsoleManager({ backend, credentials, keyDelayMs: 0, listenerInspector: inspector || (async (_, endpoint) => [{ address: endpoint.host, port: endpoint.port, processName: 'vmware-vmx.exe', commandLine: `vmware-vmx.exe "${endpoint.vmx}"` }]), ...managerOptions });
  const servers = []; const connections = new Set();
  t.after(async () => {
    manager.close(); for (const connection of connections) connection.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    assert.ok(isWithin(await fs.realpath(os.tmpdir()), await fs.realpath(root)));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function add(name, { color = [0, 0, 255, 0], auth = password } = {}) {
    const vmx = path.join(root, `${name}.vmx`);
    const state = { width: 16, height: 12, color, keys: [], pointers: [], sessions: 0, updates: 0, name };
    const server = createServer({ width: state.width, height: state.height, name, ...(auth ? { password: auth } : {}), version }, connection => {
      state.sessions++; connections.add(connection);
      connection.on('close', () => connections.delete(connection));
      connection.on('error', () => {});
      connection.on('key', event => { state.keys.push(event); if (event.down && event.keysym === keysyms.F2) state.color = [255, 0, 0, 0]; });
      connection.on('pointer', event => state.pointers.push(event));
      connection.on('updateRequest', () => {
        state.updates++;
        if (state.stall) return;
        if (connection.width !== state.width || connection.height !== state.height) {
          connection.sendUpdate([{ type: 'desktopSize', width: state.width, height: state.height }]); return;
        }
        const data = Buffer.alloc(state.width * state.height * 4);
        for (let i = 0; i < data.length; i += 4) data.set(state.color, i);
        connection.sendUpdate([{ type: 'pixels', x: 0, y: 0, width: state.width, height: state.height, data }]);
      });
    });
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port;
    await fs.writeFile(vmx, `displayName = "${name}"\nRemoteDisplay.vnc.enabled = "TRUE"\nRemoteDisplay.vnc.ip = "127.0.0.1"\nRemoteDisplay.vnc.port = "${port}"\n`);
    credentialData.console[name] = { vmx, password };
    await fs.writeFile(credentialsPath, JSON.stringify(credentialData), { mode: 0o600 });
    return { vmx, port, state, server };
  }
  return { root, credentialsPath, credentialData, env, backend, credentials, manager, add };
}
const decode = result => pngjs.PNG.sync.read(Buffer.from(result.content.find(c => c.type === 'image').data, 'base64'));

for (const version of ['3.3', '3.7', '3.8']) test(`authenticates over RFB ${version} and returns PNG pixels from the remote framebuffer`, async t => {
  const f = await fixture(t, { version }); await f.add('bios');
  const screenshot = await f.manager.screenshot('bios');
  const png = decode(screenshot);
  assert.equal(png.width, 16); assert.equal(png.height, 12);
  assert.deepEqual([...png.data.subarray(0, 4)], [255, 0, 0, 255]);
  assert.equal((await f.manager.status('bios')).authentication, 'VNC password');
});
test('all six console operations work through independent simultaneous VM sessions', async t => {
  const f = await fixture(t); const a = await f.add('bios'); const b = await f.add('uefi', { color: [0, 255, 0, 0] });
  const [first, second] = await Promise.all([f.manager.screenshot('bios'), f.manager.screenshot('uefi')]);
  assert.deepEqual([...decode(first).data.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...decode(second).data.subarray(0, 4)], [0, 255, 0, 255]);
  await Promise.all([f.manager.key('bios', 'F2'), f.manager.click('uefi', 3, 4, 'right')]);
  await f.manager.type('bios', 'Az!\r\n\t');
  await f.manager.scroll('uefi', 'down', 2);
  await eventually(() => a.state.keys.length === 16 && b.state.pointers.length === 6);
  assert.deepEqual(a.state.keys[0], { down: true, keysym: keysyms.F2 });
  assert.equal(b.state.pointers[0].buttons, 4); assert.equal(b.state.pointers[1].buttons, 0);
  assert.deepEqual(b.state.pointers.slice(2).map(e => e.buttons), [16, 0, 16, 0]);
  assert.deepEqual(b.state.keys, []); assert.deepEqual(a.state.pointers, []);
  assert.equal(f.manager.sessions.size, 2);
  const after = decode(await f.manager.screenshot('bios'));
  assert.deepEqual([...after.data.subarray(0, 4)], [0, 0, 255, 255]);
  assert.equal(a.state.sessions, 1); assert.equal(b.state.sessions, 1);
});
test('serializes same-VM chords and always releases modifiers, without a global VM lock', async t => {
  const f = await fixture(t); const vm = await f.add('bios');
  await Promise.all([f.manager.key('bios', 'Ctrl+Alt+Delete'), f.manager.key('bios', 'Shift+F10')]);
  await eventually(() => vm.state.keys.length === 10);
  const controlChord = [
    [keysyms.ControlLeft, true], [keysyms.AltLeft, true], [keysyms.Delete, true],
    [keysyms.Delete, false], [keysyms.AltLeft, false], [keysyms.ControlLeft, false],
  ];
  const shiftChord = [[keysyms.ShiftLeft, true], [keysyms.F10, true], [keysyms.F10, false], [keysyms.ShiftLeft, false]];
  const events = vm.state.keys.map(e => [e.keysym, e.down]);
  // Concurrent endpoint reads may finish in either order; each chord must remain intact.
  assert.deepEqual(events, events[0][0] === keysyms.ControlLeft ? [...controlChord, ...shiftChord] : [...shiftChord, ...controlChord]);
});
test('captures fresh frames after preboot-to-installer resolution changes', async t => {
  const f = await fixture(t); const vm = await f.add('bios');
  await f.manager.screenshot('bios'); vm.state.width = 32; vm.state.height = 24;
  const image = decode(await f.manager.screenshot('bios'));
  assert.equal(image.width, 32); assert.equal(image.height, 24);
});
test('refuses wildcard VMX listeners before making any connection', async t => {
  const f = await fixture(t); const vm = await f.add('bios');
  await fs.writeFile(vm.vmx, `RemoteDisplay.vnc.enabled = "TRUE"\nRemoteDisplay.vnc.ip = "0.0.0.0"\nRemoteDisplay.vnc.port = "${vm.port}"`);
  await assert.rejects(f.manager.screenshot('bios'), /explicitly bind/);
  assert.equal(vm.state.sessions, 0);
});
test('refuses actual wildcard listeners even when VMX says localhost', async t => {
  const f = await fixture(t, { inspector: async () => [{ address: '0.0.0.0', processName: 'vmware-vmx.exe', commandLine: 'unused' }] });
  const vm = await f.add('bios'); await assert.rejects(f.manager.screenshot('bios'), /exposed beyond loopback/);
  assert.equal(vm.state.sessions, 0);
});
test('refuses a port owned by another VM and cleans failed pending sessions', async t => {
  const f = await fixture(t, { inspector: async () => [{ address: '127.0.0.1', processName: 'vmware-vmx.exe', commandLine: 'vmware-vmx.exe "other.vmx"' }] });
  const vm = await f.add('bios'); await assert.rejects(f.manager.screenshot('bios'), /does not belong/);
  assert.equal(vm.state.sessions, 0); assert.equal(f.manager.sessions.size, 0);
});
test('verifies protected Windows workers using unique running VMX ports and authentication', async t => {
  const f = await fixture(t, { inspector: async (_, endpoint) => [{ address: '127.0.0.1', port: endpoint.port, processName: 'vmware-vmx.exe', commandLine: null }] });
  const vm = await f.add('bios');
  f.backend.listVMs = async () => ({ vms: [{ vmx: vm.vmx, running: true }] });
  assert.equal((await f.manager.status('bios')).connected, true);
  f.manager.close();
});
test('refuses ambiguous running VMX ports when Windows hides worker command lines', async t => {
  const f = await fixture(t, { inspector: async (_, endpoint) => [{ address: '127.0.0.1', port: endpoint.port, processName: 'vmware-vmx.exe', commandLine: null }] });
  const a = await f.add('bios'); const b = await f.add('uefi');
  await fs.writeFile(b.vmx, `RemoteDisplay.vnc.port = "${a.port}"`);
  f.backend.listVMs = async () => ({ vms: [{ vmx: a.vmx, running: true }, { vmx: b.vmx, running: true }] });
  await assert.rejects(f.manager.screenshot('bios'), /uniquely identify/);
  assert.equal(a.state.sessions, 0); assert.equal(b.state.sessions, 0);
});
test('missing console credentials are rejected before opening a TCP session', async t => {
  const f = await fixture(t); const vm = await f.add('bios');
  f.credentialData.console.bios.password = undefined;
  await fs.writeFile(f.credentialsPath, JSON.stringify(f.credentialData));
  await assert.rejects(f.manager.screenshot('bios'), /password profile/);
  assert.equal(vm.state.sessions, 0);
});
test('never downgrades to unauthenticated RFB and never prints a VNC password', async t => {
  const f = await fixture(t); await f.add('bios', { auth: null });
  const result = await f.manager.status('bios'); assert.equal(result.connected, false);
  assert.match(result.reason, /UNSUPPORTED_SECURITY/); assert.ok(!JSON.stringify(result).includes('testVNC1'));
});
test('wrong VNC credentials fail cleanly without leaking the server authentication reason', async t => {
  const f = await fixture(t); await f.add('bios', { auth: 'wrong123' });
  const result = await f.manager.status('bios'); assert.equal(result.connected, false);
  assert.match(result.reason, /AUTH_FAILED/); assert.ok(!JSON.stringify(result).includes('testVNC1'));
});
test('canonical VMX, console aliases, unique inventory names, REST IDs and allowed roots reuse VM resolution', async t => {
  const f = await fixture(t); const vm = await f.add('bios');
  f.backend.listVMs = async () => ({ vms: [{ vmx: vm.vmx, displayName: 'BIOS Lab' }] });
  assert.equal(await f.backend.resolveVM('BIOS Lab'), await fs.realpath(vm.vmx));
  assert.equal(await f.backend.resolveVM('rest-vm', { restInventory: async () => [{ id: 'rest-vm', path: vm.vmx }] }), await fs.realpath(vm.vmx));
  await f.manager.screenshot(vm.vmx); await f.manager.screenshot('bios');
  assert.equal(vm.state.sessions, 1);
  const allowed = path.join(f.root, 'allowed'); await fs.mkdir(allowed); f.env.VMWARE_ALLOWED_ROOTS = allowed;
  await assert.rejects(f.manager.screenshot('bios'), /outside/);
});
test('validates coordinates, key chords, text controls and wheel counts before sending input', async t => {
  const f = await fixture(t); const vm = await f.add('bios');
  await assert.rejects(f.manager.click('bios', 16, 0), /outside/);
  await assert.rejects(f.manager.key('bios', 'A+B'), /modifier/);
  assert.throws(() => keySequence('NotAKey')); assert.throws(() => keySequence('Ctrl+Ctrl+Delete'));
  assert.throws(() => consoleSchemas.console_type.parse({ vm_id: 'bios', text: '\0' }));
  assert.throws(() => consoleSchemas.console_scroll.parse({ vm_id: 'bios', direction: 'down', amount: 10000 }));
  assert.deepEqual(vm.state.keys, []); assert.deepEqual(vm.state.pointers, []);
});
test('closes and reconnects idle sessions, with a bounded connection count', async t => {
  const f = await fixture(t, { managerOptions: { idleMs: 30, maxConnections: 1 } }); await f.add('bios'); await f.add('uefi');
  await f.manager.screenshot('bios');
  await assert.rejects(f.manager.screenshot('uefi'), /connection limit/);
  await eventually(() => f.manager.sessions.size === 0);
  assert.equal((await f.manager.status('uefi')).connected, true);
});
test('console implementation imports no host screen/input/window automation packages or APIs', async () => {
  const source = await fs.readFile(new URL('../src/console.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /SendInput|mouse_event|keybd_event|SetForegroundWindow|PrintWindow|BitBlt|CopyFromScreen|robotjs|screenshot-desktop|@nut-tree|GetForegroundWindow/);
  assert.doesNotMatch(source, /captureScreen|typeKeystrokesInGuest|runProgramInGuest/);
});
