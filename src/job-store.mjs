import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { readPrivateFile } from './local-file-security.mjs';

export function jobDirectory(env = process.env) {
  if (env.VMWARE_JOB_DIRECTORY) {
    if (!path.isAbsolute(env.VMWARE_JOB_DIRECTORY)) throw new Error('VMWARE_JOB_DIRECTORY must be absolute.');
    return env.VMWARE_JOB_DIRECTORY;
  }
  const base = process.platform === 'win32' ? env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'vmware-workstation-mcp', 'jobs');
}
const validID = /^[0-9a-f-]{36}:[0-9a-f-]{36}$/;
const filename = id => { if (!validID.test(id)) throw new Error('Invalid persisted job ID.'); return id.replace(':', '_') + '.json'; };
const recordName = /^[0-9a-f-]{36}_[0-9a-f-]{36}\.json$/;

// Only small redacted journals are managed here. VMware output directories are
// user-selected, never copied into the journal and never automatically deleted.
export class JobStore {
  constructor({ directory, protectFile, protectDirectory = protectFile, maxRecords = 100, retentionMs = 7 * 86400000, maxBytes = 262144 } = {}) {
    this.directory = directory; this.protectFile = protectFile; this.protectDirectory = protectDirectory;
    this.maxRecords = maxRecords; this.retentionMs = retentionMs; this.maxBytes = maxBytes;
    this.tail = Promise.resolve();
  }
  async load() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Job journal must be a private, regular directory, not a link.');
    if (process.platform === 'linux') {
      if (stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error('Job journal directory must be owned by this user with mode 700.');
    } else await this.protectDirectory(this.directory);
    const records = [];
    const entries = await fs.readdir(this.directory);
    if (entries.filter(entry => recordName.test(entry)).length > this.maxRecords) throw new Error('Job journal count exceeds its storage limit; inspect the directory.');
    for (const entry of entries) {
      if (!recordName.test(entry)) continue;
      const file = path.join(this.directory, entry), info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > this.maxBytes) throw new Error('Unsafe or oversized job journal; inspect the journal directory.');
      let record;
      try {
        record = JSON.parse(process.platform === 'linux' ? await readPrivateFile(file) : await fs.readFile(file, 'utf8'));
        if (filename(record.job_id) !== entry || !Number.isFinite(Date.parse(record.started_at)) || !['running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(record.state)) throw new Error();
      } catch { throw new Error('Job journal is invalid; inspect it before starting more jobs.'); }
      records.push(record);
    }
    return records.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  }
  write(record, retainedIDs) {
    const body = JSON.stringify(record);
    if (Buffer.byteLength(body) > this.maxBytes) return Promise.reject(new Error('Job journal record exceeded its storage limit.'));
    const operation = this.tail.then(async () => {
      const entries = await fs.readdir(this.directory);
      if (!entries.includes(filename(record.job_id)) && entries.filter(entry => recordName.test(entry)).length >= this.maxRecords) throw new Error('Job journal record limit reached. Another server may be writing history.');
      if (entries.filter(entry => /^\.[0-9a-f-]{36}\.tmp$/.test(entry)).length >= 4) throw new Error('Interrupted journal temporary-file limit reached; inspect the private journal directory.');
      // Protect an empty temporary file before any result or output is written.
      const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o600); await handle.close();
        await this.protectFile(temporary);
        const output = await fs.open(temporary, 'r+');
        try { await output.writeFile(body); await output.sync(); } finally { await output.close(); }
        await fs.rename(temporary, path.join(this.directory, filename(record.job_id)));
      } finally { await fs.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
      // Prune only validated journal names. Never recurse or touch VM artifacts.
      const cutoff = Date.now() - this.retentionMs;
      for (const entry of await fs.readdir(this.directory)) {
        if (!recordName.test(entry) || retainedIDs.has(entry.slice(0, -5).replace('_', ':'))) continue;
        const file = path.join(this.directory, entry), info = await fs.lstat(file);
        if (info.isFile() && !info.isSymbolicLink() && info.mtimeMs < cutoff) await fs.unlink(file);
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
  async remove(id) { await this.tail; await fs.unlink(path.join(this.directory, filename(id))).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}
