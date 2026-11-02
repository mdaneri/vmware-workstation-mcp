import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';
import { Workstation } from '../src/workstation.mjs';
import { Credentials } from '../src/credentials.mjs';
import { JobManager } from '../src/jobs.mjs';
import { OvfManager, ovfSchemas } from '../src/ovf.mjs';
import { inspectArtifact, machineRecords } from '../src/ovf-artifacts.mjs';

const descriptor = (href = '') => `<Envelope xmlns="http://schemas.dmtf.org/ovf/envelope/1" xmlns:ovf="http://schemas.dmtf.org/ovf/envelope/1"><References>${href ? `<File ovf:href="${href}"/>` : ''}</References></Envelope>`;
const flags = ['machineOutput', 'schemaValidate', 'sourceType', 'targetType', 'hideEula', 'name', 'net', 'prop', 'deploymentOption', 'acceptAllEulas', 'configFile'];
async function fixture(t, extraEnv = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-ovf-test-')));
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const binary = path.join(root, `ovftool${suffix}`); const vmrun = path.join(root, `vmrun${suffix}`);
  await fs.writeFile(binary, '', { mode: 0o755 }); await fs.writeFile(vmrun, '', { mode: 0o755 });
  const calls = path.join(root, 'calls.jsonl'); const input = path.join(root, 'input'); await fs.mkdir(input);
  const source = path.join(input, 'source.ovf'); await fs.writeFile(source, descriptor());
  const vmx = path.join(input, 'source.vmx'); await fs.writeFile(vmx, '.encoding = "UTF-8"\nmemsize = "256"\n');
  let running = false; let snapshots = [];
  const env = { ...process.env, VMRUN_PATH: vmrun, VMWARE_OVFTOOL_PATH: binary, VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root, VMWARE_CREDENTIALS_FILE: path.join(root, 'credentials.json'), OVF_TEST_CALLS: calls, ...extraEnv };
  await fs.writeFile(env.VMWARE_CREDENTIALS_FILE, '{}', { mode: 0o600 });
  const backend = new Workstation({ env, run: async (file, args, options) => {
    assert.equal(options.shell, false);
    if (file === binary) return { stdout: args.includes('--version') ? 'VMware ovftool test-version' : args.includes('debug') ? '--X:noPrompting' : flags.map(flag => `--${flag}`).join('\n') };
    if (args.includes('listSnapshots')) return { stdout: `Total snapshots: ${snapshots.length}\n${snapshots.join('\n')}` };
    return { stdout: `Total running VMs: ${running ? '1\n' + vmx : '0'}` };
  } });
  const credentials = new Credentials(env);
  const jobs = new JobManager({ redact: text => credentials.redact(text), spawnProcess: (file, args, options) => {
    assert.equal(file, binary); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.equal(options.stdio[0], 'ignore');
    assert.notEqual(options.cwd, input);
    return spawn(process.execPath, [path.resolve('tests/fixtures/ovf-worker.mjs'), ...args], options);
  } });
  const restCalls = []; const rest = { request: async (...args) => { restCalls.push(args); return { status: 201 }; } };
  const ovf = new OvfManager({ backend, credentials, jobs, rest });
  t.after(async () => { await jobs.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, source, input, vmx, binary, backend, credentials, jobs, ovf, restCalls, setRunning: value => { running = value; }, setSnapshots: value => { snapshots = value; }, calls: async () => (await fs.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}
async function finish(f, job) { await f.jobs.get(job.job_id).done; return f.jobs.status(job.job_id); }
async function archive(filename, entries) {
  const pack = tar.pack(); const chunks = [];
  const collect = pipeline(pack, new Writable({ write(chunk, encoding, callback) { chunks.push(chunk); callback(); } }));
  for (const entry of entries) pack.entry({ name: entry.name, type: entry.type || 'file', linkname: entry.linkname }, entry.text || '');
  pack.finalize(); await collect; await fs.writeFile(filename, Buffer.concat(chunks));
}

test('OVF Tool honors configurable executable path, reports version/flags, and degrades gracefully', async t => {
  const f = await fixture(t); const status = await f.ovf.status();
  assert.equal(status.available, true); assert.equal(status.executable, f.binary); assert.match(status.version, /test-version/); assert.equal(status.supported_flags.noPrompting, true);
  f.backend.env.VMWARE_OVFTOOL_PATH = 'relative/ovftool';
  assert.equal((await f.ovf.status()).available, false);
  await assert.rejects(f.ovf.start('ovf_inspect', { source: f.source }), /absolute path/);
  f.backend.env.VMWARE_OVFTOOL_PATH = path.join(f.root, `missing/ovftool${process.platform === 'win32' ? '.exe' : ''}`);
  assert.equal((await f.ovf.status()).available, false);
});

test('read-only background inspection reports hardware, networks, properties and deployment options without property defaults in logs', async t => {
  const f = await fixture(t); const job = await f.ovf.start('ovf_inspect', { source: f.source });
  assert.equal(job.state, 'running');
  const done = await finish(f, job); assert.equal(done.state, 'succeeded', done.error);
  assert.equal(done.result.metadata.vms.vm.virtualHardwares.virtualHardware.numberOfCpus, '1');
  assert.equal(done.result.metadata.networks.network.name, 'Lab');
  assert.equal(done.result.metadata.properties.property.value, '[REDACTED]');
  assert.equal(done.result.metadata.deploymentOptions.deploymentOption.id, 'small');
  assert.doesNotMatch(f.jobs.logs(job.job_id).log, /never-return-default/);
  const args = (await f.calls())[0]; assert.ok(args.includes('--machineOutput')); assert.ok(args.includes('--X:noPrompting')); assert.ok(!args.includes('--acceptAllEulas'));
});

test('validation delegates schema validation and validates local manifest checksums', async t => {
  const f = await fixture(t); const original = descriptor('disk.vmdk'); const disk = 'disk-content';
  await fs.writeFile(f.source, original); await fs.writeFile(path.join(f.input, 'disk.vmdk'), disk);
  const manifest = `SHA256(source.ovf)= ${createHash('sha256').update(original).digest('hex')}\nSHA256(disk.vmdk)= ${createHash('sha256').update(disk).digest('hex')}\n`;
  await fs.writeFile(path.join(f.input, 'source.mf'), manifest);
  let done = await finish(f, await f.ovf.start('ovf_validate', { source: f.source }));
  assert.equal(done.state, 'succeeded', done.error); assert.equal(done.result.valid, true); assert.match(done.result.manifest, /checksums verified/);
  assert.ok((await f.calls())[0].includes('--schemaValidate'));
  await fs.writeFile(path.join(f.input, 'disk.vmdk'), 'tampered');
  done = await finish(f, await f.ovf.start('ovf_validate', { source: f.source })); assert.equal(done.state, 'failed'); assert.match(done.error, /checksum mismatch/);
  assert.equal((await f.calls()).length, 1, 'invalid checksum must fail before launching OVF Tool');
});

test('local preflight rejects URLs, traversal, external entities and missing references', async t => {
  const f = await fixture(t);
  await assert.rejects(f.ovf.start('ovf_inspect', { source: 'https://example.invalid/a.ova' }), /absolute/);
  for (const href of ['../outside.vmdk', 'file:///outside.vmdk', 'https://example.invalid/disk', '%2e%2e%2fsecret', 'disk:stream', 'CON']) {
    await fs.writeFile(f.source, descriptor(href));
    await assert.rejects(inspectArtifact(f.backend, f.source), /flat local/);
  }
  await fs.writeFile(f.source, '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///secret">]>' + descriptor());
  await assert.rejects(inspectArtifact(f.backend, f.source), /DTD/);
  await fs.writeFile(f.source, descriptor('missing.vmdk'));
  await assert.rejects(inspectArtifact(f.backend, f.source), /existing file/);
});

test('OVA preflight accepts a flat package and rejects tar traversal, links and duplicate descriptors', async t => {
  const f = await fixture(t); const ova = path.join(f.input, 'source.ova');
  await archive(ova, [{ name: 'source.ovf', text: descriptor() }]);
  assert.equal((await inspectArtifact(f.backend, ova)).descriptorName, 'source.ovf');
  for (const entries of [
    [{ name: '../source.ovf', text: descriptor() }],
    [{ name: 'source.ovf', type: 'symlink', linkname: '/secret' }],
    [{ name: 'source.ovf', text: descriptor() }, { name: 'other.ovf', text: descriptor() }],
    [{ name: 'source.ovf', text: descriptor('missing.vmdk') }],
  ]) { await archive(ova, entries); await assert.rejects(inspectArtifact(f.backend, ova), /flat local|regular files|exactly one|missing file/); }
});

test('allowed roots apply to artifacts, VM targets and output paths, including canonical link escape', async t => {
  const f = await fixture(t); const allowed = path.join(f.root, 'allowed'); await fs.mkdir(allowed);
  f.backend.env.VMWARE_ALLOWED_HOST_ROOTS = allowed;
  await assert.rejects(f.ovf.start('ovf_inspect', { source: f.source }), /outside/);
  f.backend.env.VMWARE_ALLOWED_HOST_ROOTS = f.root;
  f.backend.env.VMWARE_ALLOWED_ROOTS = f.input;
  await assert.rejects(f.ovf.start('ovf_import', { source: f.source, directory: path.join(f.root, 'outside-vm') }), /outside/);
  f.backend.env.VMWARE_ALLOWED_ROOTS = f.root;
  f.backend.env.VMWARE_ALLOWED_HOST_ROOTS = f.input;
  await assert.rejects(f.ovf.start('ovf_export', { vmx: f.vmx, destination: path.join(f.root, 'outside.ova') }), /outside/);
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(f.root, 'credentials.json'), path.join(f.input, 'external.vmdk'));
    await fs.writeFile(f.source, descriptor('external.vmdk'));
    await assert.rejects(inspectArtifact(f.backend, f.source), /outside|escapes/);
  }
});

test('import uses typed option arguments, reported nested VMX path, and explicit registration/power flags', async t => {
  const f = await fixture(t); const directory = path.join(f.root, 'imported');
  const done = await finish(f, await f.ovf.start('ovf_import', { source: f.source, directory, name: 'Fixture VM', network_mappings: { Lab: 'VMnet8' }, property_mappings: { hostname: 'fixture' }, deployment_option: 'small', accept_eulas: true, register: true }));
  assert.equal(done.state, 'succeeded', done.error); assert.equal(done.result.registered, true); assert.equal(done.result.powered_on, false);
  assert.equal(done.result.destination, path.join(directory, 'nested', 'machine.vmx'));
  const args = (await f.calls())[1];
  for (const option of ['--targetType=VMX', '--name=Fixture VM', '--net:Lab=VMnet8', '--prop:hostname=fixture', '--deploymentOption=small', '--acceptAllEulas']) assert.ok(args.includes(option));
  assert.ok(!args.some(arg => /--(?:overwrite|lax|allowExtraConfig|skipManifestCheck)/.test(arg)));
  assert.equal(f.restCalls[0][1], '/api/vms/registration');
});

test('export and conversion preserve no-overwrite defaults; explicit overwrite applies only to OVA', async t => {
  const f = await fixture(t); const destination = path.join(f.root, 'appliance.ova');
  await fs.writeFile(destination, 'existing');
  await assert.rejects(f.ovf.start('ovf_export', { vmx: f.vmx, destination }), /exists/);
  const done = await finish(f, await f.ovf.start('ovf_export', { vmx: f.vmx, destination, overwrite: true }));
  assert.equal(done.state, 'succeeded', done.error); assert.equal(await fs.readFile(destination, 'utf8'), 'fixture appliance'); assert.equal(done.progress, 100);
  const target = path.join(f.root, 'new-ovf', 'converted.ovf');
  await assert.rejects(f.ovf.start('ovf_convert', { source: f.source, destination: target, overwrite: true }), /only.*OVA/);
  const converted = await finish(f, await f.ovf.start('ovf_convert', { source: f.source, destination: target })); assert.equal(converted.state, 'succeeded', converted.error);
  await assert.rejects(f.ovf.start('ovf_convert', { source: f.source, destination: target }), /exists|NEW/);
});

test('VMX sources reject running, locked, suspended, encrypted, vTPM, snapshot and linked-disk configurations', async t => {
  const f = await fixture(t);
  f.setRunning(true); await assert.rejects(f.ovf.vmSource(f.vmx), /Power off/); f.setRunning(false);
  f.setSnapshots(['saved']); await assert.rejects(f.ovf.vmSource(f.vmx), /Snapshot/); f.setSnapshots([]);
  await fs.mkdir(`${f.vmx}.lck`); await assert.rejects(f.ovf.vmSource(f.vmx), /Locked/); await fs.rmdir(`${f.vmx}.lck`);
  for (const config of ['checkpoint.vmState = "state.vmss"', 'encryption.keySafe = "protected"', 'vtpm.present = "TRUE"']) {
    await fs.writeFile(f.vmx, config); await assert.rejects(f.ovf.vmSource(f.vmx), /suspended|Encrypted/);
  }
  await fs.writeFile(f.vmx, 'scsi0:0.present = "TRUE"\nscsi0:0.fileName = "disk.vmdk"');
  await fs.writeFile(path.join(f.input, 'disk.vmdk'), 'parentCID=12345678\ncreateType="monolithicSparse"\n');
  await assert.rejects(f.ovf.vmSource(f.vmx), /Snapshot/);
  await fs.writeFile(path.join(f.input, 'disk.vmdk'), 'parentCID=ffffffff\ncreateType="fullDevice"\n');
  await assert.rejects(f.ovf.vmSource(f.vmx), /raw/);
});

test('VMX exports skip stale backings on disabled devices regardless of presence-value case', async t => {
  const f = await fixture(t);
  for (const [index, presence] of ['FALSE', 'false', 'FaLsE'].entries()) {
    await fs.writeFile(f.vmx, `SATA0:0.PRESENT = "${presence}"\nSATA0:0.fileName = "removed.iso"\n`);
    const done = await finish(f, await f.ovf.start('ovf_export', { vmx: f.vmx, destination: path.join(f.root, `export-${index}.ova`) }));
    assert.equal(done.state, 'succeeded', done.error);
  }
  for (const presence of ['TRUE', 'true', 'TrUe', undefined]) {
    await fs.writeFile(f.vmx, `${presence ? `sata0:0.present = "${presence}"\n` : ''}sata0:0.fileName = "removed.iso"\n`);
    await assert.rejects(f.ovf.vmSource(f.vmx), /existing file/);
  }
});

test('destination space checks fail before creating output and failed transfers retain partial output safely', async t => {
  const f = await fixture(t); const destination = path.join(f.root, 'new', 'output.ovf');
  f.ovf.space = async () => ({ bavail: 0, bsize: 4096 });
  let done = await finish(f, await f.ovf.start('ovf_convert', { source: f.source, destination }));
  assert.equal(done.state, 'failed'); assert.match(done.error, /free space/); await assert.rejects(fs.stat(path.dirname(destination)), { code: 'ENOENT' });
  f.ovf.space = fs.statfs; f.backend.env.OVF_TEST_FAIL = '1';
  done = await finish(f, await f.ovf.start('ovf_inspect', { source: f.source }));
  assert.equal(done.state, 'failed'); assert.match(done.error, /test conversion failure/);
  f.backend.env.OVF_TEST_FAIL = ''; f.backend.env.OVF_TEST_NO_RESULT = '1';
  done = await finish(f, await f.ovf.start('ovf_inspect', { source: f.source })); assert.equal(done.state, 'failed');
});

test('OVA exclusive publication budgets both staged and destination copies before conversion', async t => {
  for (const operation of ['ovf_export', 'ovf_convert']) await t.test(operation, async t => {
    const f = await fixture(t, { OVF_TEST_FLAT_BYTES: String(1024 ** 3) });
    const source = operation === 'ovf_export' ? { vmx: f.vmx } : { source: f.source };
    const destination = path.join(f.root, 'appliance.ova');
    // Enough space for one estimated 1 GiB archive plus margin, but not two.
    f.ovf.space = async () => ({ bavail: 1.5 * 1024 ** 3, bsize: 1 });
    let done = await finish(f, await f.ovf.start(operation, { ...source, destination }));
    assert.equal(done.state, 'failed'); assert.match(done.error, /free space/);
    assert.equal((await f.calls()).length, 1, 'only the probe may run before the space rejection');
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
    assert.ok(!(await fs.readdir(f.root)).some(name => name.startsWith('.ovf-job-')));

    // Replacement renames the staged file, so it still requires just one new copy.
    await fs.writeFile(destination, 'existing archive');
    done = await finish(f, await f.ovf.start(operation, { ...source, destination, overwrite: true }));
    assert.equal(done.state, 'succeeded', done.error);

    // With space for both copies, exclusive publication succeeds normally.
    f.ovf.space = async () => ({ bavail: 3 * 1024 ** 3, bsize: 1 });
    const fresh = path.join(f.root, 'fresh.ova');
    done = await finish(f, await f.ovf.start(operation, { ...source, destination: fresh }));
    assert.equal(done.state, 'succeeded', done.error);
    assert.equal(await fs.readFile(fresh, 'utf8'), 'fixture appliance');
  });
});

test('OVF and VMX targets keep a single-copy destination-space budget', async t => {
  const f = await fixture(t, { OVF_TEST_FLAT_BYTES: String(1024 ** 3) });
  f.ovf.space = async () => ({ bavail: 1.5 * 1024 ** 3, bsize: 1 });
  for (const extension of ['ovf', 'vmx']) {
    const destination = path.join(f.root, `output-${extension}`, `appliance.${extension}`);
    const done = await finish(f, await f.ovf.start('ovf_convert', { source: f.source, destination }));
    assert.equal(done.state, 'succeeded', done.error);
  }
});

test('sensitive property profiles are resolved locally and redacted from job logs and results', async t => {
  const f = await fixture(t); const secret = 'sensitive-profile-value';
  await fs.writeFile(f.credentials.filename, JSON.stringify({ ovf_properties: { lab: { password: secret } } }));
  const job = await f.ovf.start('ovf_import', { source: f.source, directory: path.join(f.root, 'imported'), property_profile: 'lab' });
  const done = await finish(f, job); assert.equal(done.state, 'succeeded', done.error);
  assert.doesNotMatch(f.jobs.logs(job.job_id).log, new RegExp(secret)); assert.match(f.jobs.logs(job.job_id).log, /REDACTED/);
  assert.ok((await f.calls())[1].includes(`--prop:password=${secret}`));
});

test('profile secrets overlapping native protocol, size metadata and target paths do not corrupt imports', async t => {
  for (const secret of ['SUCCESS', '1024', 'nested']) await t.test(secret, async t => {
    const f = await fixture(t);
    await fs.writeFile(f.credentials.filename, JSON.stringify({ ovf_properties: { lab: { password: secret } } }));
    const directory = path.join(f.root, 'imported');
    const job = await f.ovf.start('ovf_import', { source: f.source, directory, property_profile: 'lab' });
    const done = await finish(f, job);
    assert.equal(done.state, 'succeeded', done.error);
    assert.equal(done.result.destination, path.join(directory, 'nested', 'machine.vmx'));
    assert.equal((await fs.stat(done.result.destination)).isFile(), true);
    assert.equal(f.jobs.logs(job.job_id).log.includes(secret), false);
    assert.match(f.jobs.logs(job.job_id).log, /REDACTED/);
    // A later probe reuses the remembered secret but must still parse numeric metadata intact.
    const probe = await finish(f, await f.ovf.start('ovf_inspect', { source: f.source }));
    assert.equal(probe.state, 'succeeded', probe.error);
    assert.equal(probe.result.metadata.sizes.flat, '1024');
  });
});

test('errors remain redacted after raw native protocol parsing', async t => {
  const f = await fixture(t); const secret = 'SUCCESS';
  await fs.writeFile(f.credentials.filename, JSON.stringify({ ovf_properties: { lab: { password: secret } } }));
  f.ovf.rest.request = async () => { throw new Error(`Registration rejected ${secret}`); };
  const job = await f.ovf.start('ovf_import', { source: f.source, directory: path.join(f.root, 'imported'), property_profile: 'lab', register: true });
  const done = await finish(f, job);
  assert.equal(done.state, 'failed');
  assert.match(done.error, /post-import action failed/);
  assert.match(done.error, /Registration rejected \[REDACTED\]/);
  assert.equal(done.error.includes(secret), false);
  assert.equal(f.jobs.logs(job.job_id).log.includes(secret), false);
});

test('jobs enforce source conflicts, cancellation, native child timeout, shutdown and prior-session interruption', async t => {
  const f = await fixture(t, { OVF_TEST_DELAY: '3000' });
  const job = await f.ovf.start('ovf_inspect', { source: f.source });
  await assert.rejects(f.ovf.start('ovf_inspect', { source: f.source }), /already uses/);
  await delay(100); f.jobs.cancel(job.job_id);
  assert.equal((await finish(f, job)).state, 'cancelled');
  const timeoutJob = await f.ovf.start('ovf_inspect', { source: f.source, timeout_seconds: 1 });
  assert.equal((await finish(f, timeoutJob)).state, 'timed_out');
  const shutdownJob = await f.ovf.start('ovf_inspect', { source: f.source }); await f.jobs.close();
  assert.equal(f.jobs.status(shutdownJob.job_id).state, 'interrupted');
  const newJobs = new JobManager(); assert.equal(newJobs.status(job.job_id).state, 'interrupted'); assert.match(newJobs.status(job.job_id).error, /unknown/);
});

test('schemas reject arbitrary executable flags, unsafe names and option-key injection', () => {
  assert.throws(() => ovfSchemas.ovf_import.parse({ source: '/source.ovf', directory: '/out', name: '../escape' }));
  assert.throws(() => ovfSchemas.ovf_convert.parse({ source: '/source.ovf', destination: '/out.ova', options: ['--allowAllExtraConfig'] }));
  assert.throws(() => ovfSchemas.ovf_import.parse({ source: '/source.ovf', directory: '/out', property_mappings: { 'p@': '/host/file' } }));
  assert.deepEqual(machineRecords('PROGRESS\r\n+ 35\r\nRESULT\r\n+ SUCCESS\r\n'), [{ type: 'PROGRESS', payload: '35' }, { type: 'RESULT', payload: 'SUCCESS' }]);
});

test('failed OVA overwrite retains the original and reports retained partial staging', async t => {
  const f = await fixture(t, { OVF_TEST_FAIL_TRANSFER: '1' }); const destination = path.join(f.root, 'original.ova');
  await fs.writeFile(destination, 'original bytes');
  const job = await f.ovf.start('ovf_export', { vmx: f.vmx, destination, overwrite: true });
  const done = await finish(f, job);
  assert.equal(done.state, 'failed'); assert.match(done.error, /Partial files may remain/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'original bytes');
  assert.match(f.jobs.logs(job.job_id).log, /Uncommitted output retained/);
  const staging = (await fs.readdir(f.root)).find(name => name.startsWith('.ovf-job-')); assert.ok(staging);
  assert.equal(await fs.readFile(path.join(f.root, staging, 'original.ova'), 'utf8'), 'partial');
});

test('explicit power-on is headless and registration failure reports the successful transfer path', async t => {
  const f = await fixture(t); const power = [];
  f.backend.power = async (...args) => { power.push(args); return { commandSucceeded: true }; };
  let done = await finish(f, await f.ovf.start('ovf_import', { source: f.source, directory: path.join(f.root, 'booted'), power_on: true }));
  assert.equal(done.state, 'succeeded', done.error); assert.equal(done.result.powered_on, true); assert.deepEqual(power[0].slice(1), ['start', 'soft', false]);
  f.ovf.rest.request = async () => { throw new Error('REST unavailable'); };
  done = await finish(f, await f.ovf.start('ovf_import', { source: f.source, directory: path.join(f.root, 'registration-failure'), register: true }));
  assert.equal(done.state, 'failed'); assert.match(done.error, /Transfer succeeded at .*machine.vmx; post-import action failed/);
  assert.match(done.error, /No rollback/);
});

test('appliance preflight rejects disk descriptors that could read raw or external host backings', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.source, descriptor('disk.vmdk').replace('</Envelope>', '<DiskSection><Disk ovf:fileRef="disk"/></DiskSection></Envelope>').replace('ovf:href=', 'ovf:id="disk" ovf:href='));
  await fs.writeFile(path.join(f.input, 'disk.vmdk'), '# Disk DescriptorFile\ncreateType="fullDevice"\nRW 1 FLAT "host-device"');
  await assert.rejects(inspectArtifact(f.backend, f.source), /self-contained streamOptimized/);
});

test('job capacity, unrelated concurrency and history eviction are bounded', async () => {
  const jobs = new JobManager({ maxActive: 2, maxRecords: 2 }); const gates = [];
  const task = () => new Promise(resolve => gates.push(resolve));
  const first = jobs.start({ operation: 'test', resources: [path.resolve('one')], task });
  const second = jobs.start({ operation: 'test', resources: [path.resolve('two')], task });
  assert.throws(() => jobs.start({ operation: 'test', resources: [path.resolve('three')], task }), /limit/);
  await delay(0); gates.forEach(resolve => resolve({ ok: true })); await Promise.all([jobs.get(first.job_id).done, jobs.get(second.job_id).done]);
  const third = jobs.start({ operation: 'test', task: async () => ({ ok: true }) }); await jobs.get(third.job_id).done;
  assert.equal(jobs.list().jobs.length, 2); assert.throws(() => jobs.status(first.job_id), /expired/); await jobs.close();
});
