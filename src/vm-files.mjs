import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseAssignments } from './workstation.mjs';
import { findVMwareExecutable } from './host-platform.mjs';

export const createVMSchema = z.object({
  directory: z.string().min(1).describe('Absolute NEW VM directory; its parent must exist. Existing directories are never overwritten.'),
  name: z.string().min(1).max(128).refine(value => !/[\x00-\x1f]/.test(value)),
  guest_os: z.string().min(1).max(128).default('otherlinux-64'),
  memory_mb: z.number().int().min(256).max(1048576).multipleOf(4).default(2048),
  cpus: z.number().int().min(1).max(128).default(2),
  disk_gb: z.number().int().min(1).max(8192).default(20),
  hardware_version: z.number().int().min(10).max(99).default(21),
  firmware: z.enum(['bios', 'efi']).default('bios'),
  network: z.enum(['nat', 'bridged', 'hostonly', 'custom', 'none']).default('nat'),
  vmnet: z.string().optional(),
  iso_path: z.string().optional().describe('Optional existing host ISO file. Creating a VM does not install a guest OS.'),
  timeout_seconds: z.number().int().min(1).max(3600).default(120),
}).strict().refine(a => a.network !== 'custom' || !!a.vmnet, 'Custom networking requires vmnet.');

export const configureVMSchema = z.object({
  vmx: z.string().min(1),
  settings: z.record(z.string().regex(/^[A-Za-z_.][A-Za-z0-9_.:-]{0,127}$/), z.string().max(65536).nullable()).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 128, 'Provide 1 to 128 VMX settings; null removes a setting.'),
}).strict();

