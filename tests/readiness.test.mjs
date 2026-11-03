import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { Workstation } from '../src/workstation.mjs';
import { Credentials } from '../src/credentials.mjs';
import { Readiness, readinessSchemas, probeService, routableGuestIP } from '../src/readiness.mjs';

async function fixture(t, state = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-readiness-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vmx = path.join(root, 'selected.vmx'); await fs.writeFile(vmx, 'memsize = "1024"\nfirmware = "efi"\n');
  const calls = [];
  const backend = new Workstation({ env: { VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root }, run: async (binary, args, options) => {
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true); calls.push({ args, options });
    const cmd = args.find(value => ['list', 'checkToolsState', 'getGuestIPAddress', 'listSnapshots'].includes(value));
    if (state.error) throw Object.assign(new Error('failure'), { stderr: state.error });
    if (cmd === 'list') return { stdout: state.power === 'off' ? 'Total running VMs: 0' : `Total running VMs: 1\n${vmx}` };
    if (cmd === 'checkToolsState') return { stdout: state.tools || 'running' };
    if (cmd === 'getGuestIPAddress') return { stdout: state.ip ?? '192.0.2.20' };
    if (cmd === 'listSnapshots') return { stdout: 'Total snapshots: 1\nsecret-snapshot-name' };
    throw new Error('Unexpected native command');
  } });
  backend.executable = async () => '/mock/vmrun';
  const credentials = new Credentials({ VMWARE_VM_TEST_PASSWORD: 'known-secret' });
  const manager = new Readiness({ backend, credentials, protectFile: async file => fs.chmod(file, 0o600), probe: async () => ({ ready: true, state: 'running' }) });
  return { root, vmx, backend, manager, calls, state, args: { vmx, timeout_seconds: 1, poll_interval_ms: 100 } };
}

test('OS agent, published IP and service are separate criteria; encrypted VM profile reused', async t => {
  const f = await fixture(t, { ip: '' });
  const boot = await f.manager.wait('boot', { ...f.args, vm_password_profile: 'test' });
  assert.equal(boot.ready, true); assert.equal(boot.tools, 'running'); assert.equal(boot.address, null);
  assert.equal(boot.state, 'network_unavailable');
  assert.ok(f.calls.every(call => call.args.includes('known-secret')));
  const ip = await f.manager.wait('ip', f.args);
  assert.equal(ip.ready, false); assert.equal(ip.result, 'timed_out'); assert.equal(ip.timed_out, true);
  f.state.ip = '192.0.2.20'; f.state.tools = 'installed';
  assert.equal((await f.manager.wait('ip', f.args)).ready, true);
  const service = await f.manager.wait('service', { ...f.args, port: 443 });
  assert.equal(service.ready, true); assert.equal(service.tools, 'installed');
  assert.ok(f.calls.every(call => call.options.timeout <= 1000));
});

test('off, saved state, boot progress, Tools unknown and probe cancellation stay distinct', async t => {
  const f = await fixture(t, { power: 'off' });
  assert.equal((await f.manager.wait('boot', f.args)).state, 'powered_off');
  await fs.writeFile(path.join(f.root, 'selected.vmss'), 'saved'); await fs.appendFile(f.vmx, 'checkpoint.vmState = "selected.vmss"\n');
  assert.equal((await f.manager.wait('boot', f.args)).state, 'suspended');
  f.state.power = 'on'; f.state.tools = 'installed';
  await fs.writeFile(path.join(f.root, 'vmware.log'), `Config file: ${f.vmx}\nEFI firmware boot started\n`);
  const booting = await f.manager.wait('boot', f.args); assert.equal(booting.state, 'booting'); assert.equal(booting.timed_out, true);
  await fs.unlink(path.join(f.root, 'vmware.log'));
  assert.equal((await f.manager.wait('boot', f.args)).state, 'tools_unavailable');
  f.state.error = 'failed to lock known-secret unrelated-host';
  const unknown = await f.manager.wait('boot', f.args); assert.equal(unknown.state, 'unknown'); assert.equal(unknown.category, 'lock_contention');
  assert.doesNotMatch(JSON.stringify(unknown), /known-secret|unrelated-host/);
  const controller = new AbortController(); setTimeout(() => controller.abort(), 50);
  const cancelled = await f.manager.wait('boot', { ...f.args, timeout_seconds: 10 }, { signal: controller.signal });
  assert.equal(cancelled.result, 'cancelled'); assert.equal(cancelled.timed_out, false);
});

test('service probes never target loopback, metadata or arbitrary host destinations', async t => {
  const f = await fixture(t, { ip: '169.254.169.254' });
  let called = false; f.manager.probe = async () => { called = true; };
  const result = await f.manager.wait('service', { ...f.args, port: 80 });
  assert.equal(called, false); assert.equal(result.category, 'unsafe_service_address');
  for (const ip of ['127.0.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1']) assert.equal(routableGuestIP(ip), false, ip);
  for (const ip of ['192.0.2.20', '10.1.2.3', '2001:db8::1', 'fd00::1']) assert.equal(routableGuestIP(ip), true, ip);
  assert.throws(() => readinessSchemas.vm_wait_for_service.parse({ vmx: f.vmx, port: 80, host: 'example.com' }));
  assert.throws(() => readinessSchemas.vm_wait_for_service.parse({ vmx: f.vmx, port: 80, path: '//example.com' }));
});

