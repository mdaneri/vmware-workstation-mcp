// Opt-in only: clone an explicitly selected OFFLINE template, boot the new
// disposable VM, run fixed test commands, hard-stop it and retain evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Workstation, isWithin, parseAssignments } from '../src/workstation.mjs';

const env = process.env;
if (env.VMWARE_GUEST_EXEC_LIVE !== '1') throw new Error('Authorize full cloning, boot, fixed guest commands and hard-stop of one NEW disposable VM before setting VMWARE_GUEST_EXEC_LIVE=1.');
if (/microsoft|wsl/i.test(os.release())) throw new Error('Use a native Windows/Linux VMware host, not WSL.');
const guestOS = env.VMWARE_GUEST_EXEC_LIVE_OS;
assert.ok(['linux', 'windows'].includes(guestOS), 'Select VMWARE_GUEST_EXEC_LIVE_OS=linux|windows.');
assert.ok(env.VMWARE_GUEST_EXEC_LIVE_PROFILE, 'Select an existing local guest credential profile.');
assert.ok(env.VMWARE_GUEST_EXEC_LIVE_SOURCE_VMX, 'Select an offline, closed template VMX with Tools and the required runner installed.');
const backend = new Workstation();
const source = await backend.vmx(env.VMWARE_GUEST_EXEC_LIVE_SOURCE_VMX);
assert.equal((await backend.details(source)).running, false, 'Template must be offline.');
await assert.rejects(fs.access(`${source}.lck`), { code: 'ENOENT' });
const config = parseAssignments(await fs.readFile(source, 'utf8'));
assert.ok(!config['checkpoint.vmState'] && !config['suspend.filename'], 'Use a fully powered-off template with no saved state.');
await fs.mkdir('test-vms', { recursive: true });
const root = await fs.realpath(await fs.mkdtemp(path.resolve('test-vms', 'guest-exec-live-')));
const destination = path.join(root, 'clone', 'guest.vmx');
const inventory = path.join(root, 'inventory.vmls'); await fs.writeFile(inventory, '');
const evidence = { started_at: new Date().toISOString(), host: process.platform, guest_os: guestOS, passed: false, checks: {}, live: true };
const client = new Client({ name: 'disposable-guest-exec-live', version: '0.9.0' });
let powerAttempted = false;
let runningBefore;
async function call(name, args, timeout = 150000) {
  // Only cloning reads the source. Every mutation target is newly allocated.
  if (name === 'vmrun_clone') {
    assert.equal(args.vmx, source); assert.equal(args.destination_vmx, destination);
  } else if (args.vmx) {
    assert.equal(args.vmx, destination);
    assert.ok(isWithin(root, await fs.realpath(args.vmx)));
  }
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout });
  assert.ok(!response.isError, `${name} failed; inspect configuration locally. Raw output is omitted.`);
  return JSON.parse(response.content[0].text);
}
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe', env: {
    ...env, VMWARE_INVENTORY_PATH: inventory, VMWARE_ALLOWED_ROOTS: [root, path.dirname(source)].join(path.delimiter), VMWARE_ALLOWED_HOST_ROOTS: root, VMWARE_GUEST_EXEC_ROOT: root,
  } }));
  runningBefore = (await call('list_vms', {})).vms.filter(vm => vm.running).map(vm => vm.vmx).sort();
  await fs.mkdir(path.dirname(destination));
  await call('vmrun_clone', { vmx: source, destination_vmx: destination, clone_type: 'full', timeout_seconds: 600 }, 650000);
  assert.ok(isWithin(root, await fs.realpath(destination)));
  // No network or console exposure is needed for Tools guest execution.
  const cloneConfig = parseAssignments(await fs.readFile(destination, 'utf8'));
  const settings = { 'RemoteDisplay.vnc.enabled': 'FALSE' };
  for (const key of Object.keys(cloneConfig)) if (/^ethernet\d+\.present$/i.test(key)) settings[key.replace(/present$/i, 'startConnected')] = 'FALSE';
  await call('configure_vm', { vmx: destination, settings });
  powerAttempted = true;
  await call('vm_power', { vmx: destination, action: 'start', gui: false });
  assert.equal((await call('vm_wait_for_boot', { vmx: destination, timeout_seconds: 120 })).ready, true);
  const common = { vmx: destination, guest_os: guestOS, guest_profile: env.VMWARE_GUEST_EXEC_LIVE_PROFILE, confirm: true, timeout_seconds: 20, max_output_bytes: 128 };
  const script = guestOS === 'windows'
    ? { interpreter: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', interpreter_arguments: ['-NoProfile', '-NonInteractive', '-File'], script: '[Console]::Out.Write("stdout-marker"); [Console]::Error.Write("stderr-marker"); exit 7' }
    : { interpreter: '/bin/sh', script: 'printf stdout-marker; printf stderr-marker >&2; exit 7' };
  const result = await call('guest_exec', { ...common, ...script });
  assert.equal(result.status, 'completed'); assert.equal(result.exit_code, 7);
  assert.equal(result.stdout, 'stdout-marker'); assert.equal(result.stderr, 'stderr-marker');
  assert.equal(result.cleanup.guest, 'removed'); assert.equal(result.cleanup.host, 'removed');
  evidence.checks.stdout_stderr_nonzero_cleanup = 'passed';
  const zero = await call('guest_exec', { ...common, program: guestOS === 'windows' ? 'C:\\Windows\\System32\\whoami.exe' : '/usr/bin/id', max_output_bytes: 1 });
  assert.equal(zero.status, 'completed'); assert.equal(zero.exit_code, 0); assert.equal(zero.stdout_truncated, true); assert.equal(zero.stdout_bytes, 1);
  evidence.checks.program_zero_truncation = 'passed';
  const timeout = await call('guest_exec', { ...common, ...script, timeout_seconds: 1, script: guestOS === 'windows' ? 'Start-Sleep -Seconds 10' : 'sleep 10' });
  assert.equal(timeout.timed_out, true); assert.equal(timeout.exit_code, null);
  evidence.checks.timeout = 'passed'; evidence.passed = true;
} finally {
  try {
    if (powerAttempted) { await call('vm_power', { vmx: destination, action: 'stop', mode: 'hard' }); evidence.disposable_stopped = true; }
    if (runningBefore) {
      const after = (await call('list_vms', {})).vms.filter(vm => vm.running).map(vm => vm.vmx).sort();
      assert.deepEqual(after, runningBefore); evidence.existing_running_set_unchanged = true;
    }
  } catch { evidence.passed = false; evidence.cleanup_requires_inspection = true; process.exitCode = 1; }
  evidence.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  await client.close();
  console.log(`Guest execution live evidence: ${path.join(root, 'evidence.json')}`);
}
