import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';

export const commonFiles = [
  'LICENSE', 'THIRD-PARTY-NOTICES.md', 'README.md', 'reference.md', 'catalog.md', 'claude-installation.md',
  'console.md', 'disks.md', 'guest-exec.md', 'hardware.md', 'iso.md', 'jobs.md', 'labs.md',
  'linux.md', 'ovf.md', 'readiness.md', 'security.md', 'serial.md', 'templates.md',
  'assets/icon.svg', 'assets/icon.png', 'tool-schemas.json',
  'templates/schema-v1.json', 'templates/linux.json', 'templates/windows.json', 'templates/nested-esxi.json',
  'labs/schema-v1.json', 'labs/two-vm.json', 'labs/nested-esxi.json',
  'server/server.cjs', 'server/inspect-catalog.cjs', 'server/configure-console.cjs', 'server/set-credentials.cjs',
  'scripts/Set-Credentials.ps1', 'scripts/Configure-Console.ps1', 'scripts/Protect-LocalFile.ps1', 'scripts/Serial-Bridge.ps1',
];
export const pluginFiles = [...commonFiles, 'plugin.json', 'mcp.json', '.claude-plugin/plugin.json', '.mcp.json', 'skills/manage-workstation/SKILL.md'];
export const desktopFiles = [...commonFiles, 'server/claude-desktop.cjs'];

export async function collectFiles(root, names) {
  const resolved = path.resolve(root);
  assert.ok(!(await fs.lstat(resolved)).isSymbolicLink(), 'Package root must not be a symlink');
  const files = {};
  for (const name of names) {
    assert.ok(!name.includes('\\') && !name.split('/').some(part => ['', '.', '..'].includes(part)) && !path.isAbsolute(name), `Unsafe archive path: ${name}`);
    let current = resolved;
    for (const part of name.split('/')) {
      current = path.join(current, part);
      assert.ok(!(await fs.lstat(current)).isSymbolicLink(), `Package must not contain symlinks: ${name}`);
    }
    assert.ok((await fs.stat(current)).isFile(), `Package entry must be a file: ${name}`);
    files[name] = await fs.readFile(current);
  }
  return files;
}

export async function verifyArchive(archive, files) {
  const extracted = unzipSync(await fs.readFile(archive));
  assert.deepEqual(Object.keys(extracted).sort(), Object.keys(files).sort(), 'Archive must match the explicit allowlist');
  for (const [name, contents] of Object.entries(files)) assert.deepEqual(Buffer.from(extracted[name]), contents, `Archive round trip: ${name}`);
  return extracted;
}
