import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Workstation } from '../src/workstation.mjs';
import { VMFiles } from '../src/vm-files.mjs';
import { SerialManager, serialSchemas } from '../src/serial.mjs';
import { connectSerial } from '../src/serial-transport.mjs';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ser-'));
  const vmx = await fs.realpath(path.join(root, 'a.vmx')).catch(async () => { const file = path.join(root, 'a.vmx'); await fs.writeFile(file, '.encoding = "UTF-8"\ndisplayName = "serial-test"\n'); return fs.realpath(file); });
  const binary = path.join(root, process.platform === 'win32' ? 'vmrun.exe' : 'vmrun'); await fs.writeFile(binary, '', { mode: 0o755 });
  let running = false; const streams = [];
  const backend = new Workstation({ env: { VMRUN_PATH: binary, VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root }, run: async () => ({ stdout: `Total running VMs: ${running ? '1\n' + vmx : '0'}` }) });
  const connector = async () => {
    const received = [];
    const stream = new Duplex({ read() {}, write(bytes, _, cb) { received.push(Buffer.from(bytes)); cb(); } });
    stream.received = received; streams.push(stream); return stream;
  };
  const manager = new SerialManager({ backend, vmFiles: new VMFiles(backend), connector, ...options });
  t.after(async () => { manager.close(); await fs.rm(root, { recursive: true, force: true }); });
  const target = { vm_id: vmx, port: 0 };
  return { root, vmx, backend, manager, target, streams, setRunning(value) { running = value; }, async connect(port = 0) { running = false; await manager.configure({ ...target, port, confirm: true }); running = true; return manager.connect({ ...target, port }); } };
}

for (const platform of ['win32', ...(process.platform === 'linux' ? ['linux'] : [])]) {
  test(`${platform}: explicit backed-up serial setup, binary I/O and independent VM ports`, async t => {
    const f = await fixture(t, { platform }); const { manager, target } = f;
    assert.equal((await manager.status(target)).configured, false);
    await assert.rejects(manager.connect(target), /No enabled serial/);
    await assert.rejects(manager.configure(target), /true/);
    const before = await fs.readFile(f.vmx, 'utf8');
    const setup = await manager.configure({ ...target, confirm: true });
    assert.equal(await fs.readFile(setup.backup, 'utf8'), before);
    assert.equal((await manager.status(target)).connected, false);
    await assert.rejects(manager.connect(target), /running/);
    f.setRunning(true); await manager.connect(target);
    await assert.rejects(manager.connect(target), /already has/);
    await assert.rejects(manager.configure({ ...target, confirm: true }), /Disconnect/);
    const bytes = Buffer.from([0, 255, 13, 10, 27, 65]); f.streams[0].push(bytes); await delay(1);
    const first = await manager.read({ ...target, max_bytes: 2 });
    assert.deepEqual(Buffer.from(first.data, 'base64'), bytes.subarray(0, 2)); assert.equal(first.remaining_bytes, 4);
    assert.deepEqual(Buffer.from((await manager.read(target)).data, 'base64'), bytes.subarray(2));
    assert.equal((await manager.read({ ...target, timeout_ms: 5 })).timed_out, true);
    await manager.write({ ...target, data: bytes.toString('base64'), encoding: 'base64' });
    assert.deepEqual(f.streams[0].received[0], bytes);
    await manager.write({ ...target, data: 'λ\r\n' }); assert.equal(f.streams[0].received[1].toString(), 'λ\r\n');
    await f.connect(1);
    f.streams[1].push(Buffer.from('port1')); await delay(1);
    assert.equal((await manager.read({ ...target, port: 1, encoding: 'utf8' })).data, 'port1');
    assert.equal((await manager.read({ ...target, timeout_ms: 5 })).bytes, 0);
    const second = path.join(f.root, 'b.vmx'); await fs.copyFile(f.vmx, second);
    const other = { ...target, vm_id: second };
    await assert.rejects(manager.connect(other), /does not match/);
    await manager.disconnect(target); assert.equal((await manager.disconnect(target)).was_connected, false);
    await assert.rejects(manager.read(target), /disconnected/);
    f.setRunning(false);
    await manager.configure({ ...target, enabled: false, confirm: true });
    assert.equal((await manager.status(target)).configured, false);
    assert.equal((await manager.status({ ...target, port: 1 })).configured, true);
  });
}

