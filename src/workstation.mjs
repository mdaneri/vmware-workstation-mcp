import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { inventoryPath, findVMwareExecutable } from './host-platform.mjs';
import { Resources } from './resources.mjs';

const execute = promisify(execFile);

export function parseAssignments(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.:-]+)\s*=\s*"(.*)"\s*$/);
    if (match) values[match[1]] = match[2].replace(/\|([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return values;
}

export function parseCountedList(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length || !/:\s*\d+$/.test(lines[0])) throw new Error('Unrecognized vmrun list output; refusing to infer an empty list.');
  const count = Number(lines.shift().match(/(\d+)$/)[1]);
  if (count !== lines.length) throw new Error('vmrun list count does not match its output.');
  return lines;
}

export function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export class Workstation {
  constructor({ env = process.env, run = execute } = {}) {
    this.env = env;
    this.execute = run;
    this.tail = Promise.resolve();
    this.inventoryPath = inventoryPath(env);
    this.resources = new Resources();
  }

  async executable() {
    return findVMwareExecutable('vmrun', { env: this.env });
  }

  async run(args, { mutation = false, authentication = [], timeout = 120000 } = {}) {
    if (mutation && args[1] && path.isAbsolute(args[1])) this.resources.assert([args[1]]);
    const job = this.tail.then(async () => {
      if (mutation && args[1] && path.isAbsolute(args[1])) this.resources.assert([args[1]]);
      const binary = await this.executable();
      try {
        const result = await this.execute(binary, ['-T', 'ws', ...authentication, ...args], {
          windowsHide: true, shell: false, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8',
        });
        return result.stdout.trim();
      } catch (error) {
        const details = [error.stderr, error.stdout].filter(Boolean).join('\n').trim().slice(0, 4000);
        const uncertain = mutation ? ' The operation may have taken effect; inspect the VM before retrying.' : '';
        throw new Error(`vmrun ${args[0] || 'help'} failed (${error.killed ? 'timeout' : error.code || 'unknown error'}).${uncertain}${details ? ` ${details}` : ''}`);
      }
    });
    this.tail = job.catch(() => {});
    return job;
  }

  async help() {
    const binary = await this.executable();
    const options = { windowsHide: true, shell: false, timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8' };
    try { return (await this.execute(binary, [], options)).stdout; } catch (error) {
      const output = [error.stdout, error.stderr].filter(Boolean).join('\n');
      if (/vmrun version [\w.]+/.test(output) && output.includes('Usage: vmrun')) return output;
      throw new Error('Cannot read installed vmrun help. Check vmrun installation and access.');
    }
  }

  async hostPath(input, kind, overwrite = false) {
    if (typeof input !== 'string' || !path.isAbsolute(input) || /[\x00-\x1f]/.test(input)) throw new Error('Host paths must be absolute and contain no control characters.');
    const absolute = path.resolve(input);
    let stat;
    try { stat = await fs.stat(absolute); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (kind === 'input-file' && !stat?.isFile()) throw new Error('Host source must be an existing file.');
    if (kind === 'directory' && !stat?.isDirectory()) throw new Error('Host directory must already exist.');
    if (kind === 'new-vmx' && (stat || path.extname(absolute).toLowerCase() !== '.vmx')) throw new Error('Clone destination must be a new .vmx file.');
    if (kind === 'output-file' && (stat?.isDirectory() || (stat && !overwrite))) throw new Error('Host destination exists; choose another file or explicitly set overwrite=true.');
    if (['destination-directory', 'host-destination-directory'].includes(kind) && stat && !stat.isDirectory()) throw new Error('Destination must be a directory path.');
    let ancestor = absolute;
    const missing = [];
    while (true) {
      try { ancestor = await fs.realpath(ancestor); break; } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const entry = await fs.lstat(ancestor).catch(missingError => { if (missingError.code !== 'ENOENT') throw missingError; return null; });
        if (entry?.isSymbolicLink()) throw new Error('Destination contains a dangling link.');
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        missing.unshift(path.basename(ancestor)); ancestor = parent;
      }
    }
    const resolved = path.join(ancestor, ...missing);
    const rootSetting = kind === 'new-vmx' || kind === 'destination-directory' ? this.env.VMWARE_ALLOWED_ROOTS : this.env.VMWARE_ALLOWED_HOST_ROOTS;
    if (rootSetting) {
      const roots = rootSetting.split(path.delimiter).filter(Boolean);
      if (!roots.length || roots.some(root => !path.isAbsolute(root))) throw new Error('Allowed host roots must be absolute.');
      const canonical = await Promise.all(roots.map(root => fs.realpath(root)));
      if (!canonical.some(root => isWithin(root, resolved))) throw new Error('Host path is outside the configured allowed roots.');
    }
    return resolved;
  }

  async vmx(input) {
    if (typeof input !== 'string' || !path.isAbsolute(input) || path.extname(input).toLowerCase() !== '.vmx' || /[\x00-\x1f]/.test(input)) throw new Error('Provide an absolute path to an existing .vmx file.');
    const resolved = await fs.realpath(input);
    if (path.extname(resolved).toLowerCase() !== '.vmx' || !(await fs.stat(resolved)).isFile()) throw new Error('VM target must resolve to a .vmx file.');
    if (this.env.VMWARE_ALLOWED_ROOTS) {
      const roots = this.env.VMWARE_ALLOWED_ROOTS.split(path.delimiter).filter(Boolean);
      if (!roots.length || roots.some(root => !path.isAbsolute(root))) throw new Error('VMWARE_ALLOWED_ROOTS must contain absolute directories.');
      const canonicalRoots = await Promise.all(roots.map(root => fs.realpath(root)));
      if (!canonicalRoots.some(root => isWithin(root, resolved))) throw new Error('VM is outside VMWARE_ALLOWED_ROOTS.');
    }
    return resolved;
  }

  async status() {
    const executable = await this.executable();
    const running = parseCountedList(await this.run(['list']));
    return { executable, inventoryPath: this.inventoryPath, runningCount: running.length, allowedRoots: this.env.VMWARE_ALLOWED_ROOTS || null, transport: 'local stdio' };
  }

  async resolveVM(vmID, { aliases = {}, restInventory } = {}) {
    if (typeof vmID !== 'string' || !vmID.trim() || /[\x00-\x1f]/.test(vmID)) throw new Error('Provide a VMX path, unique inventory name, console profile alias, or REST VM ID.');
    if (path.isAbsolute(vmID)) return this.vmx(vmID);
    if (Object.hasOwn(aliases, vmID)) return this.vmx(aliases[vmID]);
    const { vms } = await this.listVMs();
    const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
    const matches = vms.filter(vm => [vm.displayName, path.basename(vm.vmx, '.vmx')].some(name => normalize(name) === normalize(vmID)));
    if (matches.length > 1) throw new Error('VM name is ambiguous. Use the exact VMX path.');
    if (matches.length === 1) return this.vmx(matches[0].vmx);
    if (restInventory) {
      const records = await restInventory();
      const record = records.find(vm => vm.id === vmID);
      if (record?.path) return this.vmx(record.path);
    }
    throw new Error('VM was not found. Use an absolute VMX path or a unique configured console alias.');
  }

  async listVMs() {
    const running = parseCountedList(await this.run(['list']));
    let entries = {};
    const warnings = [];
    try { entries = parseAssignments(await fs.readFile(this.inventoryPath, 'utf8')); } catch (error) {
      warnings.push(`Inventory unavailable (${error.code || error.message}); showing running VMs only.`);
    }
    const key = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
    const records = new Map();
    for (const [name, vmx] of Object.entries(entries)) {
      if (/^vmlist\d+\.config$/.test(name) && vmx && path.extname(vmx).toLowerCase() === '.vmx') {
        records.set(key(vmx), { vmx, displayName: entries[name.replace(/\.config$/, '.DisplayName')] || path.basename(vmx, path.extname(vmx)), registered: true, running: false });
      }
    }
    for (const vmx of running) {
      const record = records.get(key(vmx)) || { vmx, displayName: path.basename(vmx, path.extname(vmx)), registered: false };
      records.set(key(vmx), { ...record, running: true });
    }
    const vms = await Promise.all([...records.values()].map(async record => {
      try { await fs.access(record.vmx); return { ...record, exists: true }; } catch { return { ...record, exists: false }; }
    }));
    return { vms, warnings, note: 'running=false does not distinguish powered off, suspended, or unavailable VMs. Inventory is not a disk scan.' };
  }

  async details(input) {
    const vmx = await this.vmx(input);
    const config = parseAssignments(await fs.readFile(vmx, 'utf8'));
    const running = parseCountedList(await this.run(['list']));
    const realRunning = await Promise.all(running.map(async file => fs.realpath(file).catch(() => file)));
    const compare = file => process.platform === 'win32' ? file.toLowerCase() : file;
    const hardware = Object.fromEntries(Object.entries(config).filter(([key]) => /^(displayName|guestOS|memsize|numvcpus|virtualHW.version|ethernet\d+\.(present|connectionType|vnet)|(?:scsi|sata|ide|nvme)\d+:\d+\.(present|fileName|deviceType))$/.test(key)));
    return { vmx, running: realRunning.some(file => compare(file) === compare(vmx)), hardware };
  }

  async power(input, action, mode = 'soft', gui = false) {
    if (!['start', 'stop', 'reset', 'suspend', 'pause', 'unpause'].includes(action)) throw new Error('Unsupported power action.');
    if (!['soft', 'hard'].includes(mode)) throw new Error('Power mode must be soft or hard.');
    const vmx = await this.vmx(input);
    const args = [action, vmx];
    if (action === 'start') args.push(gui ? 'gui' : 'nogui');
    if (['stop', 'reset', 'suspend'].includes(action)) args.push(mode);
    const output = await this.run(args, { mutation: true });
    return { vmx, action, output, commandSucceeded: true, note: 'vmrun returned successfully; guest application readiness is not established.' };
  }

  async snapshots(input) {
    const vmx = await this.vmx(input);
    return { vmx, snapshots: parseCountedList(await this.run(['listSnapshots', vmx])) };
  }

  async snapshot(input, action, name) {
    if (!['snapshot', 'revertToSnapshot', 'deleteSnapshot'].includes(action)) throw new Error('Unsupported snapshot action.');
    if (typeof name !== 'string' || !name.trim() || name.length > 256 || /[\x00-\x1f]/.test(name)) throw new Error('Provide a nonblank snapshot name of at most 256 characters without control characters.');
    const vmx = await this.vmx(input);
    if (action !== 'snapshot') {
      const { snapshots } = await this.snapshots(vmx);
      if (snapshots.filter(value => value === name).length !== 1) throw new Error('Snapshot name must identify exactly one existing snapshot; inspect the snapshot tree in Workstation if ambiguous.');
    }
    return { vmx, action, name, output: await this.run([action, vmx, name], { mutation: true }), commandSucceeded: true };
  }

  async guestIP(input) {
    const vmx = await this.vmx(input);
    const address = (await this.run(['getGuestIPAddress', vmx])).trim();
    if (!isIP(address)) throw new Error('vmrun did not return a valid guest IP address. The VM must be running with VMware Tools available.');
    return { vmx, address };
  }
}
