import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { findVMwareExecutable } from './host-platform.mjs';
import { isWithin, parseAssignments } from './workstation.mjs';
import { inspectArtifact, localName, machineRecords, probeMetadata } from './ovf-artifacts.mjs';

const text = z.string().min(1).max(1024).refine(value => !/[\x00-\x1f]/.test(value));
const mappingKey = z.string().min(1).max(256).refine(value => !/[=@\x00-\x1f]/.test(value));
const mappings = z.record(mappingKey, text).refine(value => Object.keys(value).length <= 64);
const timeout = z.number().int().min(1).max(86400).default(3600);
const source = text.describe('Absolute local OVF/OVA file path; URLs are not accepted.');
const options = {
  name: text.refine(value => { try { return localName(value) === value; } catch { return false; } }, 'VM name must be a safe single filename without encoded characters.').optional(), network_mappings: mappings.default({}), property_mappings: mappings.default({}),
  property_profile: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/i).optional().describe('Local credentials.json ovf_properties profile; use for sensitive deployment properties.'),
  deployment_option: text.optional(), accept_eulas: z.boolean().default(false), timeout_seconds: timeout,
};
export const ovfSchemas = {
  ovf_tool_status: z.object({}).strict(),
  ovf_inspect: z.object({ source, timeout_seconds: timeout }).strict(),
  ovf_validate: z.object({ source, timeout_seconds: timeout }).strict(),
  ovf_import: z.object({ source, directory: text.describe('NEW output directory; parent must exist.'), ...options, register: z.boolean().default(false), power_on: z.boolean().default(false) }).strict(),
  ovf_export: z.object({ vmx: text, destination: text.describe('Absolute .ova or .ovf output path. OVF requires a NEW parent directory.'), overwrite: z.boolean().default(false), timeout_seconds: timeout }).strict(),
  ovf_convert: z.object({ source: text.describe('Absolute local .ovf, .ova or .vmx source.'), destination: text.describe('Absolute .ovf, .ova or .vmx target. OVF/VMX require a NEW parent directory.'), overwrite: z.boolean().default(false), ...options }).strict(),
};
const limits = [
  'Only flat, local single-descriptor OVF/OVA packages are supported. No remote locators, linked references, compressed/chunked references or extra configuration passthrough.',
  'Snapshots are not exported. VMX sources with snapshots, saved state, locks, encryption or vTPM are refused; remove them using an appropriate workflow first.',
  'OVF Tool decides hardware/device support. VM identity, MACs, firmware/NVRAM, guest properties, LAN segments and host-specific settings may not round-trip. Compare the imported VM before booting.',
  'Validation checks local descriptor/schema and any supplied manifest checksums. It does not establish signer trust or compatibility with a remote host, guest boot or application readiness.',
];
const key = filename => process.platform === 'win32' ? filename.toLowerCase() : filename;
const exists = async filename => { try { return await fs.lstat(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
async function removeTemporary(directory, parent, prefix) {
  const actual = await fs.realpath(directory); const base = await fs.realpath(parent);
  if (!isWithin(base, actual) || actual === base || !path.basename(actual).startsWith(prefix) || (await fs.lstat(directory)).isSymbolicLink()) throw new Error('Temporary directory identity changed; retained for inspection.');
  await fs.rm(actual, { recursive: true, force: true });
}

export class OvfManager {
  constructor({ backend, credentials, jobs, rest, space = fs.statfs } = {}) {
    this.backend = backend; this.credentials = credentials; this.jobs = jobs; this.rest = rest; this.space = space;
  }
  async executable() {
    let beside;
    if (!this.backend.env.VMWARE_OVFTOOL_PATH) beside = await this.backend.executable().catch(() => undefined);
    return findVMwareExecutable('ovftool', { env: this.backend.env, beside });
  }
  async status() {
    let scratch;
    let executable;
    try {
      executable = await this.executable();
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-ovf-status-'));
      const config = path.join(scratch, 'empty.conf'); await fs.writeFile(config, '', { mode: 0o600 });
      const run = async args => {
        try { return (await this.backend.execute(executable, [`--configFile=${config}`, ...args], { cwd: scratch, env: { ...this.backend.env, HOME: scratch, USERPROFILE: scratch }, shell: false, windowsHide: true, timeout: 15000, encoding: 'utf8', maxBuffer: 1024 * 1024 })).stdout; }
        catch { throw new Error('Cannot read OVF Tool version/help. Check its installation and permissions.'); }
      };
      const version = (await run(['--version'])).trim(); const help = await run(['--help']); const debug = await run(['--help', 'debug']);
      const flags = ['machineOutput', 'schemaValidate', 'sourceType', 'targetType', 'hideEula', 'name', 'net', 'prop', 'deploymentOption', 'acceptAllEulas', 'configFile'];
      const supported = Object.fromEntries(flags.map(flag => [flag, new RegExp(`--${flag}\\b`).test(help)]));
      supported.noPrompting = debug.includes('--X:noPrompting');
      return { available: true, executable, executable_discovered: true, help_verified: true, live_support: 'unknown', configured_path: this.backend.env.VMWARE_OVFTOOL_PATH || null, version, supported_flags: supported, local_conversions: ['OVF/OVA → VMX', 'VMX → OVF/OVA', 'OVF/OVA → OVF/OVA'], limitations: limits };
    } catch (error) { return { available: false, executable: executable || null, executable_discovered: !!executable, help_verified: false, live_support: 'unknown', configured_path: this.backend.env.VMWARE_OVFTOOL_PATH || null, error: error.message, setting: 'VMWARE_OVFTOOL_PATH must be an absolute path to ovftool.exe (Windows) or ovftool (Linux).' }; }
    finally { if (scratch) await removeTemporary(scratch, os.tmpdir(), 'vmware-ovf-status-'); }
  }
  async available(required = []) {
    const status = await this.status();
    if (!status.available) throw new Error(status.error);
    const missing = ['machineOutput', 'sourceType', 'targetType', 'configFile', 'noPrompting', ...required].filter(flag => !status.supported_flags[flag]);
    if (missing.length) throw new Error(`Installed OVF Tool lacks required flags: ${missing.join(', ')}.`);
    return status;
  }
  async sourcePath(input) {
    return path.extname(input).toLowerCase() === '.vmx' ? this.backend.vmx(input) : this.backend.hostPath(input, 'input-file');
  }
  async start(operation, input) {
    const a = ovfSchemas[operation].parse(input);
    const inputPath = await this.sourcePath(a.source || a.vmx);
    const ext = path.extname(inputPath).slice(1).toLowerCase();
    if (!['ovf', 'ova', 'vmx'].includes(ext) || (['ovf_inspect', 'ovf_validate', 'ovf_import'].includes(operation) && ext === 'vmx')) throw new Error('This operation requires a local OVF/OVA appliance.');
    let destination; let directory; let target;
    if (operation === 'ovf_import') { directory = await this.backend.hostPath(a.directory, 'destination-directory'); destination = path.join(directory, 'machine.vmx'); target = 'vmx'; }
    else if (a.destination) {
      target = path.extname(a.destination).slice(1).toLowerCase();
      if (!['ovf', 'ova', 'vmx'].includes(target) || (ext === 'vmx' && target === 'vmx') || (operation === 'ovf_export' && target === 'vmx')) throw new Error('Supported targets are OVF/OVA, or VMX imported from OVF/OVA.');
      destination = await this.backend.hostPath(a.destination, 'output-file', a.overwrite);
      localName(path.basename(destination));
      directory = path.dirname(destination);
      // Imported VMX and its companion disks are VM destinations as well as host files.
      if (target === 'vmx') await this.backend.hostPath(directory, 'destination-directory');
    }
    if (destination) {
      if (key(destination) === key(inputPath) || (target !== 'ova' && isWithin(directory, inputPath))) throw new Error('Source must be outside the output directory.');
      if (target === 'ova') {
        await this.backend.hostPath(directory, 'directory');
        const original = await exists(a.destination || destination);
        if (original?.isSymbolicLink() || (original && !original.isFile())) throw new Error('OVA overwrite requires a regular file, never a link or directory.');
      } else {
        if (a.overwrite) throw new Error('Overwrite is supported only for a single OVA file. OVF/VMX companion files require a new output directory.');
        if (await exists(directory)) throw new Error('OVF/VMX output directory must be NEW to protect companion files.');
        await this.backend.hostPath(path.dirname(directory), 'directory');
      }
    }
    const status = await this.available(operation === 'ovf_validate' ? ['schemaValidate', 'hideEula'] : ['hideEula']);
    return this.jobs.start({ operation, resources: [path.dirname(inputPath), ...(directory ? [directory] : [])], artifacts: destination ? [destination, directory] : [], timeout: a.timeout_seconds * 1000,
      task: context => this.backend.resources.use([ext === 'vmx' ? path.dirname(inputPath) : inputPath, ...(directory ? [directory] : [])], () => this.perform(operation, { ...a, source: inputPath, destination, directory, target, ext }, status, context)) });
  }
  async vmSource(vmx) {
    vmx = await this.backend.vmx(vmx);
    const config = Object.fromEntries(Object.entries(parseAssignments(await fs.readFile(vmx, 'utf8'))).map(([key, value]) => [key.toLowerCase(), value]));
    if (config['.encoding'] && !/^utf-?8$/i.test(config['.encoding'])) throw new Error('VMX export preflight supports UTF-8 configurations only. Convert the encoding explicitly before exporting.');
    if ((await this.backend.details(vmx)).running) throw new Error('Power off the VM before exporting.');
    const entries = await fs.readdir(path.dirname(vmx));
    if (entries.some(name => /\.(lck|vmss|vmem|vmsn)$/i.test(name)) || config['checkpoint.vmstate'] || config['suspend.filename']) throw new Error('Locked/suspended VM sources are unsupported. Fully power off and close the VM.');
    if (Object.entries(config).some(([name, value]) => (/^encryption\./.test(name) && value) || (/^vtpm\./.test(name) && value.toLowerCase() !== 'false'))) throw new Error('Encrypted VM/vTPM exports are unsupported.');
    if ((await this.backend.snapshots(vmx)).snapshots.length) throw new Error('Snapshot sources are unsupported. Export a separately prepared VM without snapshots.');
    // Check host-file backings and VMDK extents without following them outside the VM directory.
    let size = (await fs.stat(vmx)).size;
    const inspectFile = async input => {
      const file = await this.backend.hostPath(input, 'input-file');
      if (!isWithin(path.dirname(vmx), file)) throw new Error('VM export backings must remain inside the VM directory. External disks/media are unsupported.');
      size += (await fs.stat(file)).size;
      return file;
    };
    for (const name of ['workingdir', 'snapshot.directory']) if (config[name]) {
      const directory = await this.backend.hostPath(path.resolve(path.dirname(vmx), config[name]), 'directory');
      if (!isWithin(path.dirname(vmx), directory)) throw new Error('External VM working/snapshot directories are unsupported.');
    }
    if (Object.keys(config).some(name => /^(bios440|efi32|efi64)\.filename$/.test(name))) throw new Error('Custom firmware file backings are unsupported.');
    for (const [name, value] of Object.entries(config)) if ((/\.filename$/.test(name) || ['nvram', 'extendedconfigfile'].includes(name)) && value && config[name.replace(/filename$/, 'present')]?.toLowerCase() !== 'false') {
      if (value.toLowerCase() === 'auto detect') continue;
      const file = await inspectFile(path.resolve(path.dirname(vmx), value));
      if (path.extname(file).toLowerCase() === '.vmdk') {
        const handle = await fs.open(file, 'r'); let header;
        try { const buffer = Buffer.alloc(1024 * 1024); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); header = buffer.subarray(0, bytesRead).toString('latin1'); } finally { await handle.close(); }
        const diskType = header.match(/createType\s*=\s*"([^"]+)"/i)?.[1];
        if (/parentFileNameHint\s*=|parentCID\s*=\s*(?!ffffffff)[a-f0-9]{8}/i.test(header) || !/^(monolithicSparse|monolithicFlat|twoGbMaxExtentSparse|twoGbMaxExtentFlat|streamOptimized)$/i.test(diskType || '')) throw new Error('Snapshot/linked/raw or unrecognized VMDK backings are unsupported.');
        for (const extent of header.matchAll(/(?:^|\n)(?:RW|RDONLY|NOACCESS)\s+\d+\s+\w+\s+"([^"]+)"/g)) await inspectFile(path.resolve(path.dirname(file), extent[1]));
      }
    }
    return { source: vmx, size, manifest: 'not applicable' };
  }
  async propertyValues(a) {
    const values = { ...(a.property_mappings || {}) };
    if (Object.keys(values).some(name => /password|secret|token/i.test(name))) throw new Error('Sensitive deployment properties must use a local property_profile, not property_mappings in tool arguments.');
    if (a.property_profile) {
      const profile = this.credentials.profile(a.property_profile);
      const file = await this.credentials.load(); const stored = file.ovf_properties?.[profile];
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('OVF property profile is not configured in the local credentials file.');
      const parsed = mappings.parse(stored);
      for (const value of Object.values(parsed)) this.credentials.remember(value);
      Object.assign(values, parsed);
    }
    return values;
  }
  async perform(operation, a, status, context) {
    const { signal } = context;
    const sourceInfo = a.ext === 'vmx' ? await this.vmSource(a.source) : await inspectArtifact(this.backend, a.source, { signal });
    const properties = await this.propertyValues(a);
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-ovf-'));
    const config = path.join(scratch, 'empty.conf'); await fs.writeFile(config, '', { mode: 0o600 });
    // Isolate default configuration discovery from host/user/source .ovftool files.
    const env = { ...this.backend.env, HOME: scratch, USERPROFILE: scratch };
    let staging; let committed = false;
    try {
      const common = [`--configFile=${config}`, '--machineOutput', '--X:noPrompting', '--hideEula', `--sourceType=${a.ext.toUpperCase()}`];
      const probe = await context.run(status.executable, [...common, ...(operation === 'ovf_validate' ? ['--schemaValidate'] : []), a.source], { cwd: scratch, env, logOutput: false, progress: 'ovf', allowNonzero: true });
      const records = machineRecords(probe.output);
      const success = probe.code === 0 && records.some(record => record.type === 'RESULT' && record.payload === 'SUCCESS');
      if (!success) throw new Error(`OVF Tool ${operation === 'ovf_validate' ? 'validation' : 'probe'} failed. ${this.failure(probe.output)}`);
      const metadata = probeMetadata(probe.output);
      context.log('OVF Tool probe succeeded. Metadata is available in job_status.result; raw property defaults are omitted from logs.\n');
      const warnings = records.filter(record => record.type === 'WARNING').map(record => record.payload);
      if (!a.destination) return { source: a.source, valid: operation === 'ovf_validate' ? true : undefined, manifest: sourceInfo.manifest, metadata, warnings, limitations: limits };
      for (const [field, flag] of [['name', 'name'], ['deployment_option', 'deploymentOption']]) if (a[field] && !status.supported_flags[flag]) throw new Error(`Installed OVF Tool does not support ${field}.`);
      if (Object.keys(a.network_mappings || {}).length && !status.supported_flags.net) throw new Error('Installed OVF Tool does not support network mappings.');
      if (Object.keys(properties).length && !status.supported_flags.prop) throw new Error('Installed OVF Tool does not support property mappings.');
      if (a.accept_eulas && !status.supported_flags.acceptAllEulas) throw new Error('Installed OVF Tool does not support explicit EULA acceptance.');
      const parent = a.target === 'ova' ? a.directory : path.dirname(a.directory);
      const flat = Number(metadata.sizes?.flat);
      if (!Number.isSafeInteger(flat) || flat < 0) throw new Error('Cannot determine the flat disk size for a conservative destination free-space check.');
      // Exclusive OVA publication copies the staged archive before cleanup;
      // replacement uses rename, while OVF/VMX write directly into new directories.
      const copies = a.target === 'ova' && !a.overwrite ? 2 : 1;
      const estimate = (Math.max(sourceInfo.size, flat) * 1.1 + 64 * 1024 * 1024) * copies;
      const capacity = await this.space(parent); const available = Number(capacity.bavail) * Number(capacity.bsize);
      if (!Number.isFinite(available) || !Number.isSafeInteger(Math.ceil(estimate)) || available < estimate) throw new Error('Insufficient or unknown destination free space for conservative OVF transfer estimate.');
      signal.throwIfAborted();
      let output;
      if (a.target === 'ova') { staging = await fs.mkdtemp(path.join(a.directory, '.ovf-job-')); output = path.join(staging, path.basename(a.destination)); }
      else { await fs.mkdir(a.directory); output = a.destination; }
      context.artifact(staging || a.directory);
      await context.checkpoint({ transfer_started: false, destination: a.destination, staging: staging || null });
      const args = [...common, `--targetType=${a.target.toUpperCase()}`];
      if (a.name) args.push(`--name=${a.name}`);
      if (a.deployment_option) args.push(`--deploymentOption=${a.deployment_option}`);
      if (a.accept_eulas) args.push('--acceptAllEulas');
      for (const [name, value] of Object.entries(a.network_mappings || {})) args.push(`--net:${name}=${value}`);
      for (const [name, value] of Object.entries(properties)) args.push(`--prop:${name}=${value}`);
      // Recheck power/lock/snapshot state immediately before the transfer.
      if (a.ext === 'vmx') await this.vmSource(a.source);
      const converted = await context.run(status.executable, [...args, a.source, output], { cwd: scratch, env, progress: 'ovf', allowNonzero: true });
      const final = machineRecords(converted.output);
      if (converted.code !== 0 || !final.some(record => record.type === 'RESULT' && record.payload === 'SUCCESS')) throw new Error(`OVF Tool transfer failed. Partial files may remain at ${staging || a.directory}. ${this.failure(converted.output)}`);
      signal.throwIfAborted();
      let resultPath = output;
      if (a.target === 'vmx') {
        const targetID = final.find(record => record.type === 'TARGET_ID')?.payload;
        if (!targetID) throw new Error('OVF Tool did not identify its imported VMX. Inspect the output directory.');
        resultPath = await this.backend.vmx(path.resolve(scratch, targetID));
        if (!isWithin(a.directory, resultPath)) throw new Error('Imported VMX is outside its reserved destination.');
      } else {
        if (!(await fs.stat(output)).isFile()) throw new Error('OVF Tool reported success but the output file is missing.');
        if (a.target === 'ova') {
          if (a.overwrite) { await fs.rename(output, a.destination); }
          else { await fs.copyFile(output, a.destination, (await import('node:fs')).constants.COPYFILE_EXCL); }
          resultPath = a.destination; committed = true;
        }
      }
      let registered = false; let poweredOn = false;
      context.log(`\nTransfer succeeded at ${resultPath}\n`);
      try {
        if (a.register) {
          if (!this.rest) throw new Error('Registration requires configured Workstation REST.');
          signal.throwIfAborted(); await this.rest.request('POST', '/api/vms/registration', { body: { name: a.name || path.basename(resultPath, '.vmx'), path: resultPath } }); registered = true;
        }
        if (a.power_on) { signal.throwIfAborted(); await this.backend.power(resultPath, 'start', 'soft', false); poweredOn = true; }
      } catch (error) { throw new Error(`Transfer succeeded at ${resultPath}; post-import action failed. Registration confirmed: ${registered}; power-on confirmed: ${poweredOn}. ${error.message} No rollback was attempted.`); }
      return { source: a.source, destination: resultPath, output_directory: a.directory, registered, powered_on: poweredOn, manifest: sourceInfo.manifest, warnings: [...warnings, ...final.filter(record => record.type === 'WARNING').map(record => record.payload)], limitations: limits, note: 'Transfer completed. Optional registration/power results do not establish guest readiness.' };
    } finally {
      // Only these plugin-created temporary directories are removed; partial VM/OVF outputs remain for inspection.
      await removeTemporary(scratch, os.tmpdir(), 'vmware-ovf-');
      if (staging && committed) await removeTemporary(staging, a.directory, '.ovf-job-');
      else if (staging) context.log(`\nUncommitted output retained at ${staging}\n`);
    }
  }
  failure(output) {
    const errors = machineRecords(output).filter(record => ['ERROR', 'WARNING'].includes(record.type));
    return errors.length ? errors.map(record => record.payload).join('\n').slice(0, 4000) : 'No successful machine-mode result. Inspect job_logs and the output directory.';
  }
}