test('TCP acceptance and HTTP expected status do not retain bodies or follow redirects', async t => {
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; res.writeHead(req.url === '/ok' ? 204 : 302, { Location: '/ok', 'X-Secret': 'body-secret' }); res.end('body-secret'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const args = { address: '127.0.0.1', port: server.address().port, protocol: 'tcp', path: '/', expected_status: 204 };
  assert.equal((await probeService(args, { timeout: 1000 })).ready, true);
  const redirect = await probeService({ ...args, protocol: 'http' }, { timeout: 1000 }); assert.equal(redirect.ready, false); assert.equal(redirect.status, 302); assert.equal(requests, 1);
  assert.doesNotMatch(JSON.stringify(redirect), /body-secret|Location/);
  assert.equal((await probeService({ ...args, protocol: 'http', path: '/ok' }, { timeout: 1000 })).ready, true);
  const stalled = net.createServer(); const sockets = new Set(); stalled.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => stalled.listen(0, '127.0.0.1', resolve)); t.after(() => { for (const socket of sockets) socket.destroy(); stalled.close(); });
  assert.equal((await probeService({ ...args, port: stalled.address().port, protocol: 'http' }, { timeout: 50 })).category, 'service_timeout');
});

test('deadline/cancellation includes time waiting in Workstation command queue', async t => {
  const f = await fixture(t); let release;
  f.backend.tail = new Promise(resolve => { release = resolve; });
  const start = performance.now(); const result = await f.manager.wait('boot', f.args);
  assert.ok(performance.now() - start < 2000); assert.equal(result.timed_out, true); assert.equal(f.calls.length, 0);
  release(); await f.backend.tail; assert.equal(f.calls.length, 0, 'Expired observation must never execute later');
});

test('selected-VM bundles bound and normalize logs, omit secret VMX/snapshots/output, never overwrite', async t => {
  const f = await fixture(t);
  await fs.appendFile(f.vmx, 'remoteDisplay.vnc.password = "vnc-secret"\nguestinfo.token = "guest-token"\nscsi0:0.fileName = "unrelated-host/private.vmdk"\nethernet0.startConnected = "FALSE"\n');
  await fs.writeFile(path.join(f.root, 'vmware.log'), `Config file: ${f.vmx}\n` + 'ordinary unrelated-host secret log text\n'.repeat(100) + 'failed to lock password="known-secret"\nDISKLIB error token=guest-token\nno bootable medium\n');
  const errors = await f.manager.recentErrors({ vmx: f.vmx, max_bytes: 1024 });
  assert.equal(errors.truncated, true); assert.equal(errors.bytes_scanned, 1024); assert.equal(errors.entries.length, 3);
  const destination_directory = path.join(f.root, 'bundle');
  const result = await f.manager.collect({ vmx: f.vmx, destination_directory });
  const text = await fs.readFile(path.join(destination_directory, 'diagnostics.json'), 'utf8');
  assert.doesNotMatch(text, /vnc-secret|guest-token|known-secret|unrelated-host|secret-snapshot-name|private.vmdk/);
  assert.equal(result.report.hardware.memsize, 1024); assert.equal(result.report.snapshots.count, 1);
  assert.deepEqual(result.files, ['diagnostics.json']); assert.equal(result.report.console.included, false);
  assert.ok(result.report.logs.entries.some(event => event.category === 'nic_misconfiguration'));
  if (process.platform === 'linux') assert.equal((await fs.stat(path.join(destination_directory, 'diagnostics.json'))).mode & 0o777, 0o600);
  await assert.rejects(f.manager.collect({ vmx: f.vmx, destination_directory }));
  await fs.writeFile(path.join(f.root, 'vmware.log'), 'Config file: /unrelated/another.vmx\nfailed to lock\n');
  assert.equal((await f.manager.recentErrors({ vmx: f.vmx })).category, 'log_identity_unverified');
});

test('diagnostic path restrictions reject missing roots, escape, existing directory and linked logs', async t => {
  const f = await fixture(t); const destination_directory = path.join(f.root, 'bundle');
  f.backend.env = {}; await assert.rejects(f.manager.collect({ vmx: f.vmx, destination_directory }), /Configure/);
  f.backend.env = { VMWARE_ALLOWED_ROOTS: f.root, VMWARE_DIAGNOSTICS_ROOTS: f.root };
  await assert.rejects(f.manager.collect({ vmx: f.vmx, destination_directory: path.resolve(f.root, '..', 'escape') }), /approved root/);
  await assert.rejects(f.manager.collect({ vmx: f.vmx, destination_directory: f.root }), /approved root/);
  const external = path.join(f.root, 'other.log'); await fs.writeFile(external, `Config file: ${f.vmx}\nfailed to lock secret\n`);
  await fs.link(external, path.join(f.root, 'vmware.log'));
  assert.equal((await f.manager.recentErrors({ vmx: f.vmx })).available, false);
});

test('console evidence uses selected VM RFB only when explicitly requested, with no desktop fallback', async t => {
  const f = await fixture(t); const calls = [];
  f.manager.consoles = { screenshot: async vmx => { calls.push(vmx); return { content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('fixture-png').toString('base64') }] }; } };
  const result = await f.manager.collect({ vmx: f.vmx, destination_directory: path.join(f.root, 'with-console'), include_console: true });
  assert.deepEqual(calls, [f.vmx]); assert.equal(result.report.console.redacted, false);
  assert.equal(await fs.readFile(path.join(result.directory, 'guest-console.png'), 'utf8'), 'fixture-png');
  f.manager.consoles.screenshot = async () => { throw new Error('secret'); };
  const unavailable = await f.manager.collect({ vmx: f.vmx, destination_directory: path.join(f.root, 'no-console'), include_console: true });
  assert.equal(unavailable.report.console.category, 'console_unavailable'); assert.doesNotMatch(JSON.stringify(unavailable), /secret/);
});
