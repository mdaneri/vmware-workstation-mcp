import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import path from 'node:path';

const jobID = z.string().min(1).max(100);
export const jobSchemas = {
  job_status: z.object({ job_id: jobID }).strict(),
  job_list: z.object({}).strict(),
  job_cancel: z.object({ job_id: jobID }).strict(),
  job_logs: z.object({ job_id: jobID }).strict(),
};
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);

// Session-scoped jobs: no sensitive output or credentials are written to disk.
export class JobManager {
  constructor({ redact = text => text, spawnProcess = spawn, maxActive = 4, maxRecords = 100 } = {}) {
    this.session = randomUUID(); this.jobs = new Map(); this.redact = redact;
    this.spawnProcess = spawnProcess; this.maxActive = maxActive; this.maxRecords = maxRecords; this.closed = false;
  }
  start({ operation, resources = [], timeout = 3600000, task }) {
    if (this.closed) throw new Error('Job manager is shutting down.');
    const active = [...this.jobs.values()].filter(job => !terminal.has(job.state));
    if (active.length >= this.maxActive) throw new Error('Background job limit reached. Wait for a job to finish.');
    const prefix = value => value.endsWith(path.sep) ? value : value + path.sep;
    const overlaps = (a, b) => a === b || a.startsWith(prefix(b)) || b.startsWith(prefix(a));
    if (active.some(job => job.resources.some(value => resources.some(resource => overlaps(value, resource))))) throw new Error('A background job already uses this source or destination. Wait for it to finish.');
    while (this.jobs.size >= this.maxRecords) {
      const oldest = [...this.jobs.values()].find(job => terminal.has(job.state));
      if (!oldest) throw new Error('Job history is full.');
      this.jobs.delete(oldest.job_id);
    }
    const job = { job_id: `${this.session}:${randomUUID()}`, operation, resources, state: 'running', started_at: new Date().toISOString(), progress: null, logs: '', controller: new AbortController() };
    this.jobs.set(job.job_id, job);
    job.timer = setTimeout(() => { job.stopReason = 'timed_out'; job.controller.abort(); }, timeout);
    job.done = Promise.resolve().then(async () => {
      const context = { signal: job.controller.signal, log: text => this.log(job, text), run: (file, args, options) => this.run(job, file, args, options) };
      try {
        context.signal.throwIfAborted();
        const result = await task(context);
        context.signal.throwIfAborted();
        job.result = result; job.state = 'succeeded';
      } catch (error) {
        job.state = job.stopReason || 'failed';
        job.error = this.redact(job.stopReason ? `Job ${job.stopReason}; partial output or registration/power changes may remain. Inspect the destination before retrying.` : error.message);
      } finally { clearTimeout(job.timer); job.finished_at = new Date().toISOString(); }
    });
    return this.view(job);
  }
  get(id) {
    const job = this.jobs.get(id);
    if (!job && id.split(':')[0] !== this.session) return { job_id: id, state: 'interrupted', error: 'Job belongs to another server session. Its outcome is unknown; inspect source/destination before retrying. Logs and results are not persisted.' };
    if (!job) throw new Error('Unknown or expired job ID in this session.');
    return job;
  }
  view(job) {
    const { job_id, operation, state, started_at, finished_at, progress, result, error } = job;
    return { job_id, operation, state, started_at, finished_at, progress, result, error };
  }
  status(id) { return this.view(this.get(id)); }
  list() { return { session_id: this.session, persistence: 'memory only; previous-session IDs report interrupted with unknown outcome', jobs: [...this.jobs.values()].map(job => this.view(job)) }; }
  logs(id) { const job = this.get(id); return { job_id: id, state: job.state, log: this.redact(job.logs || ''), truncated: !!job.truncated }; }
  cancel(id) {
    const job = this.get(id);
    if (!terminal.has(job.state)) { job.stopReason = 'cancelled'; job.controller.abort(); }
    return { ...this.view(job), cancellation_requested: job.stopReason === 'cancelled' };
  }
  log(job, text) {
    job.logs += text;
    // Drop the entire buffer at the limit, avoiding secret suffixes at a cut boundary.
    if (job.logs.length > 65536) { job.logs = ''; job.truncated = true; }
  }
  run(job, file, args, { cwd, env, logOutput = true } = {}) {
    job.controller.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let output = ''; let outputBytes = 0; let tooLarge = false; let killTimer; let child;
      try { child = this.spawnProcess(file, args, { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { reject(new Error('Cannot start OVF Tool. Check its installation and executable permissions.')); return; }
      const stop = () => { child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000); };
      const read = chunk => {
        outputBytes += Buffer.byteLength(chunk);
        if (tooLarge) return;
        output += chunk.toString();
        if (outputBytes > 1024 * 1024) { output = ''; tooLarge = true; stop(); return; }
        // One PROGRESS header can have many '+ <percent>' payload lines.
        let progressRecord = false;
        for (const line of output.split(/\r?\n/).slice(0, -1)) {
          if (/^[A-Z_]+$/.test(line)) progressRecord = line === 'PROGRESS';
          else if (progressRecord && /^\+[ \t]*\d+(?:\.\d+)?[ \t]*%?$/.test(line)) {
            const value = Number(line.slice(1).replace('%', '').trim());
            if (value >= 0 && value <= 100) job.progress = value;
          }
        }
      };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', read); child.stderr.on('data', read);
      job.controller.signal.addEventListener('abort', stop, { once: true });
      let startError = false;
      child.once('error', () => { startError = true; });
      child.once('close', (code, signal) => {
        clearTimeout(killTimer); job.controller.signal.removeEventListener('abort', stop);
        if (logOutput) this.log(job, this.redact(output));
        if (job.controller.signal.aborted) { reject(new Error('Process interrupted.')); return; }
        if (tooLarge) { reject(new Error('OVF Tool output exceeded 1 MiB; process stopped. Partial files may remain.')); return; }
        if (startError) { reject(new Error('Cannot start OVF Tool. Check installation and permissions.')); return; }
        // Machine records must remain intact for internal parsing (even if a secret is
        // "SUCCESS" or a size/path substring). Logs, errors and MCP responses redact at their output boundaries.
        resolve({ code, signal, output });
      });
      if (job.controller.signal.aborted) stop();
    });
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) if (!terminal.has(job.state)) { job.stopReason = 'interrupted'; job.controller.abort(); }
    await Promise.all([...this.jobs.values()].map(job => job.done));
  }
}
