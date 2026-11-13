import { z } from 'zod';
import path from 'node:path';

const s = (name, extra = {}) => ({ name, type: 'string', ...extra });
const e = (name, values, extra = {}) => ({ name, type: 'enum', values, ...extra });
const n = (name, minimum, maximum) => ({ name, type: 'integer', minimum, maximum });
const flag = (name, value) => ({ name, type: 'boolean', flag: value, optional: true });
const guestPath = name => s(name);
const host = (name, kind) => s(name, { hostPath: kind });
const vm = (command, description, parameters = [], extra = {}) => ({ command, description, parameters, vmx: true, ...extra });
const guest = (command, description, parameters = [], extra = {}) => vm(command, description, parameters, { guestAuth: true, ...extra });
const hostCommand = (command, description, parameters = [], extra = {}) => ({ command, description, parameters, vmx: false, ...extra });
const programFlags = [flag('no_wait', '-noWait'), flag('active_window', '-activeWindow'), flag('interactive', '-interactive')];

export const commands = [
  vm('start', 'Start a VM; optionally show its Workstation window.', [e('mode', ['gui', 'nogui'], { default: 'nogui' })], { destructive: false }),
  ...['stop', 'reset', 'suspend'].map(command => vm(command, `${command} a VM. Soft mode is the default; hard mode requires explicit authorization.`, [e('mode', ['soft', 'hard'], { default: 'soft' })])),
  ...['pause', 'unpause'].map(command => vm(command, `${command} a VM.`, [], { destructive: command === 'pause' })),
  vm('listSnapshots', 'List VM snapshots; show_tree returns the hierarchy.', [flag('show_tree', 'showTree')], { readOnly: true }),
  vm('snapshot', 'Create a named VM snapshot.', [s('name')], { destructive: false }),
  vm('deleteSnapshot', 'Delete a named snapshot. Optionally delete its children as explicitly requested.', [s('name'), flag('delete_children', 'andDeleteChildren')]),
  vm('revertToSnapshot', 'Revert to a named snapshot; later VM state is discarded.', [s('name')]),
  hostCommand('listHostNetworks', 'List VMware virtual host networks.', [], { readOnly: true }),
  hostCommand('listPortForwardings', 'List port forwarding rules on a host network.', [s('vmnet')], { readOnly: true }),
  hostCommand('setPortForwarding', 'Add or update a host network port forwarding rule.', [s('vmnet'), e('protocol', ['tcp', 'udp']), n('host_port', 1, 65535), s('guest_ip'), n('guest_port', 1, 65535), s('description', { optional: true })]),
  hostCommand('deletePortForwarding', 'Delete a host network port forwarding rule.', [s('vmnet'), e('protocol', ['tcp', 'udp']), n('host_port', 1, 65535)]),
  guest('runProgramInGuest', 'Execute a program in the guest. This returns vmrun status, not guest stdout or a reliable guest program exit code.', [...programFlags, guestPath('program'), { name: 'arguments', type: 'strings', optional: true }]),
  guest('fileExistsInGuest', 'Check whether a guest file exists.', [guestPath('guest_path')], { readOnly: true }),
  guest('directoryExistsInGuest', 'Check whether a guest directory exists.', [guestPath('guest_path')], { readOnly: true }),
  vm('setSharedFolderState', 'Set a shared folder host path and write access.', [s('share_name'), host('host_path', 'directory'), e('access', ['writable', 'readonly'])]),
  vm('addSharedFolder', 'Add a host directory as a guest shared folder.', [s('share_name'), host('host_path', 'directory')], { destructive: false }),
  vm('removeSharedFolder', 'Remove a shared folder mapping.', [s('share_name')]),
  vm('enableSharedFolders', 'Enable shared folders; runtime_only avoids a persistent change.', [flag('runtime_only', 'runtime')]),
  vm('disableSharedFolders', 'Disable shared folders.'),
  guest('listProcessesInGuest', 'List guest processes.', [], { readOnly: true }),
  guest('killProcessInGuest', 'Terminate a guest process by process ID.', [n('pid', 1, Number.MAX_SAFE_INTEGER)]),
  guest('runScriptInGuest', 'Run script text with a guest interpreter. Redirect script output to a guest file and copy it back if output is needed.', [...programFlags, s('interpreter', { allowEmpty: true }), s('script', { allowNewlines: true })]),
  guest('deleteFileInGuest', 'Delete a guest file.', [guestPath('guest_path')]),
  guest('createDirectoryInGuest', 'Create a guest directory.', [guestPath('guest_path')], { destructive: false }),
  guest('deleteDirectoryInGuest', 'Delete a guest directory.', [guestPath('guest_path')]),
  guest('CreateTempfileInGuest', 'Create a temporary file in the guest.', [], { destructive: false }),
  guest('listDirectoryInGuest', 'List a guest directory.', [guestPath('guest_path')], { readOnly: true }),
  guest('CopyFileFromHostToGuest', 'Copy a local host file to a guest path. The destination may be overwritten by VMware.', [host('host_path', 'input-file'), guestPath('guest_path')]),
  guest('CopyFileFromGuestToHost', 'Copy a guest file to a local host path. Existing host files are protected unless overwrite=true.', [guestPath('guest_path'), host('host_path', 'output-file')]),
  guest('renameFileInGuest', 'Rename a guest file.', [guestPath('source_path'), guestPath('destination_path')]),
  guest('typeKeystrokesInGuest', 'Type text into the guest console.', [s('text', { allowNewlines: true })]),
  vm('connectNamedDevice', 'Connect a named virtual device.', [s('device_name')]),
  vm('disconnectNamedDevice', 'Disconnect a named virtual device.', [s('device_name')]),
  vm('captureScreen', 'Capture the VM display into a local file.', [host('host_path', 'output-file')]),
  vm('writeVariable', 'Write a VM runtimeConfig, guestEnv, or guestVar variable.', [e('scope', ['runtimeConfig', 'guestEnv', 'guestVar']), s('name'), s('value', { allowEmpty: true, allowNewlines: true })]),
  vm('readVariable', 'Read a VM runtimeConfig, guestEnv, or guestVar variable.', [e('scope', ['runtimeConfig', 'guestEnv', 'guestVar']), s('name')], { readOnly: true }),
  vm('getGuestIPAddress', 'Read the guest address reported by VMware Tools; optionally wait until available.', [flag('wait', '-wait')], { readOnly: true }),
  hostCommand('list', 'List running VMX paths.', [], { readOnly: true }),
  vm('upgradevm', 'Upgrade a VM virtual hardware/file format.'),
  vm('installTools', 'Start VMware Tools installation in the guest.'),
  vm('checkToolsState', 'Inspect VMware Tools state.', [], { readOnly: true }),
  vm('deleteVM', 'Delete the selected VM and its VMware-managed files. Requires explicit authorization for the exact VM.'),
  vm('clone', 'Create a full or linked clone of a VM, optionally from a named snapshot.', [host('destination_vmx', 'new-vmx'), e('clone_type', ['full', 'linked']), s('snapshot', { optional: true, prefix: '-snapshot=' }), s('clone_name', { optional: true, prefix: '-cloneName=' })]),
  hostCommand('downloadPhotonVM', 'Download a Photon template VM into a selected host directory.', [host('destination_path', 'destination-directory')]),
];

