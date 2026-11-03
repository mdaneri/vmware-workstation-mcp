import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';

export const serialError = (code, message) => Object.assign(new Error(message), { code });
const failure = () => serialError('SERIAL_UNAVAILABLE', 'Serial endpoint unavailable or its VMware VM owner could not be verified. Start the configured VM headlessly; run as its owner in the same namespace. No GUI fallback is available.');

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
    child.once('exit', code => { if (!ready) fail(failure()); else if (code) stream.destroy(failure()); });
    child.stderr.on('data', chunk => {
      if (ready) return;
      stderr += chunk.toString('utf8');
      if (stderr.length > 1024) { fail(failure()); return; }
      if (!stderr.includes('SERIAL_READY\n')) return;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
      stream.once('close', stop); ready = true; resolve(stream);
    });
    // Observe pipe errors even if spawning PowerShell itself fails.
    child.stdin.on('error', () => fail(failure())); child.stdout.on('error', () => fail(failure()));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
