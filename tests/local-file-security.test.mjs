import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localFileProtector } from '../src/local-file-security.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-helper-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts', 'Protect-LocalFile.ps1');
  await fs.writeFile(script, '# fixture');
  return { root, script };
}

test('Windows protector checks the helper on every call and preserves argument isolation', async t => {
  const f = await fixture(t); const calls = [];
  const protect = localFileProtector({ execute: async (...args) => calls.push(args) }, { platform: 'win32', root: f.root });
  const filename = path.join(f.root, 'file with spaces.txt');
  await protect(filename);
  assert.deepEqual(calls[0].slice(0, 2), ['pwsh', ['-NoProfile', '-File', f.script, '-LiteralPath', filename]]);
  assert.equal(calls[0][2].shell, false);
  await fs.unlink(f.script);
  await assert.rejects(protect(filename), { code: 'PLUGIN_RUNTIME_MISSING' });
  assert.equal(calls.length, 1);
});

test('Windows protector diagnoses cache removal between checking and helper execution', async t => {
  const f = await fixture(t);
  const protect = localFileProtector({ execute: async () => { await fs.unlink(f.script); throw new Error('PowerShell failed'); } }, { platform: 'win32', root: f.root });
  await assert.rejects(protect('unused'), error => {
    assert.equal(error.code, 'PLUGIN_RUNTIME_MISSING');
    assert.match(error.message, /Reconnect.*reinstall\/reimport/);
    return true;
  });
});

test('Windows protector preserves real helper failures when its runtime is intact', async t => {
  const f = await fixture(t); const failure = new Error('Access denied setting ACL');
  const protect = localFileProtector({ execute: async () => { throw failure; } }, { platform: 'win32', root: f.root });
  await assert.rejects(protect('unused'), error => error === failure);
});

test('Windows protector rejects a directory in place of its helper', async t => {
  const f = await fixture(t); await fs.unlink(f.script); await fs.mkdir(f.script);
  const protect = localFileProtector({ execute: async () => assert.fail('Must not launch PowerShell') }, { platform: 'win32', root: f.root });
  await assert.rejects(protect.preflight(), { code: 'PLUGIN_RUNTIME_MISSING' });
});
