import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workstation, parseAssignments, parseCountedList, isWithin } from '../src/workstation.mjs';

async function fixture(t, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-plugin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binary = path.join(root, 'vmrun.exe');
  const vmx = path.join(root, 'VM with spaces.vmx');
  await fs.writeFile(binary, 'test executable placeholder');
  await fs.writeFile(vmx, 'displayName = "Lab"\nmemsize = "4096"\nsecret = "do not return"');
  const inventory = path.join(root, 'inventory.vmls');
  const env = { VMRUN_PATH: binary, VMWARE_INVENTORY_PATH: inventory };
  return { root, binary, vmx, inventory, env, backend: new Workstation({ env, run }) };
}

test('parses inventory including VMware hex escapes and Windows backslashes', () => {
  assert.deepEqual(parseAssignments('vmlist1.config = "C:\\VMs\\Lab.vmx"\nvmlist1.DisplayName = "Lab |22One|22"'), {
    'vmlist1.config': 'C:\\VMs\\Lab.vmx', 'vmlist1.DisplayName': 'Lab "One"',
  });
});
test('fails closed on malformed or truncated list output', () => {
  assert.deepEqual(parseCountedList('\r\nTotal running VMs: 0\r\n'), []);
  assert.throws(() => parseCountedList('Error: unavailable'));
  assert.throws(() => parseCountedList('Total running VMs: 2\nonly-one.vmx'));
});
test('root containment rejects a sibling with the same prefix', () => {
  assert.equal(isWithin(path.resolve('VMs'), path.resolve('VMs', 'Lab.vmx')), true);
  assert.equal(isWithin(path.resolve('VMs'), path.resolve('VMs-other', 'Lab.vmx')), false);
});
test('power arguments preserve spaces and shell metacharacters as data', async t => {
  const calls = [];
  const f = await fixture(t, async (binary, args, options) => { calls.push({ binary, args, options }); return { stdout: '' }; });
  await f.backend.power(f.vmx, 'stop');
  assert.deepEqual(calls[0].args, ['-T', 'ws', 'stop', await fs.realpath(f.vmx), 'soft']);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  await f.backend.snapshot(f.vmx, 'snapshot', 'before & after $(literal)');
  assert.equal(calls[1].args.at(-1), 'before & after $(literal)');
});
test('invalid target/action/control characters never reach vmrun', async t => {
  let count = 0;
  const f = await fixture(t, async () => { count++; return { stdout: '' }; });
  await assert.rejects(f.backend.power('relative.vmx', 'start'));
  await assert.rejects(f.backend.power(f.vmx, 'deleteVM'));
  await assert.rejects(f.backend.power(f.vmx, 'stop', 'invalid'));
  await assert.rejects(f.backend.snapshot(f.vmx, 'snapshot', 'bad\nname'));
  assert.equal(count, 0);
});
test('allowed roots reject outside VMX and links resolving outside', async t => {
  const f = await fixture(t, async () => { throw new Error('must not execute'); });
  const allowed = path.join(f.root, 'allowed');
  await fs.mkdir(allowed);
  f.env.VMWARE_ALLOWED_ROOTS = allowed;
  await assert.rejects(f.backend.vmx(f.vmx), /outside/);
  const inside = path.join(allowed, 'inside.vmx');
  await fs.writeFile(inside, '');
  assert.equal(await f.backend.vmx(inside), await fs.realpath(inside));
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'outside.vmx'), '');
  await fs.symlink(outside, path.join(allowed, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.backend.vmx(path.join(allowed, 'link', 'outside.vmx')), /outside/);
});
test('inventory merges running VMs and retains missing registrations', async t => {
  const f = await fixture(t, async () => ({ stdout: `Total running VMs: 1\n${f.vmx}\n` }));
  const missing = path.join(f.root, 'missing.vmx');
  await fs.writeFile(f.inventory, `vmlist0.config = "${f.vmx}"\nvmlist0.DisplayName = "Lab"\nvmlist1.config = "${missing}"`);
  const result = await f.backend.listVMs();
  assert.equal(result.vms.length, 2);
  assert.deepEqual(result.vms.map(v => [v.running, v.exists]), [[true, true], [false, false]]);
});
test('missing inventory reports a warning and still returns unregistered running VM', async t => {
  const f = await fixture(t, async () => ({ stdout: `Total running VMs: 1\n${f.vmx}` }));
  const result = await f.backend.listVMs();
  assert.equal(result.warnings.length, 1);
  assert.equal(result.vms[0].registered, false);
});
test('details return selected hardware fields only', async t => {
  const f = await fixture(t, async () => ({ stdout: 'Total running VMs: 0' }));
  const result = await f.backend.details(f.vmx);
  assert.deepEqual(result.hardware, { displayName: 'Lab', memsize: '4096' });
  assert.equal(result.running, false);
});
test('ambiguous snapshot names reject revert and no destructive command runs', async t => {
  const calls = [];
  const f = await fixture(t, async (_, args) => { calls.push(args); return { stdout: 'Total snapshots: 2\nbaseline\nbaseline' }; });
  await assert.rejects(f.backend.snapshot(f.vmx, 'revertToSnapshot', 'baseline'), /exactly one/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], 'listSnapshots');
});
test('snapshot deletion preserves children and passes the exact name', async t => {
  const calls = [];
  const f = await fixture(t, async (_, args) => { calls.push(args); return { stdout: args[2] === 'listSnapshots' ? 'Total snapshots: 1\nbaseline' : '' }; });
  await f.backend.snapshot(f.vmx, 'deleteSnapshot', 'baseline');
  assert.deepEqual(calls[1], ['-T', 'ws', 'deleteSnapshot', await fs.realpath(f.vmx), 'baseline']);
});
test('mutation failure reports uncertain outcome and never retries with hard mode', async t => {
  let count = 0;
  const f = await fixture(t, async () => { count++; throw Object.assign(new Error('timeout'), { killed: true, stderr: 'busy' }); });
  await assert.rejects(f.backend.power(f.vmx, 'stop'), /may have taken effect/);
  assert.equal(count, 1);
});
test('guest IP validates IPv4/IPv6 and rejects error-looking success output', async t => {
  let stdout = '192.0.2.10';
  const f = await fixture(t, async () => ({ stdout }));
  assert.equal((await f.backend.guestIP(f.vmx)).address, stdout);
  stdout = '2001:db8::1';
  assert.equal((await f.backend.guestIP(f.vmx)).address, stdout);
  stdout = 'Error: VMware Tools is not running';
  await assert.rejects(f.backend.guestIP(f.vmx), /valid guest IP/);
});
test('concurrent invocations are serialized even after failure', async t => {
  let active = 0;
  let peak = 0;
  const f = await fixture(t, async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return { stdout: 'Total running VMs: 0' };
  });
  await Promise.all([f.backend.run(['list']), f.backend.run(['list'])]);
  assert.equal(peak, 1);
});
