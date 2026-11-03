import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseAssignments } from './workstation.mjs';
import { connectSerial, serialError } from './serial-transport.mjs';

const target = { vm_id: z.string().min(1), port: z.number().int().min(0).max(3).default(0) };
const timeout = z.number().int().min(1).max(10000).default(1000);
export const serialSchemas = {
  serial_status: z.object(target).strict(),
  serial_configure: z.object({ ...target, enabled: z.boolean().default(true), confirm: z.literal(true).describe('Set only after authorization to replace this serial port configuration in the powered-off VM.') }).strict(),
  serial_connect: z.object({ ...target, timeout_ms: z.number().int().min(1).max(10000).default(10000) }).strict(),
  serial_read: z.object({ ...target, max_bytes: z.number().int().min(1).max(65536).default(4096), encoding: z.enum(['base64', 'utf8']).default('base64'), timeout_ms: timeout }).strict(),
  serial_write: z.object({ ...target, data: z.string().max(87384), encoding: z.enum(['base64', 'utf8']).default('utf8'), timeout_ms: timeout }).strict(),
  serial_disconnect: z.object(target).strict(),
};
const configOf = text => Object.fromEntries(Object.entries(parseAssignments(text)).map(([key, value]) => [key.toLowerCase(), value]));
const cancelled = () => serialError('SERIAL_CANCELLED', 'Serial operation cancelled.');
const disconnected = () => serialError('SERIAL_DISCONNECTED', 'Serial session disconnected. Inspect state and explicitly reconnect; input is never replayed.');

