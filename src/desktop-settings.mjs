import path from 'node:path';

// Shared by the manifest generator and the lightweight Desktop launcher.
// Values are local configuration; no passwords are accepted by this adapter.
export const desktopSettings = {
  credentials_file: ['VMWARE_CREDENTIALS_FILE', 'file', 'Credentials file', 'Optional absolute path to the existing private credentials JSON. Leave blank to use your per-user default.'],
  vmrun_path: ['VMRUN_PATH', 'file', 'vmrun executable', 'Optional absolute native vmrun executable path. Leave blank for automatic discovery.'],
  disk_manager_path: ['VMWARE_VDISKMANAGER_PATH', 'file', 'Virtual disk manager', 'Optional absolute vmware-vdiskmanager executable path.'],
  ovftool_path: ['VMWARE_OVFTOOL_PATH', 'file', 'OVF Tool', 'Optional absolute ovftool executable path.'],
  vmcli_path: ['VMWARE_VMCLI_PATH', 'file', 'vmcli executable', 'Optional absolute vmcli executable path for read-only capability inspection.'],
  vmx_path: ['VMWARE_VMX_PATH', 'file', 'VMware worker executable', 'Optional absolute vmware-vmx executable path for native worker verification.'],
  inventory_path: ['VMWARE_INVENTORY_PATH', 'file', 'VM inventory', 'Optional absolute inventory.vmls path. Leave blank for the current user inventory.'],
  preferences_path: ['VMWARE_PREFERENCES_PATH', 'file', 'VMware preferences', 'Optional absolute preferences file path for LAN segment configuration.'],
  allowed_roots: ['VMWARE_ALLOWED_ROOTS', 'string', 'Allowed VM directories', 'Optional absolute directories separated by semicolons on Windows or colons on Linux. Blank preserves inherited policy or existing unrestricted defaults. Inventory still lists paths outside these roots.'],
  allowed_host_roots: ['VMWARE_ALLOWED_HOST_ROOTS', 'string', 'Allowed host directories', 'Optional absolute directories for host files, separated by semicolons on Windows or colons on Linux. Blank preserves inherited policy or existing defaults.'],
  rest_url: ['VMWARE_REST_URL', 'string', 'REST origin', 'Optional VMware REST origin. Default: http://127.0.0.1:8697. Remote services require HTTPS. Credentials stay in the local credentials file.'],
};

export function desktopEnvironment(env, platform = process.platform) {
  const result = { ...env };
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const delimiter = platform === 'win32' ? ';' : ':';
  for (const [key, [variable, type]] of Object.entries(desktopSettings)) {
    const input = `VMWARE_DESKTOP_${key.toUpperCase()}`;
    const value = env[input];
    delete result[input];
    if (value === undefined || value.trim() === '') continue;
    const invalid = () => { throw new Error(`Invalid Claude Desktop setting: ${key}. Check the extension settings; paths must be absolute and REST must be an HTTP(S) origin without credentials.`); };
    if (value.includes('\0') || value.includes('${')) invalid();
    if (type === 'file' && !paths.isAbsolute(value)) invalid();
    if (key === 'allowed_roots' || key === 'allowed_host_roots') {
      const roots = value.split(delimiter);
      if (roots.some(root => !root || !paths.isAbsolute(root))) invalid();
    }
    if (key === 'rest_url') {
      let url;
      try { url = new URL(value); } catch { invalid(); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) invalid();
      if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) invalid();
    }
    result[variable] = value;
  }
  return result;
}
