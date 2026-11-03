import fs from 'node:fs/promises';
import { z } from 'zod';
import { findVMwareExecutable } from './host-platform.mjs';
import { parseHardware } from './vm-hardware.mjs';

const file = z.string().min(1).max(4096).refine(value => !/[\x00-\x1f]/.test(value));
export const securitySchemas = {
  vm_security_capabilities: z.object({}).strict(),
  vm_security_status: z.object({ vmx: file }).strict(),
};

const reason = 'No supported headless encryption creation and vTPM provisioning backend has been verified. Installed tools and version discovery do not establish provisioning support.';
const blocked = () => ({ available: false, code: 'UNSUPPORTED_CAPABILITY', reason,
  supported_encryption_modes: [], encryption_enable: false, vtpm_provision: false,
  password_rotation: false, decryption: false, vtpm_remove: false, vtpm_reset: false,
  action: 'See security.md for native probe evidence and validation gaps. Do not bypass this refusal with raw VMX keys or GUI automation.' });
const boolean = value => /^true$/i.test(value || '') ? true : /^false$/i.test(value || '') ? false : null;
const unknown = () => ({ encryption: { state: 'unknown', mode: 'unknown', configuration_markers_present: null },
  vtpm: { declared_present: null, presence: 'unknown', independently_verified: false },
  managed_configuration_detected: null, firmware: 'unknown', hardware_version: null });

async function readDeclarations(vmx) {
  const handle = await fs.open(vmx, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 4 * 1024 * 1024) throw new Error('Unsupported configuration size/type');
    // Bounded even if another writer grows the file after stat. A spare byte
    // detects growth without returning a partial configuration as complete.
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await handle.stat(), current = await fs.stat(vmx);
    // Windows path stat can report dev=0 while handle stat reports the volume
    // serial. Compare every available identity field without rejecting that
    // documented-by-observation difference; inode and timestamps still match.
    if (count !== before.size || [after, current].some(stat =>
      ((process.platform !== 'win32' || stat.dev !== 0) && before.dev !== stat.dev) ||
      before.ino !== stat.ino || before.size !== stat.size || before.mtimeMs !== stat.mtimeMs || before.ctimeMs !== stat.ctimeMs)) throw new Error('Concurrent change');
    return parseHardware(bytes.subarray(0, count)).config;
  } finally { await handle.close(); }
}

export class SecurityManager {
  constructor({ backend, hardware }) { this.backend = backend; this.hardware = hardware; }

  async capabilities() {
    const product = await this.hardware.capabilities();
    const worker = { available: product.available, product_version: product.product_version || null,
      build: product.build || null, compatibility_profile_known: product.available };
    let executable = null;
    let cli = { discovered: false, help_verified: false, version: null };
    try {
      // Help/version only: no target VM, credentials, desktop executable or
      // arbitrary native arguments. Never return native stdout/stderr/errors.
      const beside = await this.backend.executable().catch(() => undefined);
      executable = await findVMwareExecutable('vmcli', { env: this.backend.env, beside });
      cli.discovered = true;
      const options = { shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 65536, env: this.backend.env };
      const help = await this.backend.execute(executable, ['--help'], options);
      cli.help_verified = /Usage:\s*vmcli(?:\.exe)?\s/i.test(help.stdout || '');
      const version = await this.backend.execute(executable, ['--version'], options);
      cli.version = (version.stdout || '').match(/^vmcli(?:\.exe)? version (\d+(?:\.\d+){1,3})\s*$/i)?.[1] || null;
    } catch { /* A failed probe remains unknown, never a usable backend. */ }
    return { platform: process.platform, worker, vmcli: { ...cli, executable },
      backend: blocked(), live_support: 'unverified',
      prerequisites: ['Verified native encryption/key-management backend and independent security inspection',
        'Compatible product, virtual hardware and UEFI firmware',
        'Full power-off, no locks/suspend/other writers, exclusive access',
        'Verified protected complete recovery artifacts and local credential profile',
        'Separately authorized disposable provisioning and guest TPM persistence validation'],
      note: 'Read-only discovery. No supported encryption mode, credential transport or security mutation is enabled on any platform/version.' };
  }

  async status(input) {
    const a = securitySchemas.vm_security_status.parse(input);
    const vmx = await this.backend.vmx(a.vmx);
    let observation = unknown(), inspection = 'unknown';
    try {
      const config = await readDeclarations(vmx);
      const markers = Object.keys(config).some(key => key.startsWith('encryption.'));
      const managed = Object.keys(config).some(key => key.startsWith('managedvm.'));
      const declared = boolean(config['vtpm.present']);
      observation = { encryption: { state: 'unknown', mode: 'unknown', configuration_markers_present: markers },
        vtpm: { declared_present: declared, presence: 'unknown', independently_verified: false },
        managed_configuration_detected: managed,
        firmware: ['efi', 'bios'].includes(config.firmware?.toLowerCase()) ? config.firmware.toLowerCase() : 'unknown',
        hardware_version: /^\d{1,3}$/.test(config['virtualhw.version'] || '') ? Number(config['virtualhw.version']) : null };
      inspection = 'configuration_only';
    } catch { /* Malformed, unreadable or changing VMX values must not escape. */ }
    return { vmx, inspection, ...observation, backend: blocked(),
      prerequisites: { full_power_off: 'unknown', exclusive_access: 'unknown', recovery_verified: false,
        product_compatibility: 'unknown', encryption_mode_verified: false },
      note: 'Configuration declarations only; missing keys do not prove absence. Encrypted data may hide hardware. No disk, TPM contents, credentials or native security state were inspected. No configuration, power or file changes were made.' };
  }
}