export class SerialManager {
  constructor({ backend, vmFiles, credentials, rest, connector = connectSerial, platform = process.platform, maxConnections = 8, maxBufferedBytes = 262144, idleMs = 300000 } = {}) {
    Object.assign(this, { backend, vmFiles, credentials, rest, connector, platform, maxConnections, maxBufferedBytes, idleMs });
    this.sessions = new Map(); this.lastErrors = new Map(); this.closed = false;
  }
  key(vmx, port) { return `${this.platform === 'win32' ? vmx.toLowerCase() : vmx}\0${port}`; }
  async resolve(vmID) {
    const profiles = this.credentials ? (await this.credentials.load()).console || {} : {};
    const aliases = Object.fromEntries(Object.entries(profiles).filter(([, p]) => typeof p?.vmx === 'string').map(([name, p]) => [name, p.vmx]));
    return this.backend.resolveVM(vmID, { aliases, restInventory: this.rest ? async () => {
      const response = await this.rest.request('GET', '/api/vms');
      if (!Array.isArray(response.data)) throw serialError('SERIAL_SETUP_REQUIRED', 'REST VM inventory unavailable. Supply an absolute VMX path.');
      return response.data;
    } : undefined });
  }
  endpoint(vmx, port) {
    if (!['win32', 'linux'].includes(this.platform)) throw serialError('SERIAL_UNSUPPORTED', 'Direct serial requires native Windows or Linux Workstation.');
    const digest = createHash('sha256').update(this.key(vmx, port)).digest('hex').slice(0, 32);
    const endpoint = this.platform === 'win32' ? `\\\\.\\pipe\\vmware-mcp-serial-${digest}-${port}` : path.join(path.dirname(vmx), '.mcp-serial', `${digest}-${port}.sock`);
    if (this.platform === 'linux' && Buffer.byteLength(endpoint) > 103) throw serialError('SERIAL_SETUP_REQUIRED', 'VM directory is too long for a portable UNIX socket path. Use a shorter approved native VM path.');
    return { vmx, port, path: endpoint, key: this.key(vmx, port), transport: this.platform === 'win32' ? 'local Windows named pipe' : 'local UNIX stream socket' };
  }
  async localPath(endpoint, create = false) {
    if (this.platform !== 'linux') return;
    const parent = path.dirname(endpoint.path);
    // Apply the existing host allowlist, including realpath/dangling-link checks.
    if (await this.backend.hostPath(endpoint.path, 'serial-socket') !== endpoint.path) throw serialError('SERIAL_UNSAFE_ENDPOINT', 'Serial endpoint must not traverse links.');
    if (create) await fs.mkdir(parent, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw serialError('SERIAL_UNSAFE_ENDPOINT', 'Serial socket directory must be owned by the current user with mode 700.');
    const socket = await fs.lstat(endpoint.path).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (socket && (!socket.isSocket() || socket.uid !== process.getuid())) throw serialError('SERIAL_UNSAFE_ENDPOINT', 'Serial endpoint must be a local UNIX socket owned by the current user.');
  }
  async configured(vmx, port) {
    const endpoint = this.endpoint(vmx, port);
    const config = configOf(await fs.readFile(vmx, 'utf8')); const prefix = `serial${port}.`;
    if (config[prefix + 'present']?.toLowerCase() !== 'true') throw serialError('SERIAL_SETUP_REQUIRED', 'No enabled serial device on this port. Authorize serial_configure while powered off, then enable a serial console in the guest.');
    if (config[prefix + 'filetype']?.toLowerCase() !== 'pipe' || config[prefix + 'pipe.endpoint']?.toLowerCase() !== 'server' || config[prefix + 'startconnected']?.toLowerCase() !== 'true' || config[prefix + 'trynorxloss']?.toLowerCase() !== 'true') throw serialError('SERIAL_UNSUPPORTED_MODE', 'Serial requires a server-side application pipe/socket. Physical devices, files, VM-to-VM pipes and network/Telnet modes are unsupported. Reconfigure explicitly while powered off.');
    const filename = config[prefix + 'filename'];
    if ((this.platform === 'win32' ? filename?.toLowerCase() : filename) !== (this.platform === 'win32' ? endpoint.path.toLowerCase() : endpoint.path)) throw serialError('SERIAL_UNSAFE_ENDPOINT', 'Serial endpoint does not match this VM and port. Only the generated per-VM local endpoint is approved; arbitrary paths and remote sockets are refused.');
    await this.localPath(endpoint);
    return endpoint;
  }
  async status(input) {
    const a = serialSchemas.serial_status.parse(input); const vmx = await this.resolve(a.vm_id);
    const session = this.sessions.get(this.key(vmx, a.port));
    try {
      const endpoint = await this.configured(vmx, a.port);
      const previous = this.lastErrors.get(endpoint.key);
      return { ...endpoint, key: undefined, host_supported: true, configured: true, running: (await this.backend.details(vmx)).running, connected: !!session?.ready && !session.closed && !session.ended, connecting: !!session && !session.ready, eof: !!session?.ended, buffered_bytes: session?.buffer.length || 0, runtime_verified: !!session?.ready && !session.closed && !session.ended, last_error: previous ? { code: previous.code, message: previous.message } : undefined, requires_vmware_tools: false, note: 'Configured mode is documented Workstation support; only a connected session proves the native endpoint owner. Guest serial output/login must be configured separately.' };
    } catch (e) {
      if (session) this.drop(session, e);
      return { vmx, port: a.port, host_supported: ['win32', 'linux'].includes(this.platform), configured: false, connected: false, code: e.code || 'SERIAL_SETUP_REQUIRED', reason: e.message, requires_vmware_tools: false };
    }
  }
  async configure(input) {
    const a = serialSchemas.serial_configure.parse(input); const vmx = await this.resolve(a.vm_id);
    return this.backend.resources.use([vmx], async () => {
      const endpoint = this.endpoint(vmx, a.port);
      if (this.sessions.has(endpoint.key)) throw serialError('SERIAL_BUSY', 'Disconnect this serial session before reconfiguring.');
      const original = await fs.readFile(vmx, 'utf8'); const config = configOf(original);
      const offline = async () => {
        if ((await this.backend.details(vmx)).running) throw serialError('SERIAL_VM_RUNNING', 'Power off the VM before changing serial hardware.');
        if ((await fs.readdir(path.dirname(vmx))).some(name => /\.(?:lck|vmss|vmem)$/i.test(name))) throw serialError('SERIAL_VM_BUSY', 'VM directory has locks or saved state. Fully power off and close the VM before editing serial hardware.');
        for (const key of ['checkpoint.vmstate', 'suspend.filename']) if (config[key]) {
          const state = path.resolve(path.dirname(vmx), config[key]);
          try { await fs.access(state); throw serialError('SERIAL_VM_BUSY', 'VM has saved state. Fully power it off before editing serial hardware.'); }
          catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
      };
      await offline();
      if (a.enabled) await this.localPath(endpoint, true);
      const prefix = `serial${a.port}.`; const settings = {};
      // Replacement is explicit: do not leave stale device/network backings.
      for (const key of Object.keys(config)) if (key.startsWith(prefix)) settings[key] = null;
      Object.assign(settings, { [prefix + 'present']: a.enabled ? 'TRUE' : 'FALSE', [prefix + 'startconnected']: a.enabled ? 'TRUE' : 'FALSE' });
      if (a.enabled) Object.assign(settings, { [prefix + 'filetype']: 'pipe', [prefix + 'filename']: endpoint.path, [prefix + 'pipe.endpoint']: 'server', [prefix + 'trynorxloss']: 'TRUE', [prefix + 'yieldonmsrread']: 'TRUE' });
      const result = await this.vmFiles.configure({ vmx, settings }, { expectedOriginal: original, beforeCommit: offline });
      return { ...result, port: a.port, enabled: a.enabled, endpoint: a.enabled ? endpoint.path : null, note: 'VMX backed up. No VM was started. Configure guest serial output/login separately. Endpoint directories and sockets are never deleted automatically.' };
    });
  }
  touch(session) {
    clearTimeout(session.timer);
    if (session.closed) return;
    session.timer = setTimeout(() => {
      if (session.reading || session.writing || !session.ready) this.touch(session);
      else this.drop(session, serialError('SERIAL_IDLE', 'Serial session expired after inactivity. Explicitly reconnect.'));
    }, this.idleMs); session.timer.unref();
  }
  drop(session, error = disconnected()) {
    if (session.closed) return;
    session.closed = true; session.error = error; clearTimeout(session.timer); session.controller.abort(); session.stream?.destroy();
    this.lastErrors.delete(session.key); this.lastErrors.set(session.key, error);
    if (this.lastErrors.size > 32) this.lastErrors.delete(this.lastErrors.keys().next().value);
    session.buffer = Buffer.alloc(0);
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
    for (const wake of session.waiters) wake(error);
  }
  async connect(input, { signal } = {}) {
    const a = serialSchemas.serial_connect.parse(input); const vmx = await this.resolve(a.vm_id);
    if (this.closed) throw disconnected();
    return this.backend.resources.use([vmx], async () => {
      const endpoint = await this.configured(vmx, a.port);
      if (signal?.aborted) throw cancelled();
      if (this.sessions.has(endpoint.key)) throw serialError('SERIAL_BUSY', 'This VM port already has a session. Read/write it or disconnect explicitly.');
      if (!(await this.backend.details(vmx)).running) throw serialError('SERIAL_VM_STOPPED', 'Serial requires this VM to be running. Connect never starts a VM.');
      // Recheck after async preflight: connections for other VMs can progress
      // independently, but must not race past the shared session limit.
      if (this.closed) throw disconnected();
      if (this.sessions.size >= this.maxConnections) throw serialError('SERIAL_LIMIT', 'Serial connection limit reached. Disconnect an idle VM port.');
      const session = { ...endpoint, controller: new AbortController(), buffer: Buffer.alloc(0), waiters: new Set(), ready: false, closed: false };
      this.sessions.set(session.key, session);
      this.lastErrors.delete(session.key);
      const abort = () => this.drop(session, cancelled());
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => this.drop(session, serialError('SERIAL_TIMEOUT', 'Timed out connecting to serial.')), a.timeout_ms);
      try {
        // Preflight may have been cancelled before the listener was registered.
        if (signal?.aborted) throw cancelled();
        session.stream = await this.connector(endpoint, { signal: session.controller.signal, timeoutMs: a.timeout_ms, platform: this.platform });
        // Always observe stream errors, including cancellation during connection.
        session.stream.on('error', () => this.drop(session, serialError('SERIAL_IO_FAILED', 'Serial transport failed. Inspect guest state before reconnecting.')));
        if (session.closed || this.closed) { session.stream.destroy(); throw session.error || disconnected(); }
        session.stream.on('data', bytes => {
          if (session.closed) return;
          if (session.buffer.length + bytes.length > this.maxBufferedBytes) { this.drop(session, serialError('SERIAL_OVERFLOW', 'Serial receive buffer exceeded its limit; disconnected without silently dropping bytes. Read promptly after reconnecting.')); return; }
          session.buffer = Buffer.concat([session.buffer, bytes]);
          for (const wake of session.waiters) wake();
        });
        const ended = () => { if (session.closed) return; session.ended = true; for (const wake of session.waiters) wake(); };
        session.stream.once('end', ended); session.stream.once('close', ended);
        session.ready = true; this.touch(session);
        return { vmx, port: a.port, connected: true, transport: endpoint.transport, endpoint: endpoint.path, receive_limit_bytes: this.maxBufferedBytes, note: 'Raw serial bytes only. Guest output is opt-in; connection does not prove a guest console is enabled.' };
      } catch (e) { this.drop(session, session.error || e); throw session.error; }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    });
  }
  async session(a) {
    const vmx = await this.resolve(a.vm_id); const session = this.sessions.get(this.key(vmx, a.port));
    if (!session?.ready || session.closed) throw this.lastErrors.get(this.key(vmx, a.port)) || disconnected();
    try { await this.configured(vmx, a.port); }
    catch (e) { this.drop(session, e); throw e; }
    if (session.closed) throw session.error;
    this.touch(session); return session;
  }
  async read(input, { signal } = {}) {
    const a = serialSchemas.serial_read.parse(input); const session = await this.session(a);
    if (session.reading) throw serialError('SERIAL_BUSY', 'A read is already pending on this VM port.');
    if (signal?.aborted) throw cancelled();
    session.reading = true;
    try {
      const timedOut = !session.buffer.length && !session.ended && await new Promise((resolve, reject) => {
        const finish = (error, timeout = false) => {
          clearTimeout(timer); session.waiters.delete(wake); signal?.removeEventListener('abort', abort);
          error ? reject(error) : resolve(timeout);
        };
        const wake = error => finish(error); const abort = () => finish(cancelled());
        const timer = setTimeout(() => finish(null, true), a.timeout_ms);
        session.waiters.add(wake); signal?.addEventListener('abort', abort, { once: true });
        if (session.closed) wake(session.error); else if (signal?.aborted) abort(); else if (session.buffer.length) wake();
      });
      if (session.closed) throw session.error;
      if (signal?.aborted) throw cancelled();
      const bytes = session.buffer.subarray(0, a.max_bytes); session.buffer = session.buffer.subarray(bytes.length);
      return { vmx: session.vmx, port: a.port, data: bytes.toString(a.encoding), encoding: a.encoding, bytes: bytes.length, remaining_bytes: session.buffer.length, timed_out: !!timedOut, eof: !!session.ended, ...(a.encoding === 'utf8' ? { raw_base64: bytes.toString('base64'), note: 'UTF-8 is decoded per read and may split a code point. raw_base64 preserves the exact bytes; use base64 for streaming decoders.' } : {}) };
    } finally { session.reading = false; this.touch(session); }
  }
  async write(input, { signal } = {}) {
    const a = serialSchemas.serial_write.parse(input);
    if (a.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.data)) throw serialError('SERIAL_INVALID_BYTES', 'Provide canonical padded base64.');
    const bytes = Buffer.from(a.data, a.encoding);
    if (!bytes.length || bytes.length > 65536 || (a.encoding === 'base64' && bytes.toString('base64') !== a.data)) throw serialError('SERIAL_INVALID_BYTES', 'Write must contain 1 to 65536 bytes in UTF-8 or canonical base64.');
    const session = await this.session(a);
    if (session.ended) throw disconnected();
    if (session.writing) throw serialError('SERIAL_BUSY', 'A write is already pending on this VM port.');
    if (signal?.aborted) throw cancelled();
    session.writing = true;
    try {
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer); session.waiters.delete(wake); signal?.removeEventListener('abort', abort);
          if (error) { this.drop(session, error); reject(error); } else resolve();
        };
        // Remove wake before drop to avoid recursively completing this write.
        const wake = error => { if (error) finish(error); };
        const abort = () => finish(serialError('SERIAL_CANCELLED', 'Serial write cancelled. Some bytes may have reached the guest; inspect state before retrying.'));
        const timer = setTimeout(() => finish(serialError('SERIAL_TIMEOUT', 'Serial write timed out. Some bytes may have reached the guest; input is never replayed.')), a.timeout_ms);
        session.waiters.add(wake); signal?.addEventListener('abort', abort, { once: true });
        if (session.closed) wake(session.error); else if (signal?.aborted) abort(); else {
          try { session.stream.write(bytes, error => finish(error ? serialError('SERIAL_IO_FAILED', 'Serial write failed. Some bytes may have reached the guest; inspect before retrying.') : null)); }
          catch { finish(serialError('SERIAL_IO_FAILED', 'Serial write failed. Inspect guest state before retrying.')); }
        }
      });
      return { vmx: session.vmx, port: a.port, bytes: bytes.length, accepted: true, note: 'Accepted by the local transport; guest execution/receipt is not acknowledged. Input is never automatically replayed.' };
    } finally { session.writing = false; this.touch(session); }
  }
  async disconnect(input) {
    const a = serialSchemas.serial_disconnect.parse(input); const vmx = await this.resolve(a.vm_id);
    const session = this.sessions.get(this.key(vmx, a.port));
    if (session) this.drop(session);
    return { vmx, port: a.port, connected: false, was_connected: !!session, note: 'Pending I/O cancelled and buffered bytes discarded. VM power and serial configuration unchanged.' };
  }
  close() { this.closed = true; for (const session of this.sessions.values()) this.drop(session); }
}
