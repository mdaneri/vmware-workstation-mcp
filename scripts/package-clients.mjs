import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { packExtension } from '@anthropic-ai/mcpb';
import { collectFiles, desktopFiles, verifyArchive } from './distribution-files.mjs';
import './validate-clients.mjs';

const files = await collectFiles('vmware-workstation', desktopFiles);
Object.assign(files, await collectFiles('packaging/claude-desktop', ['manifest.json']));
const { version } = JSON.parse(files['manifest.json']);
await fs.mkdir('dist', { recursive: true });
const archive = path.resolve('dist', `vmware-workstation-${version}.mcpb`);
const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-mcpb-'));
try {
  for (const [name, contents] of Object.entries(files)) {
    const destination = path.join(stage, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents);
  }
  assert.ok(await packExtension({ extensionPath: stage, outputPath: archive, silent: true }), 'Official MCPB pack');
  await verifyArchive(archive, files);
} finally {
  // Only the fresh private staging directory allocated above is removed.
  await fs.rm(stage, { recursive: true, force: true });
}
const checksums = [];
for (const extension of ['zip', 'mcpb']) {
  const name = `vmware-workstation-${version}.${extension}`;
  const bytes = await fs.readFile(path.join('dist', name)).catch(error => { if (extension === 'zip' && error.code === 'ENOENT') return null; throw error; });
  if (bytes) checksums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
}
await fs.writeFile(path.join('dist', `vmware-workstation-${version}-SHA256SUMS.txt`), checksums.join('\n') + '\n');
console.log(`Verified ${Object.keys(files).length} allowlisted MCPB entries: ${archive}`);
