import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import path from 'node:path';
import { Resources } from './resources.mjs';

const jobID = z.string().min(1).max(100);
export const jobSchemas = {
  job_status: z.object({ job_id: jobID }).strict(),
  job_list: z.object({}).strict(),
  job_cancel: z.object({ job_id: jobID }).strict(),
  job_logs: z.object({ job_id: jobID }).strict(),
};
export const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
const uncertain = 'Partial files or VM changes may remain. Inspect all reported artifact paths before retrying; no rollback was attempted.';

export class JobManager {
  constructor({ redact = text => text, spawnProcess = spawn, maxActive = 4, maxRecords = 100, resources = new Resources(), store } = {}) {
    if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 32 || !Number.isInteger(maxRecords) || maxRecords < maxActive || maxRecords > 100) throw new Error('Invalid job concurrency/history limits.');
    this.session = randomUUID(); this.jobs = new Map(); this.redact = redact; this.resources = resources; this.store = store;
    this.spawnProcess = spawnProcess; this.maxActive = maxActive; this.maxRecords = maxRecords; this.closed = false;
    this.initialized = !store;
  }
  async initialize() {
    this.initializing ??= (async () => {
      if (!this.store) return;
      const records = await this.store.load();
      for (const record of records) {
        if (!terminal.has(record.state)) {
          record.state = 'interrupted'; record.progress = null;
          record.error = 'Previous server session; outcome unknown and an orphaned process may still exist. ' + uncertain;
          delete record.result;
        }
        record.historical = true;
        if (Date.parse(record.finished_at || record.started_at) < Date.now() - this.store.retentionMs) await this.store.remove(record.job_id);
        else this.jobs.set(record.job_id, record);
      }
      while (this.jobs.size > this.maxRecords) {
        const id = this.jobs.keys().next().value; this.jobs.delete(id); await this.store.remove(id);
      }
      this.initialized = true;
    })();
    await this.initializing;
    if (this.store) for (const job of this.jobs.values()) if (terminal.has(job.state) && Date.parse(job.finished_at || job.started_at) < Date.now() - this.store.retentionMs) {
      this.jobs.delete(job.job_id); await this.store.remove(job.job_id);
    }
  }
  start({ operation, resources = [], artifacts = [], timeout = 3600000, task }) {
    if (this.closed) throw new Error('Job manager is shutting down.');
    if (!this.initialized) throw new Error('Initialize the job journal before admission.');
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 86400000 || typeof task !== 'function') throw new Error('Invalid job task or timeout.');
    const active = [...this.jobs.values()].filter(job => !terminal.has(job.state));
    if (active.length >= this.maxActive) throw new Error('Background job limit reached. Wait for a job to finish.');
    let reservation;
    try { reservation = this.resources.reserve(resources); }
    catch (cause) { throw Object.assign(new Error('A conflicting operation already uses this source or destination. Wait for it to finish.', { cause }), { code: 'RESOURCE_BUSY' }); }
    const evicted = [];
    while (this.jobs.size >= this.maxRecords) {
      const oldest = [...this.jobs.values()].find(job => terminal.has(job.state));
      if (!oldest) { reservation.release(); throw new Error('Job history is full.'); }
      this.jobs.delete(oldest.job_id); evicted.push(oldest.job_id);
    }
    const job = { job_id: `${this.session}:${randomUUID()}`, operation, state: 'running', started_at: new Date().toISOString(), progress: null,
      artifacts: [...new Set(artifacts)].slice(0, 64), logs: '', controller: new AbortController() };
    this.jobs.set(job.job_id, job);
    if (this.store) job.flushTimer = setInterval(async () => {
      if (!job.dirty || job.flushing || job.finalizing) return;
      job.flushing = true; job.dirty = false;
      try { await this.persist(job); }
      catch { this.stop(job, 'interrupted'); }
      finally { job.flushing = false; }
    }, 1000);
    job.timer = setTimeout(() => this.stop(job, 'timed_out'), timeout);
    job.done = reservation.run(async () => {
      const context = { signal: job.controller.signal, log: text => this.log(job, text),
        artifact: file => { if (!job.artifacts.includes(file) && job.artifacts.length < 64) { job.artifacts.push(file); job.dirty = true; } },
        checkpoint: async result => { job.partial_result = this.bounded(result); await this.persist(job); },
        run: (file, args, options) => this.run(job, file, args, options) };
      try {
        await this.initialize();
        for (const id of evicted) await this.store?.remove(id);
        await this.persist(job);
        context.signal.throwIfAborted();
        const result = await task(context);
        context.signal.throwIfAborted();
        job.result = this.bounded(result); job.state = 'succeeded';
      } catch (error) {
        job.state = job.stopReason || 'failed';
        job.error = this.redact(job.stopReason ? `Job ${job.stopReason}. ${uncertain}` : error.message || String(error));
        if (job.error.length > 8192) job.error = 'Native job failed; error exceeded the output bound. ' + uncertain;
      } finally {
        clearTimeout(job.timer); clearInterval(job.flushTimer); job.finished_at = new Date().toISOString();
        const finalState = job.state; job.state = 'running'; job.finalizing = true;
        try { await this.persist(job, finalState); job.state = finalState; }
        catch { job.state = 'interrupted'; delete job.result; job.error = 'Journal write failed; durable outcome unknown. ' + uncertain; }
        reservation.release();
      }
    });
    return this.view(job);
  }
  safe(value) {
    if (value === undefined) return undefined;
    const clean = item => typeof item === 'string' ? this.redact(item) : Array.isArray(item) ? item.map(clean)
      : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, val]) => [this.redact(key), clean(val)])) : item;
    return clean(value);
  }
  bounded(value) {
    return value !== undefined && Buffer.byteLength(JSON.stringify(value)) > 65536 ? { omitted: true, reason: 'Result exceeded 64 KiB; inspect reported artifacts.' } : value;
  }
  publicResult(value) {
    if (Array.isArray(value.jobs)) return { ...value, jobs: value.jobs.map(job => this.publicResult(job)) };
    return { ...value, result: this.safe(value.result), partial_result: this.safe(value.partial_result),
      error: value.error && this.redact(value.error), artifacts: this.safe(value.artifacts), log: value.log && this.redact(value.log) };
  }
  async persist(job, state = job.state) {
    if (!this.store) return;
    // Keep protocol IDs/state intact even when a short local password happens
    // to match their substrings. Only payloads can contain secret material.
    const redactedLogs = this.redact((job.logs || '') + (job.liveOutput || ''));
    const logTooLarge = Buffer.byteLength(JSON.stringify(redactedLogs)) > 65536;
    const record = { ...this.publicResult(this.view(job)), state, logs: logTooLarge ? '' : redactedLogs, truncated: !!job.truncated || logTooLarge };
    await this.store.write(record, new Set(this.jobs.keys()));
  }
  get(id) {
    const job = this.jobs.get(id);
    if (!job && id.split(':')[0] !== this.session) return { job_id: id, state: 'interrupted', error: 'Job belongs to another server session or expired history. Its outcome is unknown; inspect source/destination before retrying.' };
    if (!job) throw new Error('Unknown or expired job ID in this session.');
    return job;
  }
  view(job) {
    const { job_id, operation, state, started_at, finished_at, progress, result, partial_result, error, artifacts, historical } = job;
    return { job_id, operation, state, started_at, finished_at, progress, result, partial_result, error, artifacts: artifacts || [], historical };
  }
  status(id) { return this.view(this.get(id)); }
  list() { return { session_id: this.session, persistence: this.store ? 'private redacted journals; seven-day, 100-record maximum; no automatic replay' : 'memory only', jobs: [...this.jobs.values()].map(job => this.view(job)) }; }
  logs(id) { const job = this.get(id); return { job_id: id, state: job.state, log: this.redact((job.logs || '') + (job.liveOutput || '')), truncated: !!job.truncated }; }
  stop(job, reason) {
    if (terminal.has(job.state) || job.stopReason || job.finalizing) return;
    job.stopReason = reason; job.controller.abort();
  }
  cancel(id) {
    const job = this.get(id);
    if (!terminal.has(job.state)) this.stop(job, 'cancelled');
    return { ...this.view(job), cancellation_requested: job.stopReason === 'cancelled' };
  }
  log(job, text) {
    if (job.truncated) return;
    job.logs += String(text);
    job.dirty = true;
    if (Buffer.byteLength(JSON.stringify(job.logs)) > 65536) { job.logs = ''; job.truncated = true; }
  }
  run(job, file, args, { cwd, env, logOutput = true, progress = null, timeout, allowNonzero = false } = {}) {
    job.controller.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let output = '', outputBytes = 0, tooLarge = false, child, killPromise, processTimer, startError = false;
      try { child = this.spawnProcess(file, args, { cwd, env, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { reject(new Error('Cannot start native job process. Check installation and executable permissions.')); return; }
      const stop = () => {
        if (killPromise) return;
        killPromise = new Promise(done => {
          if (!child.pid) { done(); return; }
          if (process.platform === 'win32') {
            const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
            const timer = setTimeout(() => { child.kill('SIGKILL'); killer.kill(); done(); }, 5000);
            killer.once('error', () => { child.kill('SIGKILL'); clearTimeout(timer); done(); });
            killer.once('close', () => { clearTimeout(timer); done(); });
          } else {
            const kill = signal => { try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') child.kill(signal); } };
            kill('SIGTERM'); setTimeout(() => { kill('SIGKILL'); done(); }, 250);
          }
        });
      };
      const read = chunk => {
        outputBytes += Buffer.byteLength(chunk);
        if (tooLarge) return;
        output += chunk.toString();
        if (outputBytes > 1024 * 1024) { output = ''; tooLarge = true; stop(); return; }
        if (logOutput && !job.truncated) {
          // Keep incomplete lines private until a later chunk completes them.
          job.liveOutput = output.slice(0, output.lastIndexOf('\n') + 1);
          if (Buffer.byteLength(JSON.stringify(job.logs + job.liveOutput)) > 65536) { job.logs = ''; job.liveOutput = ''; job.truncated = true; }
          job.dirty = true;
        }
        if (progress !== 'ovf') return;
        let progressRecord = false;
        for (const line of output.split(/\r?\n/).slice(0, -1)) {
          if (/^[A-Z_]+$/.test(line)) progressRecord = line === 'PROGRESS';
          else if (progressRecord && /^\+[ \t]*\d+(?:\.\d+)?[ \t]*%?$/.test(line)) {
            const value = Number(line.slice(1).replace('%', '').trim());
            if (value >= 0 && value <= 100) { job.progress = value; job.dirty = true; }
          }
        }
      };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', read); child.stderr.on('data', read);
      job.controller.signal.addEventListener('abort', stop, { once: true });
      child.once('error', () => { startError = true; });
      child.once('close', async (code, signal) => {
        clearTimeout(processTimer); job.controller.signal.removeEventListener('abort', stop);
        await killPromise;
        job.liveOutput = '';
        if (logOutput) this.log(job, output);
        if (job.controller.signal.aborted) { reject(new Error('Process interrupted.')); return; }
        if (tooLarge) { reject(new Error('Native process output exceeded 1 MiB; process tree stopped. Partial files may remain.')); return; }
        if (startError) { reject(new Error('Cannot start native job process. Check installation and permissions.')); return; }
        if (signal || code === null) { this.stop(job, 'interrupted'); reject(new Error('Native process was killed; outcome unknown. ' + uncertain)); return; }
        if (code !== 0 && !allowNonzero) { reject(new Error(`Native process exited with code ${code}. ${uncertain}`)); return; }
        resolve({ code, signal, output });
      });
      if (timeout) processTimer = setTimeout(() => this.stop(job, 'timed_out'), timeout);
      if (job.controller.signal.aborted) stop();
    });
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) if (!terminal.has(job.state)) this.stop(job, 'interrupted');
    await Promise.all([...this.jobs.values()].map(job => job.done));
  }
}
