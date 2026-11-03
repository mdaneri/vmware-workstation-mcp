import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { linuxRunner, windowsRunner } from './guest-exec-wrappers.mjs';

const text = z.string().max(65536).refine(value => !value.includes('\0'), 'NUL is not allowed.');
export const guestExecSchema = z.object({
  vmx: z.string().min(1),
  guest_profile: z.string().min(1).describe('Explicit local guest credential profile; never a password.'),
  vm_password_profile: z.string().optional(),
  guest_os: z.enum(['linux', 'windows']).describe('Explicit guest OS; independent of the host OS.'),
  program: text.optional().describe('Absolute guest executable path. Arguments are literal, without shell expansion.'),
  arguments: z.array(text).max(256).default([]),
  script: text.optional().describe('Explicit script text. Requires interpreter and no program.'),
  interpreter: text.optional().describe('Absolute guest interpreter path for script mode.'),
  interpreter_arguments: z.array(text).max(32).default([]),
  guest_temp_directory: z.string().max(512).optional().describe('Existing writable guest directory with a simple absolute path, default /tmp or C:\\Windows\\Temp.'),
  timeout_seconds: z.number().int().min(1).max(600).default(60),
  max_output_bytes: z.number().int().min(1).max(262144).default(65536).describe('Maximum bytes retained per stdout/stderr stream before redaction.'),
  confirm: z.literal(true).describe('Required after authorization for this exact guest command and its effects.'),
}).strict();

function absoluteGuest(value, windows) {
  return typeof value === 'string' && !/[\x00-\x1f]/.test(value) && (windows ? /^[a-z]:\\/i.test(value) : value.startsWith('/'));
}

export function verifyGuestResult(value, nonce, limit) {
  if (!value || value.protocol !== 1 || value.nonce !== nonce || !['completed', 'timed_out', 'unavailable', 'indeterminate'].includes(value.status)) throw new Error('Invalid guest completion record.');
  if (value.status === 'completed' ? !Number.isInteger(value.exit_code) || value.exit_code < -2147483648 || value.exit_code > 4294967295 : value.exit_code !== null) throw new Error('Unverified guest exit code.');
  if (typeof value.timed_out !== 'boolean' || (value.status === 'completed' && value.timed_out) || (value.status === 'timed_out' && !value.timed_out)) throw new Error('Invalid timeout evidence.');
  const output = {};
  for (const stream of ['stdout', 'stderr']) {
    const encoded = value[`${stream}_base64`];
    if (typeof encoded !== 'string' || encoded.length > 4 * Math.ceil(limit / 3) || typeof value[`${stream}_truncated`] !== 'boolean') throw new Error('Invalid output envelope.');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded || bytes.length > limit) throw new Error('Invalid output encoding.');
    output[stream] = bytes.toString('utf8');
    output[`${stream}_bytes`] = bytes.length;
    output[`${stream}_truncated`] = value[`${stream}_truncated`];
  }
  return { status: value.status, exit_code: value.exit_code, timed_out: value.timed_out, ...output };
}

export class GuestExec {
  constructor({ backend, credentials, protectFile }) { Object.assign(this, { backend, credentials, protectFile }); }

  async execute(input, { signal } = {}) {
    const a = guestExecSchema.parse(input);
    const windows = a.guest_os === 'windows';
    const scriptMode = a.script !== undefined;
    if (scriptMode ? a.program !== undefined || !a.interpreter || a.arguments.length : !a.program || a.interpreter !== undefined || a.interpreter_arguments.length) throw new Error('Select program with literal arguments, or script with interpreter/interpreter_arguments.');
    if (!absoluteGuest(scriptMode ? a.interpreter : a.program, windows)) throw new Error('Executable/interpreter must be an absolute path in the selected guest OS.');
    const base = a.guest_temp_directory ?? (windows ? 'C:\\Windows\\Temp' : '/tmp');
    if (!absoluteGuest(base, windows) || !/^[a-zA-Z0-9_./:\\-]+$/.test(base) || base.split(/[\\/]/).includes('..')) throw new Error('Guest temporary directory must be a simple absolute path without spaces, traversal or shell characters.');
    const vmx = await this.backend.vmx(a.vmx);
    return this.backend.resources.use([vmx], () => this.perform(a, vmx, base, signal));
  }

