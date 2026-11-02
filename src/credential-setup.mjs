import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Credentials } from './credentials.mjs';
import { localFileProtector } from './local-file-security.mjs';

// Called locally by the interactive helper. Passwords are never MCP/CLI arguments.
export async function saveCredential({ kind, profile = 'default', vmx, username, password, env = process.env, backend }) {
  if (!['rest', 'guest', 'vm', 'console'].includes(kind)) throw new Error('Choose rest, guest, vm, or console credentials.');
  const credentials = new Credentials(env);
  const name = credentials.profile(profile);
  if (typeof password !== 'string' || !password || password.includes('\0')) throw new Error('A nonempty password without NUL is required.');
  if (['rest', 'guest'].includes(kind) && (typeof username !== 'string' || !username || /[\x00-\x1f]/.test(username) || (kind === 'rest' && username.includes(':')))) throw new Error('Provide a valid username (REST usernames cannot contain colons).');
  if (kind === 'console' && !/^[\x20-\x7e]{1,8}$/.test(password)) throw new Error('Native VNC passwords must contain 1 to 8 ASCII characters.');
  const target = kind === 'console' ? await backend.vmx(vmx) : undefined;
  const filename = credentials.filename;
  if (!filename || !path.isAbsolute(filename)) throw new Error('Configure an absolute VMWARE_CREDENTIALS_FILE path.');
  let data;
  // An explicitly configured new file is valid for setup, but malformed/insecure existing files are refused.
  try { await fs.lstat(filename); data = await credentials.load(); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    data = {};
  }
  const entry = { ...(['rest', 'guest'].includes(kind) ? { username } : {}), password, ...(target ? { vmx: target } : {}) };
  if (kind === 'rest') data.rest = entry;
  else {
    if (data[kind] && (typeof data[kind] !== 'object' || Array.isArray(data[kind]))) throw new Error('The existing credential profile section must be an object.');
    data[kind] = { ...data[kind], [name]: entry };
  }
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filename), `.credentials-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, '', { flag: 'wx', mode: 0o600 });
    await localFileProtector(backend)(temporary);
    await fs.writeFile(temporary, JSON.stringify(data, null, 2) + '\n');
    await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return { filename, kind, ...(kind !== 'rest' ? { profile: name } : {}) };
}
