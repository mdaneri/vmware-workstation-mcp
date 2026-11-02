import path from 'node:path';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';

export async function openPrivateFile(filename, flags = constants.O_RDONLY) {
  // O_NOFOLLOW prevents a credential/VMX setup path from following a final symlink.
  const handle = await fs.open(filename, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1) throw new Error('Sensitive files must be regular files owned by the current user with exactly one hard link.');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

export async function readPrivateFile(filename) {
  const handle = await openPrivateFile(filename);
  try {
    if ((await handle.stat()).mode & 0o077) throw new Error('Credentials file must be private (chmod 600).');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

// The same user-only ACL policy used by the existing credentials setup script.
export function localFileProtector(backend) {
  if (process.platform === 'linux') return async filename => {
    const handle = await openPrivateFile(filename);
    try {
      await handle.chmod(0o600);
      if ((await handle.stat()).mode & 0o077) throw new Error('This filesystem does not enforce private Linux file permissions. Use a native Linux filesystem for sensitive files.');
    } finally { await handle.close(); }
  };
  const root = path.resolve(path.dirname(process.argv[1]), '..');
  return filename => backend.execute('pwsh', ['-NoProfile', '-File', path.join(root, 'scripts', 'Protect-LocalFile.ps1'), '-LiteralPath', filename], { windowsHide: true, shell: false, encoding: 'utf8', timeout: 10000 });
}
