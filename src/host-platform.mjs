import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function inventoryPath(env = process.env, platform = process.platform, home = os.homedir()) {
  return env.VMWARE_INVENTORY_PATH || (platform === 'win32'
    ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'VMware', 'inventory.vmls')
    : path.join(home, '.vmware', 'inventory.vmls'));
}

export function preferencesPath(env = process.env, platform = process.platform, home = os.homedir()) {
  return env.VMWARE_PREFERENCES_PATH || (platform === 'win32'
    ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'VMware', 'preferences.ini')
    : path.join(home, '.vmware', 'preferences'));
}

export function credentialsPath(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.VMWARE_CREDENTIALS_FILE) return env.VMWARE_CREDENTIALS_FILE;
  if (platform === 'win32') return env.APPDATA ? path.join(env.APPDATA, 'VMwareWorkstationPlugin', 'credentials.json') : null;
  // XDG requires an absolute base directory. Ignore relative values.
  const base = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config');
  return path.join(base, 'vmware-workstation-mcp', 'credentials.json');
}

export async function findVMwareExecutable(name, { env = process.env, platform = process.platform, beside } = {}) {
  if (!['win32', 'linux'].includes(platform)) throw new Error('VMware Workstation hosts supported by this plugin are Windows and Linux.');
  const filename = `${name}${platform === 'win32' ? '.exe' : ''}`;
  const setting = { vmrun: 'VMRUN_PATH', 'vmware-vdiskmanager': 'VMWARE_VDISKMANAGER_PATH', ovftool: 'VMWARE_OVFTOOL_PATH' }[name];
  if (!setting) throw new Error('Unsupported VMware executable.');
  const validFile = async candidate => {
    if (!path.isAbsolute(candidate) || !(await fs.stat(candidate)).isFile()) return false;
    if (platform !== 'win32') await fs.access(candidate, constants.X_OK);
    return true;
  };
  if (env[setting]) {
    const configured = env[setting];
    const actualName = path.basename(configured);
    if (!path.isAbsolute(configured) || (platform === 'win32' ? actualName.toLowerCase() !== filename : actualName !== filename)) throw new Error(`${setting} must be an absolute path to ${filename}.`);
    if (!await validFile(configured)) throw new Error(`${setting} is not an executable file.`);
    return configured; // Preserve symlink/launcher names required by VMware's appLoader.
  }
  const directories = [
    ...(name === 'ovftool' && beside ? [path.join(path.dirname(beside), 'OVFTool'), path.join(path.dirname(beside), 'ovftool')] : []),
    ...(beside ? [path.dirname(beside)] : []),
    ...(platform === 'win32' ? [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).map(root => path.join(root, 'VMware', 'VMware Workstation')) : []),
    ...(name === 'ovftool' && platform === 'win32' ? [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).flatMap(root => [path.join(root, 'VMware', 'VMware Workstation', 'OVFTool'), path.join(root, 'VMware', 'VMware OVF Tool')]) : []),
    ...(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean),
    ...(platform === 'linux' ? ['/usr/bin', '/usr/local/bin', '/usr/lib/vmware/bin'] : []),
    ...(name === 'ovftool' && platform === 'linux' ? ['/usr/lib/vmware-ovftool', '/opt/vmware/ovftool'] : []),
  ];
  for (const directory of new Set(directories)) {
    const candidate = path.join(directory, filename);
    try { if (await validFile(candidate)) return candidate; } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw new Error(`${filename} was not found. Install ${name === 'ovftool' ? 'VMware OVF Tool' : 'VMware Workstation on this host'} or set ${setting}.`);
}
