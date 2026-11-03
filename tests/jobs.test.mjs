import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { JobManager } from '../src/jobs.mjs';
import { JobStore } from '../src/job-store.mjs';
import { Resources } from '../src/resources.mjs';
import { Workstation } from '../src/workstation.mjs';
import { localFileProtector } from '../src/local-file-security.mjs';

const worker = path.resolve('tests/fixtures/job-worker.mjs');
const waitFor = async predicate => { for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(25); } throw new Error('Timed out waiting for fixture'); };
const exists = file => fs.stat(file).then(() => true, () => false);
async function fixture(t, options = {}) {
  const { store: storeOptions, ...managerOptions } = options;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-jobs-')));
  const protectFile = localFileProtector(new Workstation(), { root: path.resolve('vmware-workstation') });
  const store = new JobStore({ directory: path.join(root, 'journal'), protectFile, ...storeOptions });
  const jobs = new JobManager({ store, ...managerOptions }); await jobs.initialize();
  t.after(async () => { await jobs.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, jobs, store, protectFile };
}
const native = (jobs, mode, resources = [], args = []) => jobs.start({ operation: mode, resources, artifacts: args, task: async c => {
  const result = await c.run(process.execPath, [worker, mode, ...args], { progress: mode === 'progress' ? 'ovf' : null });
  if (result.code !== 0) throw new Error('Native command failed'); return { verified_exit: result.code };
} });

test('independent native jobs run concurrently; reservations reject sync edits and conflicting jobs until cancellation finishes', async t => {
  const { jobs, root } = await fixture(t);
  const onePath = path.join(root, 'one'), twoPath = path.join(root, 'two');
  const one = native(jobs, 'hold', [onePath], [path.join(root, 'one.partial')]);
  const two = native(jobs, 'hold', [twoPath], [path.join(root, 'two.partial')]);
  await waitFor(() => exists(path.join(root, 'two.partial')));
  assert.equal(jobs.status(one.job_id).state, 'running'); assert.equal(jobs.status(two.job_id).state, 'running');
  assert.throws(() => jobs.start({ operation: 'conflict', resources: [path.join(onePath, 'vm.vmx')], task: async () => {} }), { code: 'RESOURCE_BUSY' });
  await assert.rejects(jobs.resources.use([onePath], async () => {}), { code: 'RESOURCE_BUSY' });
  jobs.cancel(one.job_id); await jobs.get(one.job_id).done;
  assert.equal(jobs.status(one.job_id).state, 'cancelled'); assert.equal(jobs.status(two.job_id).state, 'running');
  assert.deepEqual(jobs.status(one.job_id).artifacts, [path.join(root, 'one.partial')]);
  assert.equal(await fs.readFile(path.join(root, 'one.partial'), 'utf8'), 'partial output');
  await jobs.resources.use([onePath], async () => {});
});

test('native cancellation terminates the process tree on Windows/Linux and retains partial artifacts', async t => {
  const { jobs, root } = await fixture(t); const marker = path.join(root, 'tree');
  const job = native(jobs, 'tree', [marker], [marker]);
  await waitFor(() => exists(marker));
  const pid = Number(await fs.readFile(marker + '.pid', 'utf8'));
  jobs.cancel(job.job_id); await jobs.get(job.job_id).done;
  assert.equal(jobs.status(job.job_id).state, 'cancelled');
  await waitFor(async () => { try { process.kill(pid, 0); if (process.platform === 'linux') return /\) Z /.test(await fs.readFile(`/proc/${pid}/stat`, 'utf8')); return false; } catch { return true; } });
});

