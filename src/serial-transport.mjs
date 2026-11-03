import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';

export const serialError = (code, message) => Object.assign(new Error(message), { code });
const failure = () => serialError('SERIAL_UNAVAILABLE', 'Serial endpoint unavailable or its VMware VM owner could not be verified. Start the configured VM headlessly; run as its owner in the same namespace. No GUI fallback is available.');
const bridgeFailures = {
  SERIAL_BRIDGE_UNAVAILABLE: 'Windows serial bridge unavailable. Install PowerShell 7 and allow its native pipe helper to run.',
  SERIAL_CONNECT_FAILED: 'Local serial pipe unavailable. Start the explicitly configured VM headlessly and check that its serial port is connected.',
  SERIAL_OWNER_UNAVAILABLE: 'Serial pipe owner or exact command line unavailable. Run as the VM owner with permission to inspect the native VMware worker.',
  SERIAL_WRONG_WORKER: 'Serial endpoint owner is not a native VMware worker.',
  SERIAL_WRONG_VM: 'Serial endpoint owner belongs to a different VM. The exact VMX argument is required.',
  SERIAL_IO_FAILED: 'Serial transport failed. Inspect guest state before reconnecting; input is never replayed.',
};

// Require a native VMware worker holding this listening UNIX socket, with the
// exact VMX argv entry. A socket file alone is not evidence of a VM console.
export async function verifyUnixSerial(endpoint, { procRoot = '/proc' } = {}) {
  const stat = await fs.lstat(endpoint.path);
  if (!stat.isSocket() || stat.uid !== process.getuid()) throw failure();
  const rows = (await fs.readFile(path.join(procRoot, 'net/unix'), 'utf8')).split('\n').slice(1);
  const inodes = new Set(rows.flatMap(row => {
    const m = row.match(/^\S+\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.+)$/);
    return m && m[1] === '00010000' && m[2] === '0001' && m[4] && m[5] === endpoint.path ? [m[4]] : [];
  }));
  if (!inodes.size) throw failure();
  const verified = new Set();
  for (const pid of (await fs.readdir(procRoot)).filter(name => /^\d+$/.test(name))) {
    let descriptors;
    try { descriptors = await fs.readdir(path.join(procRoot, pid, 'fd')); }
    catch (e) { if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(e.code)) continue; throw e; }
    for (const fd of descriptors) {
      let link;
      try { link = await fs.readlink(path.join(procRoot, pid, 'fd', fd)); }
      catch (e) { if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM', 'EINVAL'].includes(e.code)) continue; throw e; }
      const inode = link.match(/^socket:\[(\d+)\]$/)?.[1];
      if (!inodes.has(inode)) continue;
      try {
        const executable = await fs.readlink(path.join(procRoot, pid, 'exe'));
        const args = (await fs.readFile(path.join(procRoot, pid, 'cmdline'), 'utf8')).split('\0');
        if (path.basename(executable) !== 'vmware-vmx' || !args.includes(endpoint.vmx)) throw failure();
        verified.add(inode);
      } catch { throw failure(); }
    }
  }
  if (verified.size !== inodes.size) throw failure();
}

export async function connectSerial(endpoint, { signal, timeoutMs = 10000, platform = process.platform, bridgeScript } = {}) {
  signal?.throwIfAborted();
  if (platform === 'linux') {
    await verifyUnixSerial(endpoint);
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: endpoint.path });
      const finish = error => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        socket.off('error', onError); socket.off('connect', onConnect);
        if (error) { socket.destroy(); reject(error); } else resolve(socket);
      };
      const abort = () => finish(serialError('SERIAL_CANCELLED', 'Serial connection cancelled.'));
      const onError = () => finish(failure());
      const onConnect = () => finish();
      const timer = setTimeout(() => finish(failure()), timeoutMs);
      socket.once('error', onError); socket.once('connect', onConnect);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  if (platform !== 'win32') throw serialError('SERIAL_UNSUPPORTED', 'Direct serial requires native Windows or Linux Workstation.');
  // The bridge verifies GetNamedPipeServerProcessId on the SAME open handle it
  // uses for I/O. Node exposes no supported Windows pipe HANDLE API.
  const script = bridgeScript || path.resolve(path.dirname(process.argv[1]), '..', 'scripts', 'Serial-Bridge.ps1');
  return new Promise((resolve, reject) => {
    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, '-PipeName', endpoint.path.slice('\\\\.\\pipe\\'.length), '-VMX', endpoint.vmx, '-ConnectTimeoutMs', String(timeoutMs)], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stream; let ready = false; let stderr = '';
    const stop = () => { child.stdin.destroy(); child.stdout.destroy(); child.kill(); };
    const fail = error => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (!ready) { stop(); reject(error); } else stream.destroy(error);
    };
    const abort = () => fail(serialError('SERIAL_CANCELLED', 'Serial connection cancelled.'));
    const timer = setTimeout(() => fail(failure()), timeoutMs + 2000);
    child.once('error', () => fail(failure()));
    child.once('exit', code => {
      if (!ready) fail(failure());
      else if (code !== 0) stream.destroy(failure());
      else stream.end();
    });
    child.stderr.on('data', chunk => {
      if (ready) return;
      stderr += chunk.toString('utf8');
      if (stderr.length > 1024) { fail(failure()); return; }
      const code = stderr.match(/(?:^|\n)(SERIAL_[A-Z_]+)\r?\n/)?.[1];
      if (Object.hasOwn(bridgeFailures, code)) { fail(serialError(code, bridgeFailures[code])); return; }
      if (!stderr.includes('SERIAL_READY\n')) return;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      // Child stdin closes on process exit without emitting writable finish.
      // Duplex.from treats that as premature close even after clean stdout EOF,
      // which would discard the manager's unread receive buffer. Own the stream
      // lifecycle instead, finishing writes only on a successful bridge exit.
      stream = new Duplex({
        read() { child.stdout.resume(); },
        write(bytes, encoding, callback) { child.stdin.write(bytes, encoding, callback); },
        final(callback) { if (child.exitCode === 0) callback(); else child.stdin.end(callback); },
        destroy(error, callback) { stop(); callback(error); },
      });
      child.stdout.on('data', bytes => { if (!stream.push(bytes)) child.stdout.pause(); });
      child.stdout.once('end', () => stream.push(null));
      child.stdout.once('close', () => { if (!child.stdout.readableEnded && !stream.destroyed) fail(failure()); });
      ready = true; resolve(stream);
    });
    // Observe pipe errors even if spawning PowerShell itself fails.
    child.stdin.on('error', () => fail(failure())); child.stdout.on('error', () => fail(failure()));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