export const encodeVMX = value => String(value).replace(/\|/g, '|7C').replace(/"/g, '|22').replace(/\r/g, '|0D').replace(/\n/g, '|0A');

export class VMFiles {
  constructor(backend, { protectSensitiveFile } = {}) { this.backend = backend; this.protectSensitiveFile = protectSensitiveFile; this.tail = Promise.resolve(); }
  exclusive(callback) {
    const job = this.tail.then(callback); this.tail = job.catch(() => {}); return job;
  }
  async create(input) {
    const a = createVMSchema.parse(input);
    return this.exclusive(async () => {
      const directory = await this.backend.hostPath(a.directory, 'destination-directory');
      const iso = a.iso_path ? await this.backend.hostPath(a.iso_path, 'input-file') : null;
      const vmrun = await this.backend.executable();
      const diskManager = await findVMwareExecutable('vmware-vdiskmanager', { env: this.backend.env, beside: vmrun });
      await fs.mkdir(directory); // Deliberately fails on an existing directory.
      const vmx = path.join(directory, 'machine.vmx');
      const disk = path.join(directory, 'disk.vmdk');
      try {
        await this.backend.execute(diskManager, ['-c', '-s', `${a.disk_gb}GB`, '-a', 'lsilogic', '-t', '0', disk], { windowsHide: true, shell: false, timeout: a.timeout_seconds * 1000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
        if (!(await fs.stat(disk)).isFile()) throw new Error('Disk manager did not create the VMDK.');
        const settings = {
          '.encoding': 'UTF-8', 'config.version': '8', 'virtualHW.version': String(a.hardware_version),
          displayName: a.name, guestOS: a.guest_os, memsize: String(a.memory_mb), numvcpus: String(a.cpus),
          'cpuid.coresPerSocket': '1', firmware: a.firmware,
          'scsi0.present': 'TRUE', 'scsi0.virtualDev': 'lsilogic',
          'scsi0:0.present': 'TRUE', 'scsi0:0.fileName': 'disk.vmdk',
          'ethernet0.present': a.network === 'none' ? 'FALSE' : 'TRUE',
          'ethernet0.virtualDev': 'e1000', 'ethernet0.addressType': 'generated',
          'floppy0.present': 'FALSE', 'sound.present': 'FALSE', 'usb.present': 'FALSE',
        };
        if (a.network !== 'none') settings['ethernet0.connectionType'] = a.network;
        if (a.network === 'custom') settings['ethernet0.vnet'] = a.vmnet;
        if (iso) Object.assign(settings, { 'sata0.present': 'TRUE', 'sata0:0.present': 'TRUE', 'sata0:0.deviceType': 'cdrom-image', 'sata0:0.fileName': iso });
        const text = Object.entries(settings).map(([key, value]) => `${key} = "${encodeVMX(value)}"`).join('\n') + '\n';
        await fs.writeFile(vmx, text, { flag: 'wx', encoding: 'utf8' });
        return { created: true, vmx, disk, directory, registered: false, poweredOn: false, guestOSInstalled: false, note: 'Blank VM and sparse disk created. Open the VMX in Workstation or register through REST; install a guest OS separately.' };
      } catch (error) {
        throw new Error(`VM creation failed (${error.code || 'disk/configuration error'}). Partial files may remain in ${directory}; inspect before retrying. No existing VM was overwritten.`);
      }
    });
  }
  async configure(input, { protectFile, expectedOriginal, beforeCommit } = {}) {
    const a = configureVMSchema.parse(input);
    const vmx = await this.backend.vmx(a.vmx);
    return this.backend.resources.use([vmx], async () => {
      const details = await this.backend.details(vmx);
      if (details.running) throw new Error('Power off the VM before editing its VMX.');
      const lock = `${vmx}.lck`;
      try { await fs.access(lock); throw new Error('VMware holds a VMX lock; close or power off the VM before editing.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const original = await fs.readFile(vmx, 'utf8');
      if (expectedOriginal !== undefined && original !== expectedOriginal) throw new Error('VMX changed before editing; inspect and retry.');
      const config = parseAssignments(original);
      const sensitiveKeys = Object.entries(config).some(([key, value]) => /^remotedisplay\.vnc\.(password|key)$/i.test(key) && value) || Object.entries(a.settings).some(([key, value]) => /^remotedisplay\.vnc\.(password|key)$/i.test(key) && value);
      if (!protectFile && sensitiveKeys) protectFile = this.protectSensitiveFile;
      if (config['.encoding'] && !/^utf-?8$/i.test(config['.encoding'])) throw new Error('Local VMX editing supports UTF-8 only. Use REST or convert the VMX encoding explicitly.');
      for (const value of [config['checkpoint.vmState'], config['suspend.filename']].filter(Boolean)) {
        try { await fs.access(path.resolve(path.dirname(vmx), value)); throw new Error('VM has a saved/suspended state; fully power it off before editing hardware.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const updates = new Map();
      for (const [key, value] of Object.entries(a.settings)) {
        if (updates.has(key.toLowerCase())) throw new Error('Duplicate VMX setting names differ only by case.');
        if (value?.includes('\0')) throw new Error('VMX settings cannot contain NUL.');
        if (key.toLowerCase() === '.encoding' && value !== 'UTF-8') throw new Error('The .encoding setting must remain UTF-8.');
        updates.set(key.toLowerCase(), { key, value });
      }
      const lines = [];
      const seen = new Set();
      for (const line of original.split(/\r?\n/)) {
        const key = line.match(/^\s*([A-Za-z_.][A-Za-z0-9_.:-]*)\s*=/)?.[1]?.toLowerCase();
        if (!updates.has(key)) { lines.push(line); continue; }
        const update = updates.get(key);
        if (!seen.has(key) && update.value !== null) lines.push(`${update.key} = "${encodeVMX(update.value)}"`);
        seen.add(key);
      }
      for (const [key, update] of updates) if (!seen.has(key) && update.value !== null) lines.push(`${update.key} = "${encodeVMX(update.value)}"`);
      const mode = (await fs.stat(vmx)).mode & 0o777;
      if (beforeCommit) await beforeCommit();
      const backup = `${vmx}.backup-${randomUUID()}`;
      if (protectFile) {
        await fs.writeFile(backup, '', { flag: 'wx', mode: 0o600 }); await protectFile(backup); await fs.writeFile(backup, original);
      } else await fs.copyFile(vmx, backup, constants.COPYFILE_EXCL);
      const temporary = `${vmx}.edit-${randomUUID()}`;
      if (protectFile) { await fs.writeFile(temporary, '', { flag: 'wx', mode: 0o600 }); await protectFile(temporary); }
      await fs.writeFile(temporary, lines.join('\n').replace(/\n*$/, '\n'), { flag: protectFile ? 'w' : 'wx', mode });
      // Detect another writer after we read the original before replacing it.
      if (await fs.readFile(vmx, 'utf8') !== original) { await fs.unlink(temporary); throw new Error(`VMX changed during editing; original retained. Backup: ${backup}`); }
      if (beforeCommit) {
        try { await beforeCommit(); } catch (error) { await fs.unlink(temporary); throw error; }
      }
      await fs.rename(temporary, vmx);
      return { vmx, updated: true, backup, changedSettings: Object.keys(a.settings), note: 'VMX saved while VM was not running and had no detected saved state/VMX lock. Close/reopen its Workstation tab if it has cached settings.' };
    });
  }
}
