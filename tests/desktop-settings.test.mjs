import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { desktopEnvironment } from '../src/desktop-settings.mjs';
import { collectFiles, pluginFiles, desktopFiles } from '../scripts/distribution-files.mjs';

test('Desktop blank settings preserve inherited policy and defaults; explicit settings take precedence', () => {
  const inherited = { VMWARE_CREDENTIALS_FILE: 'C:\\private\\credentials.json', VMWARE_ALLOWED_ROOTS: 'C:\\VMs', PATH: 'native-path' };
  assert.deepEqual(desktopEnvironment(inherited, 'win32'), inherited);
  assert.deepEqual(desktopEnvironment({ ...inherited, VMWARE_DESKTOP_CREDENTIALS_FILE: '', VMWARE_DESKTOP_ALLOWED_ROOTS: '   ' }, 'win32'), inherited);
  const configured = desktopEnvironment({ ...inherited, VMWARE_DESKTOP_CREDENTIALS_FILE: 'D:\\private files\\profiles.json' }, 'win32');
  assert.equal(configured.VMWARE_CREDENTIALS_FILE, 'D:\\private files\\profiles.json');
  assert.equal(configured.VMWARE_ALLOWED_ROOTS, inherited.VMWARE_ALLOWED_ROOTS);
  assert.ok(!Object.hasOwn(configured, 'VMWARE_DESKTOP_CREDENTIALS_FILE'));
  assert.equal(inherited.VMWARE_CREDENTIALS_FILE, 'C:\\private\\credentials.json');
});

test('Desktop root lists use native delimiters without splitting paths containing spaces', () => {
  for (const [platform, value] of [['win32', 'C:\\My VMs;D:\\Lab'], ['linux', '/home/me/My VMs:/srv/lab']]) {
    assert.equal(desktopEnvironment({ VMWARE_DESKTOP_ALLOWED_ROOTS: value }, platform).VMWARE_ALLOWED_ROOTS, value);
    assert.equal(desktopEnvironment({ VMWARE_DESKTOP_ALLOWED_HOST_ROOTS: value }, platform).VMWARE_ALLOWED_HOST_ROOTS, value);
  }
});

test('Desktop refuses invalid explicit settings without logging their values', () => {
  for (const [key, value] of [
    ['CREDENTIALS_FILE', 'relative-secret-file.json'], ['VMRUN_PATH', '${user_config.vmrun_path}'],
    ['ALLOWED_ROOTS', '/safe:relative'], ['ALLOWED_HOST_ROOTS', '/safe:'], ['VMX_PATH', '/bad\0path'],
    ['REST_URL', 'http://private.example'], ['REST_URL', 'https://user:secret@example.com'],
    ['REST_URL', 'https://example.com/api'], ['REST_URL', 'https://example.com?secret=value'], ['REST_URL', 'not-a-url'],
  ]) {
    assert.throws(() => desktopEnvironment({ [`VMWARE_DESKTOP_${key}`]: value }, 'linux'), error => {
      assert.match(error.message, /Invalid Claude Desktop setting/);
      assert.ok(!error.message.includes(value));
      return true;
    });
  }
  for (const url of ['http://127.0.0.1:8697', 'http://[::1]:8697', 'https://example.com']) {
    assert.equal(desktopEnvironment({ VMWARE_DESKTOP_REST_URL: url }).VMWARE_REST_URL, url);
  }
});

test('distribution allowlists exclude local data and reject symlinks and traversal', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-package-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'server.cjs'), 'fixture');
  for (const name of ['credentials.json', '.env', 'private.vmx', 'private.vmdk']) await fs.writeFile(path.join(root, name), 'DO NOT PACKAGE');
  assert.deepEqual(Object.keys(await collectFiles(root, ['server.cjs'])), ['server.cjs']);
  for (const unsafe of ['../server.cjs', '/server.cjs', 'a/../server.cjs', 'a\\server.cjs']) await assert.rejects(collectFiles(root, [unsafe]), /Unsafe archive path/);
  await fs.mkdir(path.join(root, 'real'));
  await fs.writeFile(path.join(root, 'real/server.cjs'), 'fixture');
  await fs.symlink(path.join(root, 'real'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(collectFiles(root, ['linked/server.cjs']), /symlinks/);
  for (const name of [...pluginFiles, ...desktopFiles]) assert.doesNotMatch(name, /credentials[^/]*\.json$|test-vms|node_modules|\.vm[xd]k?$|\.env/);
});