test('bounded pending reads cancel independently and disconnect settles all I/O', async t => {
  const f = await fixture(t); await f.connect();
  const abort = new AbortController();
  const read = f.manager.read({ ...f.target, timeout_ms: 10000 }, { signal: abort.signal });
  const rejected = assert.rejects(read, { code: 'SERIAL_CANCELLED' }); await delay(5); abort.abort(); await rejected;
  f.streams[0].push(Buffer.from('retained')); await delay(1);
  assert.equal((await f.manager.read({ ...f.target, encoding: 'utf8' })).data, 'retained');
  const pending = f.manager.read({ ...f.target, timeout_ms: 10000 }); const done = assert.rejects(pending, /disconnected/);
  await delay(5); await assert.rejects(f.manager.read(f.target), /already pending/);
  await f.manager.disconnect(f.target); await done;
});

test('clean EOF preserves final bytes for bounded draining and never accepts more input', async t => {
  const f = await fixture(t); await f.connect();
  f.streams[0].push(Buffer.from('final')); f.streams[0].push(null); await delay(5);
  assert.equal((await f.manager.status(f.target)).eof, true);
  const final = await f.manager.read({ ...f.target, encoding: 'utf8' });
  assert.equal(final.data, 'final'); assert.equal(final.eof, true);
  const empty = await f.manager.read(f.target); assert.equal(empty.bytes, 0); assert.equal(empty.timed_out, false); assert.equal(empty.eof, true);
  await assert.rejects(f.manager.write({ ...f.target, data: 'input' }), /disconnected/);
});

for (const exitCode of [0, 1]) test(`Windows bridge exit ${exitCode} ${exitCode ? 'remains an I/O failure' : 'preserves unread EOF bytes'}`, { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  let bridgeScript; let closed; const errors = [];
  const f = await fixture(t, { connector: async (endpoint, options) => {
    const stream = await connectSerial(endpoint, { ...options, bridgeScript });
    stream.on('error', error => errors.push(error.code));
    closed = new Promise(resolve => stream.once('close', resolve));
    return stream;
  } });
  bridgeScript = path.join(f.root, 'bridge.ps1');
  // A real child process announces readiness, writes final binary output and
  // exits with stdin still open, as the native bridge does on pipe EOF.
  await fs.writeFile(bridgeScript, `[Console]::Error.Write("SERIAL_READY\u0060n")\nStart-Sleep -Milliseconds 100\n$serialOutput = [Console]::OpenStandardOutput()\n$serialOutput.Write([byte[]]@(0, 255, 13, 10, 65), 0, 5)\n$serialOutput.Flush()\nexit ${exitCode}\n`);
  await f.connect(); await closed;
  const status = await f.manager.status(f.target);
  if (exitCode) {
    assert.ok(errors.length > 0); assert.equal(status.last_error.code, 'SERIAL_IO_FAILED');
    await assert.rejects(f.manager.read(f.target), { code: 'SERIAL_IO_FAILED' });
  } else {
    assert.deepEqual(errors, []); assert.equal(status.eof, true); assert.equal(status.buffered_bytes, 5);
    const first = await f.manager.read({ ...f.target, max_bytes: 2 });
    const last = await f.manager.read(f.target);
    assert.deepEqual(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(last.data, 'base64')]), Buffer.from([0, 255, 13, 10, 65]));
    assert.equal(last.eof, true);
    const empty = await f.manager.read(f.target); assert.equal(empty.bytes, 0); assert.equal(empty.eof, true); assert.equal(empty.timed_out, false);
  }
});

test('overflow, idle eviction and connection limit fail clearly without replay', async t => {
  const f = await fixture(t, { maxBufferedBytes: 8, maxConnections: 1 }); await f.connect();
  await assert.rejects(f.connect(1), /limit/);
  f.streams[0].push(Buffer.alloc(9)); await delay(1);
  await assert.rejects(f.manager.read(f.target), { code: 'SERIAL_OVERFLOW' });
  assert.equal((await f.manager.status(f.target)).last_error.code, 'SERIAL_OVERFLOW');
  const idle = await fixture(t, { idleMs: 30 }); await idle.connect(); await delay(55);
  await assert.rejects(idle.manager.read(idle.target), { code: 'SERIAL_IDLE' });
});

