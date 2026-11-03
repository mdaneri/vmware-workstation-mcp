import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Workstation } from '../src/workstation.mjs';
import { HardwareManager } from '../src/hardware.mjs';
import { SecurityManager, securitySchemas } from '../src/security.mjs';

async function fixture(t, { platform = process.platform, product = 'VMware Workstation 26.0.1 build-25688693', probeFailure = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'security-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ext = process.platform === 'win32' ? '.exe' : '';
  for (const name of ['vmrun', 'vmware-vmx', 'vmcli']) await fs.writeFile(path.join(root, name + ext), '', { mode: 0o755 });
  const calls = [], secret = `generated-fake-secret-${crypto.randomUUID()}`;
  const backend = new Workstation({ env: { VMRUN_PATH: path.join(root, 'vmrun' + ext), VMWARE_VMX_PATH: path.join(root, 'vmware-vmx' + ext),
    VMWARE_VMCLI_PATH: path.join(root, 'vmcli' + ext), VMWARE_ALLOWED_ROOTS: root }, run: async (file, args, options) => {
    calls.push({ file, args, options });
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.equal(options.timeout, 10000);
    if (path.basename(file).startsWith('vmcli')) {
      if (probeFailure) throw Object.assign(new Error(secret), { stdout: secret, stderr: secret });
      assert.ok(['--help', '--version'].includes(args[0])); assert.equal(args.length, 1);
      return { stdout: args[0] === '--help' ? `Usage: vmcli.exe <module> <command>\n${secret}` : 'vmcli.exe version 0.1.25688693\n' };
    }
    if (file === 'pwsh') assert.equal(options.env.VMWARE_HARDWARE_VERSION_TARGET, path.join(root, 'vmware-vmx' + ext));
    else { assert.equal(file, path.join(root, 'vmware-vmx' + ext)); assert.deepEqual(args, ['-v']); }
    return { stdout: product };
  } });
  const manager = new SecurityManager({ backend, hardware: new HardwareManager({ backend, platform }) });
  const vmx = path.join(root, 'selected.vmx'); await fs.writeFile(vmx, '.encoding = "UTF-8"\n');
  return { root, manager, backend, vmx, calls, secret };
}

for (const platform of ['win32', 'linux']) test(`security discovery separates tools from usable backend (${platform} worker double)`, async t => {
  const f = await fixture(t, { platform });
  const result = await f.manager.capabilities();
  assert.equal(result.worker.product_version, '26.0.1'); assert.equal(result.worker.build, '25688693');
  assert.equal(result.vmcli.help_verified, true); assert.equal(result.vmcli.version, '0.1.25688693');
  assert.equal(result.backend.available, false); assert.deepEqual(result.backend.supported_encryption_modes, []);
  for (const field of ['encryption_enable', 'vtpm_provision', 'password_rotation', 'decryption', 'vtpm_remove', 'vtpm_reset']) assert.equal(result.backend[field], false);
  assert.equal(f.calls.length, 3); assert.ok(!JSON.stringify(result).includes(f.secret));
});

test('failed probes, unknown products and missing executables never enable security operations or leak output', async t => {
  const f = await fixture(t, { product: 'VMware Workstation 99.0.0 build-9999', probeFailure: true });
  let result = await f.manager.capabilities();
  assert.equal(result.worker.available, false); assert.equal(result.vmcli.discovered, true); assert.equal(result.vmcli.help_verified, false);
  assert.equal(result.backend.available, false); assert.ok(!JSON.stringify(result).includes(f.secret));
  f.backend.env.VMWARE_VMCLI_PATH = path.join(f.root, process.platform === 'win32' ? 'missing/vmcli.exe' : 'missing/vmcli');
  result = await f.manager.capabilities(); assert.equal(result.vmcli.discovered, false); assert.equal(result.backend.available, false);
});

test('security inspection returns only bounded declarations and never claims native encryption/TPM state', async t => {
  const f = await fixture(t);
  for (const declaration of ['TRUE', 'FALSE', 'invalid']) {
    const original = `.encoding = "UTF-8"\nfirmware = "efi"\nvirtualHW.version = "21"\nvtpm.present = "${declaration}"\nencryption.keySafe = "${f.secret}"\nencryption.data = "${f.secret}"\nvtpm.ekCRT = "${f.secret}"\ncustom.setting = "${f.secret}"\nethernet0.generatedAddress = "00:0c:29:ab:cd:ef"\n`;
    await fs.writeFile(f.vmx, original);
    const result = await f.manager.status({ vmx: f.vmx });
    assert.equal(result.inspection, 'configuration_only'); assert.equal(result.encryption.configuration_markers_present, true);
    assert.equal(result.encryption.state, 'unknown'); assert.equal(result.encryption.mode, 'unknown');
    assert.equal(result.vtpm.declared_present, declaration === 'invalid' ? null : declaration === 'TRUE');
    assert.equal(result.vtpm.presence, 'unknown'); assert.equal(result.vtpm.independently_verified, false);
    assert.equal(result.firmware, 'efi'); assert.equal(result.hardware_version, 21);
    assert.ok(!JSON.stringify(result).includes(f.secret)); assert.ok(!JSON.stringify(result).includes('00:0c:29'));
    assert.equal(await fs.readFile(f.vmx, 'utf8'), original);
  }
  assert.equal(f.calls.length, 0, 'VM status never launches a process or unlocks a VM');
  assert.deepEqual(await fs.readdir(f.root), (await fs.readdir(f.root)).filter(name => !/backup|tmp|log|job/.test(name)));
});

test('omitted, managed, malformed, non-UTF8 and oversized VMX report explicit unknown values without leaking content', async t => {
  const f = await fixture(t);
  for (const text of ['', 'managedVM.autoAddVTPM = "software"\n', `vtpm.present = "TRUE"\nVTPM.present = "${f.secret}"\n`, `arbitrary ${f.secret}`, '.encoding = "windows-1252"\n', Buffer.from([0xff]), 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    await fs.writeFile(f.vmx, text);
    const result = await f.manager.status({ vmx: f.vmx });
    assert.equal(result.vtpm.declared_present, null); assert.equal(result.vtpm.presence, 'unknown');
    assert.equal(result.encryption.state, 'unknown'); assert.equal(result.hardware_version, null);
    assert.ok(!JSON.stringify(result).includes(f.secret));
    if (typeof text !== 'string' || text.includes(f.secret) || text.length > 4 * 1024 * 1024 || text.includes('windows-1252')) assert.equal(result.inspection, 'unknown');
    if (typeof text === 'string' && text.startsWith('managed')) assert.equal(result.managed_configuration_detected, true);
  }
});

test('security schemas reject credentials, mutation flags and options; canonical paths enforce VM allowlist', async t => {
  const f = await fixture(t);
  for (const key of ['password', 'vm_password_profile', 'confirm', 'options', 'mode']) {
    assert.equal(securitySchemas.vm_security_capabilities.safeParse({ [key]: 'fake' }).success, false);
    assert.equal(securitySchemas.vm_security_status.safeParse({ vmx: f.vmx, [key]: 'fake' }).success, false);
  }
  assert.equal(securitySchemas.vm_security_status.safeParse({ vmx: '\0' }).success, false);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'security-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const other = path.join(outside, 'other.vmx'); await fs.writeFile(other, '');
  await assert.rejects(f.manager.status({ vmx: other }), /outside VMWARE_ALLOWED_ROOTS/);
  await assert.rejects(f.manager.status({ vmx: path.join(f.root, 'missing.vmx') }));
});

for (const replaced of [false, true]) test(`large file IDs preserve exact identity and ${replaced ? 'detect replacement' : 'allow unchanged declarations'}`, async t => {
  const f = await fixture(t);
  await fs.writeFile(f.vmx, 'vtpm.present = "TRUE"\n');
  const inode = 2n ** 63n;
  // These different native IDs collapse to the same JavaScript Number.
  assert.equal(Number(inode), Number(inode + 1n));
  const open = fs.open.bind(fs), stat = fs.stat.bind(fs); let handleStats = 0, pathStats = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args), handleStat = handle.stat.bind(handle);
    t.mock.method(handle, 'stat', async options => {
      assert.equal(options?.bigint, true);
      handleStats++;
      const result = await handleStat(options);
      result.ino = inode;
      return result;
    });
    return handle;
  });
  t.mock.method(fs, 'stat', async (file, options) => {
    const result = await stat(file, options);
    if (file === f.vmx && options?.bigint) {
      pathStats++;
      result.ino = inode + (replaced ? 1n : 0n);
    }
    return result;
  });
  const result = await f.manager.status({ vmx: f.vmx });
  assert.equal(handleStats, 2); assert.equal(pathStats, 1);
  assert.equal(result.inspection, replaced ? 'unknown' : 'configuration_only');
  assert.equal(result.vtpm.declared_present, replaced ? null : true);
});
