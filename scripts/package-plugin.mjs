import fs from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';
import { collectFiles, pluginFiles, verifyArchive } from './distribution-files.mjs';

const files = await collectFiles('vmware-workstation', pluginFiles);
const { version } = JSON.parse(files['plugin.json'].toString('utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a release version');
await fs.mkdir('dist', { recursive: true });
const archive = path.resolve('dist', `vmware-workstation-${version}.zip`);
await fs.writeFile(archive, zipSync(files, { level: 6 }));
await verifyArchive(archive, files);
console.log(`Verified ${Object.keys(files).length} allowlisted archive entries: ${archive}`);