  async perform(a, vmx, base, signal) {
    const nonce = randomUUID();
    const guestPath = a.guest_os === 'windows' ? path.win32 : path.posix;
    const guestDirectory = guestPath.join(base, `vmware-mcp-exec-${nonce}`);
    const result = { vmx, status: 'unavailable', exit_code: null, timed_out: false, cancelled: false,
      transport: { status: 'not_started', phase: 'setup', launch_succeeded: false },
      stdout: '', stderr: '', stdout_bytes: 0, stderr_bytes: 0, stdout_truncated: false, stderr_truncated: false,
      cleanup: { guest: 'not_created', host: 'not_created' },
      note: 'Only a matching completion record verifies a guest exit code. Never retry an indeterminate command automatically.' };
    let hostDirectory; let created = false; let verified = false;
    // Guest command timeout plus a fixed, bounded setup/transfer grace period.
    const deadline = performance.now() + (a.timeout_seconds + 30) * 1000;
    let authentication;
    const run = async (command, args = [], mutation = false, cleanup = false) => {
      if (!cleanup) signal?.throwIfAborted();
      return this.backend.run([command, vmx, ...args], { authentication, mutation,
        timeout: cleanup ? 5000 : 10000, deadline: cleanup ? performance.now() + 5000 : deadline,
        signal: cleanup ? undefined : signal });
    };
    try {
      const guest = await this.credentials.guest(a.guest_profile);
      authentication = ['-gu', guest.username, '-gp', guest.password];
      if (a.vm_password_profile) authentication.unshift('-vp', await this.credentials.vm(a.vm_password_profile));
      const scratch = await this.backend.hostPath(this.backend.env.VMWARE_GUEST_EXEC_ROOT || os.tmpdir(), 'directory');
      hostDirectory = await fs.mkdtemp(path.join(scratch, 'vmware-mcp-exec-'));
      result.cleanup.host = 'pending';
      const request = { nonce, program: a.program || '', arguments: a.arguments, script: a.script ?? null,
        interpreter: a.interpreter || '', interpreter_arguments: a.interpreter_arguments,
        timeout_seconds: a.timeout_seconds, max_output_bytes: a.max_output_bytes };
      const runner = a.guest_os === 'windows' ? 'runner.ps1' : 'runner.py';
      for (const [name, content] of [['request.json', JSON.stringify(request)], [runner, a.guest_os === 'windows' ? windowsRunner : linuxRunner]]) {
        const file = path.join(hostDirectory, name);
        await fs.writeFile(file, '', { flag: 'wx', mode: 0o600 });
        await this.protectFile(file);
        await fs.writeFile(file, content);
      }
      result.transport.phase = 'tools';
      if ((await run('checkToolsState')) !== 'running') throw new Error('Tools unavailable');
      result.transport.phase = 'create_directory';
      result.cleanup.guest = 'creation_unconfirmed'; result.cleanup.guest_directory = guestDirectory;
      await run('createDirectoryInGuest', [guestDirectory], true);
      created = true; result.cleanup.guest = 'pending'; delete result.cleanup.guest_directory;
      result.transport.phase = 'upload';
      for (const name of ['request.json', runner]) await run('CopyFileFromHostToGuest', [path.join(hostDirectory, name), guestPath.join(guestDirectory, name)], true);
      result.transport.phase = 'launch';
      const launch = a.guest_os === 'windows'
        ? ['-noWait', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', guestPath.join(guestDirectory, runner)]
        : ['-noWait', '/usr/bin/python3', guestPath.join(guestDirectory, runner)];
      // Set before awaiting: even failed transport may have launched a process.
      result.status = 'indeterminate';
      await run('runProgramInGuest', launch, true);
      result.transport.launch_succeeded = true;
      result.transport.phase = 'completion';
      while (true) {
        const exists = await run('fileExistsInGuest', [guestPath.join(guestDirectory, 'result.json')]);
        if (exists === 'The file exists.') break;
        if (exists !== 'The file does not exist.') throw new Error('Unrecognized existence response');
        if (performance.now() >= deadline) throw new Error('Completion deadline');
        await delay(Math.min(200, Math.max(1, deadline - performance.now())), undefined, { signal });
      }
      result.transport.phase = 'download';
      const output = path.join(hostDirectory, 'result.json');
      await fs.writeFile(output, '', { flag: 'wx', mode: 0o600 }); await this.protectFile(output);
      await run('CopyFileFromGuestToHost', [guestPath.join(guestDirectory, 'result.json'), output]);
      const handle = await fs.open(output, 'r');
      let bytes;
      try {
        // Runner envelopes are bounded independently of guest program output.
        const cap = 8 * Math.ceil(a.max_output_bytes / 3) + 4096;
        if ((await handle.stat()).size > cap) throw new Error('Completion record exceeds output bounds');
        bytes = Buffer.alloc(cap + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > cap) throw new Error('Completion record exceeds output bounds');
        bytes = bytes.subarray(0, bytesRead);
      } finally { await handle.close(); }
      result.transport.phase = 'verify';
      Object.assign(result, verifyGuestResult(JSON.parse(bytes.toString('utf8')), nonce, a.max_output_bytes));
      verified = true;
      result.transport.status = 'succeeded';
    } catch (error) {
      result.cancelled = !!signal?.aborted;
      result.timed_out = !result.cancelled && (performance.now() >= deadline || ['VMRUN_TIMEOUT', 'OBSERVATION_DEADLINE'].includes(error.code));
      result.transport.status = result.cancelled ? 'cancelled' : result.timed_out ? 'timed_out' : 'failed';
      // Never expose native errors, command text or credentials in errors.
    } finally {
      if (created) {
        if (verified) {
          try { await run('deleteDirectoryInGuest', [guestDirectory], true, true); result.cleanup.guest = 'removed'; }
          catch { result.cleanup.guest = 'failed'; result.cleanup.guest_directory = guestDirectory; }
        } else { result.cleanup.guest = 'retained_outcome_unknown'; result.cleanup.guest_directory = guestDirectory; }
      }
      if (hostDirectory) {
        try { await fs.rm(hostDirectory, { recursive: true }); result.cleanup.host = 'removed'; }
        catch { result.cleanup.host = 'failed'; }
      }
    }
    result.stdout = this.credentials.redact(result.stdout);
    result.stderr = this.credentials.redact(result.stderr);
    return result;
  }
}