export const snake = value => value.replace(/VMs/g, 'Vms').replace(/IPs/g, 'Ips').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
export function commandSchema(command) {
  const shape = {};
  if (command.vmx) shape.vmx = z.string().min(1).describe('Absolute existing .vmx path.');
  for (const p of command.parameters) {
    let schema;
    if (p.type === 'string') schema = z.string().max(1024 * 1024).min(p.allowEmpty ? 0 : 1).refine(value => !value.includes('\0') && (p.allowNewlines || !/[\r\n]/.test(value)), 'Invalid control characters');
    else if (p.type === 'enum') schema = z.enum(p.values);
    else if (p.type === 'integer') schema = z.number().int().min(p.minimum).max(p.maximum);
    else if (p.type === 'boolean') schema = z.boolean();
    else schema = z.array(z.string().max(65536).refine(value => !value.includes('\0'))).max(256);
    if (p.optional) schema = schema.optional();
    if (p.default !== undefined) schema = schema.default(p.default);
    shape[p.name] = schema;
  }
  if (command.vmx) shape.vm_password_profile = z.string().optional().describe('Local encrypted-VM credential profile name; never a password.');
  if (command.vmx) shape.guest_profile = (command.guestAuth ? z.string().default('default') : z.string().optional()).describe('Local guest credential profile name; no passwords in tool arguments.');
  if (command.parameters.some(p => p.hostPath === 'output-file')) shape.overwrite = z.boolean().default(false);
  shape.timeout_seconds = z.number().int().min(1).max(3600).default(120);
  return z.object(shape).strict();
}

export async function executeCommand(backend, credentials, command, input) {
  const a = commandSchema(command).parse(input);
  const argv = [command.command];
  const resources = [];
  if (command.vmx) argv.push(await backend.vmx(a.vmx));
  if (command.vmx) resources.push(command.command === 'clone' ? path.dirname(argv[1]) : argv[1]);
  for (const p of command.parameters) {
    let value = a[p.name];
    if (value === undefined || (p.type === 'boolean' && !value)) continue;
    if (p.hostPath) {
      value = await backend.hostPath(value, p.hostPath, a.overwrite);
      if (!command.readOnly) resources.push(p.hostPath === 'new-vmx' ? path.dirname(value) : value);
    }
    if (p.flag) argv.push(p.flag);
    else if (p.prefix) argv.push(p.prefix + value);
    else if (p.type === 'strings') argv.push(...value);
    else argv.push(String(value));
  }
  const authentication = [];
  if (a.vm_password_profile) authentication.push('-vp', await credentials.vm(a.vm_password_profile));
  if (command.guestAuth || a.guest_profile) {
    const auth = await credentials.guest(a.guest_profile);
    authentication.push('-gu', auth.username, '-gp', auth.password);
  }
  const run = () => backend.run(argv, { mutation: !command.readOnly, authentication, timeout: a.timeout_seconds * 1000 });
  const output = command.readOnly || !backend.resources ? await run() : await backend.resources.use(resources, run);
  return { command: command.command, commandSucceeded: true, output: credentials.redact(output) };
}