test('startup failure, timeout, killed process, output limit and shutdown never claim success', async t => {
  const { jobs, root } = await fixture(t);
  const missing = jobs.start({ operation: 'missing', task: c => c.run(path.join(root, 'missing-binary'), []) });
  await jobs.get(missing.job_id).done; assert.equal(jobs.status(missing.job_id).state, 'failed'); assert.match(jobs.status(missing.job_id).error, /Cannot start native/);
  const timed = jobs.start({ operation: 'timeout', timeout: 250, task: c => c.run(process.execPath, [worker, 'hold']) });
  await jobs.get(timed.job_id).done; assert.equal(jobs.status(timed.job_id).state, 'timed_out');
  const flooded = native(jobs, 'flood'); await jobs.get(flooded.job_id).done;
  assert.equal(jobs.status(flooded.job_id).state, 'failed'); assert.match(jobs.status(flooded.job_id).error, /1 MiB/);
  const killed = jobs.start({ operation: 'killed', task: c => c.run(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"]) });
  await jobs.get(killed.job_id).done; assert.notEqual(jobs.status(killed.job_id).state, 'succeeded');
  const stopped = native(jobs, 'hold'); await jobs.close(); assert.equal(jobs.status(stopped.job_id).state, 'interrupted');
  assert.throws(() => native(jobs, 'hold'), /shutting down/);
});

test('genuine backend progress is retained, while unsupported percentage stays unknown', async t => {
  const { jobs } = await fixture(t);
  const progress = native(jobs, 'progress'); await jobs.get(progress.job_id).done;
  assert.equal(jobs.status(progress.job_id).progress, 47, 'Never synthesize 100% from process exit');
  const unknown = jobs.start({ operation: 'unknown', task: async () => ({ ok: true }) });
  await jobs.get(unknown.job_id).done; assert.equal(jobs.status(unknown.job_id).progress, null);
});

test('private journals retain redacted terminal results and unfinished restart outcomes without replay', async t => {
  const secret = 'fixture-secret'; const { jobs, store, protectFile, root } = await fixture(t, { redact: text => text.split(secret).join('[REDACTED]') });
  const done = jobs.start({ operation: 'result', task: async c => { c.log('fixture-'); c.log('secret\n'); return { value: secret, output: 'verified' }; } });
  await jobs.get(done.job_id).done;
  const active = native(jobs, 'hold', [], [path.join(root, 'partial')]);
  await waitFor(() => exists(path.join(root, 'partial')));
  const restored = new JobManager({ store: new JobStore({ directory: store.directory, protectFile }) }); await restored.initialize(); t.after(() => restored.close());
  assert.equal(restored.status(done.job_id).state, 'succeeded'); assert.equal(restored.status(done.job_id).result.value, '[REDACTED]');
  assert.equal(restored.status(active.job_id).state, 'interrupted'); assert.match(restored.status(active.job_id).error, /unknown/);
  assert.equal(restored.cancel(active.job_id).cancellation_requested, false);
  for (const name of await fs.readdir(store.directory)) {
    const file = path.join(store.directory, name), text = await fs.readFile(file, 'utf8'); assert.ok(!text.includes(secret));
    assert.ok((await fs.stat(file)).size <= store.maxBytes);
    if (process.platform === 'linux') assert.equal((await fs.stat(file)).mode & 0o077, 0);
  }
});

test('history count, retention, oversized logs/results and corrupt journals fail within bounds', async t => {
  const { jobs, store, protectFile } = await fixture(t, { maxActive: 1, maxRecords: 2 });
  for (let i = 0; i < 3; i++) {
    const job = jobs.start({ operation: 'bounded', task: async c => { c.log('x'.repeat(70000)); return { large: 'y'.repeat(70000) }; } });
    await jobs.get(job.job_id).done;
    assert.equal(jobs.logs(job.job_id).truncated, true); assert.equal(jobs.status(job.job_id).result.omitted, true);
  }
  assert.equal(jobs.list().jobs.length, 2); assert.equal((await fs.readdir(store.directory)).length, 2);
  const expired = new JobManager({ store: new JobStore({ directory: store.directory, protectFile, retentionMs: -1 }) }); await expired.initialize();
  assert.equal(expired.list().jobs.length, 0);
  const job = jobs.start({ operation: 'bad', task: async () => ({ ok: true }) }); await jobs.get(job.job_id).done;
  const file = path.join(store.directory, job.job_id.replace(':', '_') + '.json'); await fs.writeFile(file, '{broken');
  const corrupt = new JobManager({ store: new JobStore({ directory: store.directory, protectFile }) });
  await assert.rejects(corrupt.initialize(), /invalid/);
});

test('per-VM vmrun queues allow unrelated VMs concurrently and retain shared mutation locks', async () => {
  const resources = new Resources(); let active = 0, peak = 0;
  const backend = new Workstation({ run: async () => { active++; peak = Math.max(peak, active); await delay(100); active--; return { stdout: '' }; } });
  backend.resources = resources; backend.executable = async () => '/mock/vmrun';
  await Promise.all([backend.run(['stop', path.resolve('one.vmx')], { mutation: true }), backend.run(['stop', path.resolve('two.vmx')], { mutation: true })]);
  assert.equal(peak, 2);
  const hold = resources.reserve([path.resolve('one.vmx')]);
  await assert.rejects(backend.run(['stop', path.resolve('one.vmx')], { mutation: true }), { code: 'RESOURCE_BUSY' }); hold.release();
});

test('journal admission failure prevents mutations and releases shared resources', async t => {
  const { jobs, store, root } = await fixture(t); let executed = false;
  store.write = async () => { throw new Error('fixture disk full'); };
  const job = jobs.start({ operation: 'write-failure', resources: [root], task: async () => { executed = true; } });
  await jobs.get(job.job_id).done;
  assert.equal(executed, false); assert.equal(jobs.status(job.job_id).state, 'interrupted');
  await jobs.resources.use([root], async () => {});
});

test('redaction preserves journal protocol IDs even for secrets overlapping their syntax', async t => {
  const { jobs, store, protectFile } = await fixture(t, { redact: text => text.split('-').join('[REDACTED]') });
  const job = jobs.start({ operation: 'test', task: async () => ({ secret: '-' }) }); await jobs.get(job.job_id).done;
  assert.equal(jobs.publicResult(jobs.status(job.job_id)).job_id, job.job_id);
  assert.equal(jobs.publicResult(jobs.status(job.job_id)).result.secret, '[REDACTED]');
  const restored = new JobManager({ store: new JobStore({ directory: store.directory, protectFile }) }); await restored.initialize();
  assert.equal(restored.status(job.job_id).state, 'succeeded'); assert.equal(restored.status(job.job_id).result.secret, '[REDACTED]');
});

test('journal record and interrupted temporary-file quotas prevent unbounded artifact growth', async t => {
  const { jobs, store } = await fixture(t, { store: { maxRecords: 1 } }); let executions = 0;
  const first = jobs.start({ operation: 'first', task: async () => { executions++; } }); await jobs.get(first.job_id).done;
  const second = jobs.start({ operation: 'second', task: async () => { executions++; } }); await jobs.get(second.job_id).done;
  assert.equal(executions, 1); assert.equal(jobs.status(second.job_id).state, 'interrupted');
  await store.remove(first.job_id);
  for (let i = 0; i < 4; i++) await fs.writeFile(path.join(store.directory, `.${'0'.repeat(35)}${i}.tmp`), '');
  const third = jobs.start({ operation: 'third', task: async () => { executions++; } }); await jobs.get(third.job_id).done;
  assert.equal(executions, 1); assert.equal(jobs.status(third.job_id).state, 'interrupted');
});
