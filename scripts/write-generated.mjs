import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Windows can refuse truncation while a scanner or Node process maps a file.
// Skip identical outputs and replace changed files without truncating them.
export async function writeGenerated(filename, value) {
  const contents = Buffer.from(value);
  const existing = await fs.readFile(filename).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (existing?.equals(contents)) return;
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.build-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, contents, { flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
