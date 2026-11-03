import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { zipSync, unzipSync } from 'fflate';

const root = path.resolve('vmware-workstation');
const files = {};
async function collect(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Plugin package must not contain symlinks.');
    if (entry.isDirectory()) await collect(filename);
    else if (entry.isFile()) files[path.relative(root, filename).split(path.sep).join('/')] = await fs.readFile(filename);
    else throw new Error('Unsupported file in plugin package.');
  }
}
await collect(root);
assert.ok(files['readiness.md'], 'Package must include the readiness and diagnostics guide.');
assert.ok(files['guest-exec.md'], 'Package must include the verified guest execution guide.');
const { version } = JSON.parse(files['plugin.json'].toString('utf8'));
assert.match(version, /^\d+\.\d+\.\d+$/);
await fs.mkdir('dist', { recursive: true });
const archive = path.resolve('dist', `vmware-workstation-${version}.zip`);
await fs.writeFile(archive, zipSync(files, { level: 6 }));
const extracted = unzipSync(await fs.readFile(archive));
for (const required of ['plugin.json', 'mcp.json', 'LICENSE', 'server/server.cjs', 'server/configure-console.cjs', 'server/set-credentials.cjs', 'skills/manage-workstation/SKILL.md', 'README.md', 'reference.md', 'console.md', 'linux.md', 'ovf.md', 'disks.md', 'serial.md', 'scripts/Serial-Bridge.ps1', 'THIRD-PARTY-NOTICES.md', 'tool-schemas.json', 'assets/icon.svg', 'scripts/Set-Credentials.ps1', 'scripts/Configure-Console.ps1', 'scripts/Protect-LocalFile.ps1']) assert.ok(extracted[required], `Archive missing ${required}`);
assert.equal(Object.keys(extracted).length, Object.keys(files).length);
for (const [name, contents] of Object.entries(files)) assert.deepEqual(Buffer.from(extracted[name]), contents, `ZIP round trip: ${name}`);
console.log(`Verified ${Object.keys(files).length} archive entries: ${archive}`);
