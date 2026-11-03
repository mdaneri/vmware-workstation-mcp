import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GuestExec, guestExecSchema, verifyGuestResult } from '../src/guest-exec.mjs';
import { linuxRunner, windowsRunner } from '../src/guest-exec-wrappers.mjs';
import { Workstation } from '../src/workstation.mjs';
import { Credentials } from '../src/credentials.mjs';

const execute = promisify(execFile);
async function fixture(t, guestOS, mode = 'complete') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'guest-exec-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vmx = path.join(root, 'selected.vmx'); await fs.writeFile(vmx, '');
  const calls = []; const guestFiles = new Map(); let record; let request;
  const backend = new Workstation({ env: { VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root, VMWARE_GUEST_EXEC_ROOT: root } });
  backend.run = async (args, options) => {
    calls.push({ args, options });
    assert.equal(args[1], vmx);
    assert.ok(options.deadline > performance.now());
    if (args[0] === 'checkToolsState') return mode === 'no-tools' ? 'installed' : 'running';
    if (args[0] === 'CopyFileFromHostToGuest') {
      guestFiles.set(args[3], await fs.readFile(args[2], 'utf8'));
      if (args[3].endsWith('request.json')) request = JSON.parse(guestFiles.get(args[3]));
    }
    if (args[0] === 'runProgramInGuest') {
      assert.ok(!args.join(' ').includes('literal ; $HOME'));
      if (mode === 'launch-failure') throw new Error('Secret native error guest-password');
      if (mode === 'transport-timeout') throw Object.assign(new Error('Native process timeout'), { code: 'VMRUN_TIMEOUT' });
      record = { protocol: 1, nonce: mode === 'wrong-nonce' ? 'wrong' : request.nonce,
        timed_out: mode === 'guest-timeout',
        status: mode === 'guest-timeout' ? 'timed_out' : 'completed', exit_code: mode === 'guest-timeout' ? null : 7,
        stdout_base64: Buffer.from('hello guest-password').toString('base64'), stderr_base64: Buffer.from('bad').toString('base64'),
        stdout_truncated: true, stderr_truncated: false };
    }
    if (args[0] === 'fileExistsInGuest') {
      if (mode === 'missing-record') throw Object.assign(new Error('No result before deadline'), { code: 'OBSERVATION_DEADLINE' });
      if (mode === 'restart') throw new Error('VM restarted');
      if (mode === 'cancel') { controller.abort(); throw new Error('cancelled'); }
      return 'The file exists.';
    }
    if (args[0] === 'CopyFileFromGuestToHost') {
      if (mode === 'transfer-failure') throw new Error('Transfer failed');
      await fs.writeFile(args[3], mode === 'oversized' ? 'x'.repeat(10000) : JSON.stringify(record));
    }
    if (args[0] === 'deleteDirectoryInGuest' && mode === 'cleanup-failure') throw new Error('Cleanup failed');
    return '';
  };
  const credentials = new Credentials({ VMWARE_GUEST_TEST_USERNAME: 'test', VMWARE_GUEST_TEST_PASSWORD: 'guest-password' });
  const controller = new AbortController();
  const manager = new GuestExec({ backend, credentials, protectFile: async () => {} });
  const input = { vmx, guest_profile: 'test', guest_os: guestOS, program: guestOS === 'windows' ? 'C:\\Program Files\\App\\a.exe' : '/usr/bin/app', arguments: ['literal ; $HOME', 'a"b', ''], confirm: true, max_output_bytes: 64 };
  return { root, vmx, backend, calls, manager, input, controller, guestFiles, request: () => request };
}