test('simultaneous different-VM connects cannot race past the shared session limit', async t => {
  const f = await fixture(t, { maxConnections: 1 });
  await f.manager.configure({ ...f.target, confirm: true });
  const second = path.join(f.root, 'second.vmx'); await fs.writeFile(second, '.encoding = "UTF-8"\n');
  await f.manager.configure({ vm_id: second, confirm: true });
  let entered = 0; let release;
  const barrier = new Promise(resolve => { release = resolve; });
  f.backend.details = async () => { entered++; if (entered === 2) release(); await barrier; return { running: true }; };
  const results = await Promise.allSettled([f.manager.connect(f.target), f.manager.connect({ vm_id: second })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'SERIAL_LIMIT');
  assert.equal(f.manager.sessions.size, 1);
});

test('write cancellation and timeout close the session with an uncertain-outcome error', async t => {
  for (const cancel of [false, true]) {
    const f = await fixture(t, { connector: async () => new Duplex({ read() {}, write() {} }) }); await f.connect();
    const abort = new AbortController();
    const pending = f.manager.write({ ...f.target, data: 'do not replay', timeout_ms: cancel ? 10000 : 5 }, { signal: abort.signal });
    const result = assert.rejects(pending, /may have reached/); if (cancel) { await delay(5); abort.abort(); } await result;
    assert.equal(f.manager.sessions.size, 0);
    await assert.rejects(f.manager.write({ ...f.target, data: 'retry' }), /may have reached/);
  }
});

test('strict byte validation, missing ports, stopped/locked/saved VMs, unsafe modes and endpoints', async t => {
  const f = await fixture(t); const { manager, target } = f;
  for (const input of [{ ...target, port: 4 }, { ...target, host: 'example.com' }, { ...target, timeout_ms: 10001 }]) assert.equal(serialSchemas.serial_connect.safeParse(input).success, false);
  for (const data of ['', '!!!', 'YQ', 'YR==', 'YQ==\n', Buffer.alloc(65537).toString('base64')]) await assert.rejects(manager.write({ ...target, data, encoding: 'base64' }));
  await assert.rejects(manager.write({ ...target, data: 'λ'.repeat(32769) }), /65536/);
  f.setRunning(true); await assert.rejects(manager.configure({ ...target, confirm: true }), /Power off/); f.setRunning(false);
  for (const name of ['test.lck', 'test.vmss']) {
    const file = path.join(f.root, name); await fs.writeFile(file, '');
    await assert.rejects(manager.configure({ ...target, confirm: true }), /locks or saved/); await fs.unlink(file);
  }
  await fs.writeFile(path.join(f.root, 'state.saved'), ''); await fs.appendFile(f.vmx, 'checkpoint.vmState = "state.saved"\n');
  await assert.rejects(manager.configure({ ...target, confirm: true }), /saved state/);
  await fs.unlink(path.join(f.root, 'state.saved')); await manager.configure({ ...target, confirm: true });
  const good = await fs.readFile(f.vmx, 'utf8');
  for (const bad of ['serial0.fileType = "file"', 'serial0.pipe.endPoint = "client"', 'serial0.fileName = "tcp://127.0.0.1:22"', 'serial0.fileName = "\\\\remote\\pipe\\console"']) {
    await fs.writeFile(f.vmx, good + bad + '\n');
    assert.equal((await manager.status(target)).configured, false);
    await assert.rejects(manager.connect(target));
  }
  await fs.writeFile(f.vmx, good); await f.connect();
  await fs.appendFile(f.vmx, 'serial0.fileName = "some-other-vm"\n');
  await assert.rejects(manager.read(target), /does not match/); assert.equal(manager.sessions.size, 0);
});

test('connection cancellation/timeout and shutdown close late transports', async t => {
  for (const cancel of [false, true]) {
    const f = await fixture(t, { connector: async (_, { signal }) => { await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } });
    await f.manager.configure({ ...f.target, confirm: true }); f.setRunning(true);
    const abort = new AbortController();
    const pending = f.manager.connect({ ...f.target, timeout_ms: cancel ? 10000 : 5 }, { signal: abort.signal });
    const done = assert.rejects(pending, { code: cancel ? 'SERIAL_CANCELLED' : 'SERIAL_TIMEOUT' });
    if (cancel) { await delay(5); abort.abort(); } await done; assert.equal(f.manager.sessions.size, 0);
  }
  const f = await fixture(t); await f.connect(); f.manager.close();
  await assert.rejects(f.manager.connect(f.target), /disconnected/);
});

test('Linux serial directories reject links, public permissions and host allowlist escapes', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t); const directory = path.join(f.root, '.mcp-serial');
  await fs.mkdir(directory, { mode: 0o755 });
  await assert.rejects(f.manager.configure({ ...f.target, confirm: true }), /mode 700/);
  await fs.chmod(directory, 0o700); await f.manager.configure({ ...f.target, confirm: true });
  await fs.rmdir(directory); const other = path.join(f.root, 'other'); await fs.mkdir(other, { mode: 0o700 }); await fs.symlink(other, directory);
  await assert.rejects(f.manager.connect(f.target), /links/);
  await fs.unlink(directory); await fs.mkdir(directory, { mode: 0o700 });
  f.backend.env.VMWARE_ALLOWED_HOST_ROOTS = other;
  await assert.rejects(f.manager.connect(f.target), /outside/);
});
