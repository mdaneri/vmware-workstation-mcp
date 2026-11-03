import fs from 'node:fs/promises';
import path from 'node:path';
import { parseAssignments } from './workstation.mjs';

export function hardwareError(code, message) { throw Object.assign(new Error(message), { code, details: { action: 'Inspect the selected VM, fully power it off and close other configuration writers before retrying.' } }); }

// Strict, case-insensitive view for typed hardware edits. Unknown settings stay
// in the original text and are preserved by VMFiles.configure.
export async function readHardware(vmx) {
  return parseHardware(await fs.readFile(vmx));
}

export function parseHardware(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const seen = new Set();
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const match = line.match(/^\s*([\w.:-]+)\s*=\s*"[^"\r\n]*"\s*$/);
    if (!match || seen.has(match[1].toLowerCase())) hardwareError('UNSAFE_VM', 'Malformed or duplicate VMX assignments prevent safe hardware inspection/editing.');
    seen.add(match[1].toLowerCase());
  }
  const config = Object.fromEntries(Object.entries(parseAssignments(text)).map(([k, v]) => [k.toLowerCase(), v]));
  if (config['.encoding'] && !/^utf-?8$/i.test(config['.encoding'])) hardwareError('UNSAFE_VM', 'Hardware inspection/editing requires a UTF-8 VMX.');
  return { text, config };
}

export async function requireOffline(backend, vmx) {
  if ((await backend.details(vmx)).running) hardwareError('VM_RUNNING', 'Power off the VM; this hardware edit requires full power-off.');
  const vm = await readHardware(vmx);
  if ((await fs.stat(vmx)).nlink > 1) hardwareError('UNSAFE_VM', 'Hard-linked VMX files cannot be edited safely.');
  if (Object.keys(vm.config).some(k => /^(encryption\.|managedvm\.autoaddvtpm)/i.test(k))) hardwareError('UNSAFE_VM', 'Encrypted/managed VM hardware editing is unsupported.');
  if (vm.config['checkpoint.vmstate'] || vm.config['suspend.filename']) hardwareError('VM_SUSPENDED', 'VMX declares saved state; fully power off the VM before editing.');
  const directories = new Set([path.dirname(vmx)]);
  for (const key of ['workingdir', 'snapshot.directory']) if (vm.config[key]) directories.add(await backend.hostPath(path.resolve(path.dirname(vmx), vm.config[key]), 'directory'));
  for (const directory of directories) if ((await fs.readdir(directory)).some(name => /(?:\.lck|\.vmss|\.vmem)$/i.test(name))) hardwareError('VM_LOCKED_OR_SUSPENDED', 'VM directory contains locks or saved/suspended memory. Fully power off and close the VM; never delete locks/state to bypass this check.');
  return vm;
}