for (const guestOS of ['linux', 'windows']) {
  test(`${guestOS} guest protocol verifies nonzero exit, separates transport and redacts output`, async t => {
    const f = await fixture(t, guestOS);
    const result = await f.manager.execute(f.input);
    assert.equal(result.status, 'completed'); assert.equal(result.exit_code, 7);
    assert.equal(result.transport.status, 'succeeded'); assert.equal(result.transport.launch_succeeded, true);
    assert.equal(result.stdout, 'hello [REDACTED]'); assert.equal(result.stderr, 'bad');
    assert.equal(result.stdout_truncated, true); assert.equal(result.cleanup.guest, 'removed'); assert.equal(result.cleanup.host, 'removed');
    assert.deepEqual(f.request().arguments, f.input.arguments);
    assert.equal(f.calls.find(c => c.args[0] === 'runProgramInGuest').args[2], '-noWait');
    assert.deepEqual(await fs.readdir(f.root), ['selected.vmx']);
  });
  for (const mode of ['launch-failure', 'transport-timeout', 'missing-record', 'wrong-nonce', 'transfer-failure', 'restart', 'oversized', 'cancel']) test(`${guestOS} ${mode} never fabricates exit status or removes uncertain guest files`, async t => {
    const f = await fixture(t, guestOS, mode);
    const result = await f.manager.execute(f.input, { signal: f.controller.signal });
    assert.equal(result.exit_code, null); assert.equal(result.status, 'indeterminate');
    assert.equal(result.cleanup.guest, 'retained_outcome_unknown');
    assert.equal(result.cleanup.host, 'removed');
    assert.ok(!f.calls.some(c => c.args[0] === 'deleteDirectoryInGuest'));
    assert.doesNotMatch(JSON.stringify(result), /guest-password|Secret native error/);
    if (mode === 'cancel') { assert.equal(result.cancelled, true); assert.equal(result.transport.status, 'cancelled'); }
    if (['transport-timeout', 'missing-record'].includes(mode)) { assert.equal(result.timed_out, true); assert.equal(result.transport.status, 'timed_out'); }
  });
  test(`${guestOS} verified timeout and cleanup failure remain separate`, async t => {
    const f = await fixture(t, guestOS, 'guest-timeout');
    const result = await f.manager.execute(f.input);
    assert.equal(result.status, 'timed_out'); assert.equal(result.timed_out, true); assert.equal(result.exit_code, null);
    assert.equal(result.transport.status, 'succeeded'); assert.equal(result.cleanup.guest, 'removed');
    const failed = await fixture(t, guestOS, 'cleanup-failure');
    const cleanup = await failed.manager.execute(failed.input);
    assert.equal(cleanup.exit_code, 7); assert.equal(cleanup.cleanup.guest, 'failed');
  });
}

test('guest_exec requires authorization, explicit profile and unambiguous guest paths/mode', async t => {
  const f = await fixture(t, 'linux', 'no-tools');
  assert.equal(guestExecSchema.safeParse({ ...f.input, guest_profile: undefined }).success, false);
  assert.equal(guestExecSchema.safeParse({ ...f.input, confirm: false }).success, false);
  assert.equal(guestExecSchema.safeParse({ ...f.input, password: 'unaccepted' }).success, false);
  for (const input of [{ program: 'relative' }, { guest_temp_directory: '/tmp/../root' }, { program: '/bin/echo', script: 'echo x', interpreter: '/bin/sh' }]) {
    await assert.rejects(f.manager.execute({ ...f.input, ...input }));
  }
  assert.equal(f.calls.length, 0);
  const result = await f.manager.execute(f.input);
  assert.equal(result.exit_code, null); assert.equal(result.status, 'unavailable'); assert.equal(result.transport.phase, 'tools');
  assert.ok(!f.calls.some(c => c.args[0] === 'runProgramInGuest'));
  await assert.rejects(f.manager.execute({ ...f.input, vmx: path.join(os.tmpdir(), 'outside.vmx') }));
});

test('script mode transfers script as data and host allowlists apply before guest mutation', async t => {
  const f = await fixture(t, 'linux');
  await f.manager.execute({ ...f.input, program: undefined, arguments: [], script: 'printf "%s" "$HOME"', interpreter: '/bin/sh' });
  assert.equal(f.request().script, 'printf "%s" "$HOME"');
  const refused = await fixture(t, 'linux');
  refused.backend.env.VMWARE_GUEST_EXEC_ROOT = os.tmpdir();
  const result = await refused.manager.execute(refused.input);
  assert.equal(result.transport.status, 'failed'); assert.equal(refused.calls.length, 0);
});

