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
export function localFileProtector(backend, { platform = process.platform, root } = {}) {
  if (platform === 'linux') return async filename => {
    const handle = await openPrivateFile(filename);
    try {
      await handle.chmod(0o600);
      if ((await handle.stat()).mode & 0o077) throw new Error('This filesystem does not enforce private Linux file permissions. Use a native Linux filesystem for sensitive files.');
    } finally { await handle.close(); }
  };
  const script = path.join(root ?? path.resolve(path.dirname(process.argv[1]), '..'), 'scripts', 'Protect-LocalFile.ps1');
  const preflight = async () => {
    try {
      if (!(await fs.stat(script)).isFile()) throw new Error('Expected a regular helper file.');
      await fs.access(script, constants.R_OK);
    } catch (cause) {
      throw Object.assign(new Error('PLUGIN_RUNTIME_MISSING: The VMware Workstation plugin runtime is incomplete or no longer available (Protect-LocalFile.ps1). Reconnect the plugin or open a fresh chat to use the installed version. If this persists, reinstall/reimport the plugin before retrying.', { cause }), { code: 'PLUGIN_RUNTIME_MISSING' });
    }
  };
  const protect = async filename => {
    await preflight();
    try {
      return await backend.execute('pwsh', ['-NoProfile', '-File', script, '-LiteralPath', filename], { windowsHide: true, shell: false, encoding: 'utf8', timeout: 10000 });
    } catch (error) {
      // The cache can disappear between preflight and PowerShell opening it.
      await preflight();
      throw error;
    }
  };
  protect.preflight = preflight;
  return protect;
}