test('completion record validates nonce, canonical encoding, lengths and exit code', () => {
  const record = { protocol: 1, nonce: 'a', status: 'completed', exit_code: 0, timed_out: false, stdout_base64: '', stderr_base64: '', stdout_truncated: false, stderr_truncated: false };
  assert.equal(verifyGuestResult(record, 'a', 1).exit_code, 0);
  for (const patch of [{ nonce: 'b' }, { exit_code: null }, { exit_code: 0.5 }, { status: 'timed_out', exit_code: 0 }, { stdout_base64: 'AAAA' }, { stdout_base64: '!bad!' }, { stderr_truncated: 'false' }]) assert.throws(() => verifyGuestResult({ ...record, ...patch }, 'a', 1));
});

async function runNative(t, request, windows) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'guest-runner-native-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runner = path.join(root, windows ? 'runner.ps1' : 'runner.py');
  await fs.writeFile(runner, windows ? windowsRunner : linuxRunner);
  await fs.writeFile(path.join(root, 'request.json'), JSON.stringify({ nonce: 'native-test', program: '', arguments: [], script: null, interpreter: '', interpreter_arguments: [], timeout_seconds: 1, max_output_bytes: 128, ...request }));
  await execute(windows ? 'powershell.exe' : '/usr/bin/python3', windows ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner] : [runner], { timeout: 30000, windowsHide: true, shell: false });
  return JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8'));
}

test('native Linux runner captures literal argv, both streams, nonzero exit and bounded output', { skip: process.platform !== 'linux' }, async t => {
  const record = await runNative(t, { program: '/usr/bin/python3', arguments: ['-c', 'import sys; print(sys.argv[1]); print("err",file=sys.stderr); sys.exit(9)', 'a ; $HOME " ü'] }, false);
  const value = verifyGuestResult(record, 'native-test', 128);
  assert.equal(value.exit_code, 9); assert.equal(value.stdout, 'a ; $HOME " ü\n'); assert.equal(value.stderr, 'err\n');
  const truncated = await runNative(t, { program: '/usr/bin/python3', arguments: ['-c', 'print("x"*1000000)'] }, false);
  assert.equal(verifyGuestResult(truncated, 'native-test', 128).stdout_bytes, 128); assert.equal(truncated.stdout_truncated, true);
  const timeout = await runNative(t, { program: '/usr/bin/python3', arguments: ['-c', 'import time; time.sleep(5)'] }, false);
  assert.equal(timeout.status, 'timed_out'); assert.equal(timeout.exit_code, null);
  const script = await runNative(t, { script: 'printf out; printf err >&2; exit 4', interpreter: '/bin/sh' }, false);
  assert.equal(script.exit_code, 4); assert.equal(Buffer.from(script.stdout_base64, 'base64').toString(), 'out');
});

test('native Windows runner captures literal argv, both streams, nonzero exit, truncation and timeout', { skip: process.platform !== 'win32' }, async t => {
  const program = process.execPath;
  const record = await runNative(t, { program, arguments: ['-e', 'process.stdout.write(process.argv[1]); process.stderr.write("err"); process.exit(9)', 'a ; $HOME " ü\\'] }, true);
  const value = verifyGuestResult(record, 'native-test', 128);
  assert.equal(value.exit_code, 9); assert.equal(value.stdout, 'a ; $HOME " ü\\'); assert.equal(value.stderr, 'err');
  const truncated = await runNative(t, { program, arguments: ['-e', 'process.stdout.write("x".repeat(1000000))'] }, true);
  assert.equal(verifyGuestResult(truncated, 'native-test', 128).stdout_bytes, 128); assert.equal(truncated.stdout_truncated, true);
  const timeout = await runNative(t, { program, arguments: ['-e', 'setTimeout(()=>{},5000)'] }, true);
  assert.equal(timeout.status, 'timed_out'); assert.equal(timeout.exit_code, null);
  const script = await runNative(t, { script: '[Console]::Out.Write("out"); [Console]::Error.Write("err"); exit 4', interpreter: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', interpreter_arguments: ['-NoProfile', '-NonInteractive', '-File'] }, true);
  assert.equal(script.exit_code, 4); assert.equal(Buffer.from(script.stdout_base64, 'base64').toString(), 'out');
});
