import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { preferencesPath } from './host-platform.mjs';

const vmx = z.string().min(1).describe('Absolute VMX path. Adapter changes require a powered-off, unlocked UTF-8 VM.');
const segment = z.string().min(1).max(256).describe('LAN segment name or pvnID returned by list_lan_segments. Use the ID if names are ambiguous.');
const adapter = z.number().int().min(0).max(255).describe('Zero-based VMX adapter index: 0 means ethernet0, not the REST NIC index.');
export const lanSegmentSchemas = {
  list_lan_segments: z.object({ vmx: vmx.optional() }).strict(),
  create_lan_segment: z.object({ name: z.string().min(1).max(256).refine(value => value === value.trim() && !/[\p{Cc}\p{Cs}]/u.test(value), 'Use a nonblank name without control characters or surrounding whitespace.') }).strict(),
  remove_lan_segment: z.object({ segment, vmx_paths: z.array(vmx).max(1024).default([]).describe('Additional unregistered VMX files to check for references. Registered and running VMs are always checked; detach references before removal.') }).strict(),
  attach_vm_adapter_to_lan_segment: z.object({ vmx, adapter, segment }).strict(),
  detach_vm_adapter_from_lan_segment: z.object({
    vmx, adapter, segment,
    network: z.enum(['nat', 'bridged', 'hostonly', 'custom']).default('nat').describe('Replacement network mode. The adapter is left disconnected with startConnected=FALSE.'),
    vmnet: z.string().regex(/^vmnet\d{1,3}$/).optional().describe('Required only for the custom replacement network.'),
  }).strict(),
};

const idPattern = /^(?:[0-9a-f]{2} ){7}[0-9a-f]{2}-(?:[0-9a-f]{2} ){7}[0-9a-f]{2}$/i;
const namespace = /^pref\.namedpvns(?:\.|\d+\.)/i;
const assignment = /^\s*([\w.:-]+)\s*=\s*"([^"\r\n]*)"\s*$/;
const unescapeBytes = value => value.replace(/\|([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
const idKey = id => id.toLowerCase();

function codec(label) {
  if (!/^(utf-?8|windows-1252)$/i.test(label)) throw new Error('LAN segment preferences support UTF-8 and windows-1252 only; refusing to transcode this preferences file.');
  const utf8 = /^utf-?8$/i.test(label);
  const decoder = new TextDecoder(utf8 ? 'utf-8' : 'windows-1252', { fatal: true });
  const table = utf8 ? null : new Map(Array.from({ length: 256 }, (_, byte) => [decoder.decode(Uint8Array.of(byte)), byte]));
  return {
    decode: raw => decoder.decode(Buffer.from(unescapeBytes(raw), 'latin1')),
    encode: value => {
      const bytes = utf8 ? Buffer.from(value, 'utf8') : Buffer.from([...value].map(char => {
        if (!table.has(char)) throw new Error('The segment name cannot be represented in windows-1252; use a representable name.');
        return table.get(char);
      }));
      return [...bytes].map(byte => byte === 34 || byte === 124 || byte < 32 ? `|${byte.toString(16).padStart(2, '0').toUpperCase()}` : String.fromCharCode(byte)).join('');
    },
  };
}

// Parse only the catalog namespace; unrelated preference bytes are never decoded/re-encoded.
export function parseLanPreferences(bytes, defaultEncoding = 'UTF-8') {
  const raw = bytes.toString('latin1');
  const lines = raw.match(/[^\r\n]*(?:\r\n|\n|$)/g).filter(Boolean);
  const entries = lines.map(line => line.replace(/[\r\n]+$/, '').replace(/^\xef\xbb\xbf/, ''));
  const encodingLines = entries.filter(line => /^\s*\.encoding\b/i.test(line));
  if (encodingLines.length > 1 || (encodingLines.length && !encodingLines[0].match(assignment))) throw new Error('Malformed or duplicate preferences encoding.');
  const encoding = encodingLines[0]?.match(assignment)?.[2] || defaultEncoding;
  const encodingCodec = codec(encoding);
  const values = new Map();
  for (const line of entries) {
    if (!/^\s*pref\.namedpvns/i.test(line)) continue;
    const match = line.match(assignment);
    if (!match || !/^pref\.namedpvns(?:\.count|\d+\.(?:name|pvnid))$/i.test(match[1])) throw new Error('Unrecognized LAN segment catalog entry; preferences were not changed.');
    const key = match[1].toLowerCase();
    if (values.has(key)) throw new Error('Duplicate LAN segment preference key.');
    values.set(key, encodingCodec.decode(match[2]));
  }
  const count = values.get('pref.namedpvns.count') ?? (values.size ? null : '0');
  if (!/^\d{1,5}$/.test(count ?? '') || Number(count) > 10000) throw new Error('Invalid LAN segment catalog count.');
  if (values.size !== (values.has('pref.namedpvns.count') ? 1 : 0) + Number(count) * 2) throw new Error('LAN segment catalog count does not match its entries.');
  const segments = [];
  const ids = new Set();
  for (let index = 0; index < Number(count); index++) {
    const name = values.get(`pref.namedpvns${index}.name`);
    const id = values.get(`pref.namedpvns${index}.pvnid`);
    if (!name?.trim() || !idPattern.test(id || '') || ids.has(idKey(id))) throw new Error('Incomplete or duplicate LAN segment identity.');
    ids.add(idKey(id)); segments.push({ name, id: idKey(id) });
  }
  return { lines, encoding, codec: encodingCodec, segments, newline: raw.includes('\r\n') ? '\r\n' : '\n', hasEncoding: !!encodingLines.length };
}

function renderPreferences(document, segments) {
  const bom = document.lines[0]?.startsWith('\xef\xbb\xbf') ? '\xef\xbb\xbf' : '';
  const lines = document.lines.map((line, index) => index === 0 ? line.replace(/^\xef\xbb\xbf/, '') : line).filter(line => !namespace.test(line.trimStart()));
  let text = bom + lines.join('');
  const nl = document.newline;
  if (text && !text.endsWith('\n')) text += nl;
  if (!document.hasEncoding) text += `.encoding = "${document.encoding}"${nl}`;
  text += `pref.namedPVNs.count = "${segments.length}"${nl}`;
  segments.forEach((entry, index) => {
    text += `pref.namedPVNs${index}.name = "${document.codec.encode(entry.name)}"${nl}`;
    text += `pref.namedPVNs${index}.pvnID = "${entry.id}"${nl}`;
  });
  return Buffer.from(text, 'latin1');
}

function resolveSegment(segments, selector) {
  const matches = segments.filter(entry => entry.name.toLowerCase() === selector.toLowerCase() || entry.id === selector.toLowerCase());
  if (matches.length !== 1) throw new Error(matches.length ? 'LAN segment name is ambiguous; use its pvnID.' : 'LAN segment was not found. Use list_lan_segments.');
  return matches[0];
}

// Inspect native process metadata only. An open GUI caches and rewrites preferences.
export async function assertLanGUIClosed(backend, platform = process.platform, procRoot = '/proc') {
  let names;
  if (platform === 'win32') {
    const result = await backend.execute('pwsh', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; ConvertTo-Json -InputObject @(Get-Process | Where-Object { $_.ProcessName -in @('vmware','vmplayer') } | ForEach-Object { $_.ProcessName }) -Compress"], { windowsHide: true, shell: false, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    names = result.stdout.trim() ? JSON.parse(result.stdout) : [];
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw new Error('Cannot verify Workstation GUI process state.');
  } else if (platform === 'linux') {
    names = [];
    for (const pid of (await fs.readdir(procRoot)).filter(entry => /^\d+$/.test(entry))) {
      try { names.push((await fs.readFile(path.join(procRoot, pid, 'comm'), 'utf8')).trim()); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
    }
  } else throw new Error('LAN segments support Windows and Linux Workstation hosts.');
  if (names.some(name => /^(?:vmware|vmplayer)(?:\.exe)?$/i.test(name))) throw new Error('Close the VMware Workstation/Player GUI before changing LAN segments or adapters; its cached settings can overwrite offline edits.');
}

export class LanSegments {
  constructor(backend, vmFiles, { assertGUIClosed = assertLanGUIClosed, protectFile } = {}) {
    this.backend = backend; this.vmFiles = vmFiles; this.assertGUIClosed = () => assertGUIClosed(backend);
    this.protectFile = protectFile; this.filename = preferencesPath(backend.env); this.tail = Promise.resolve();
  }
  async readCatalog() {
    if (!path.isAbsolute(this.filename) || /[\x00-\x1f]/.test(this.filename)) throw new Error('VMWARE_PREFERENCES_PATH must be an absolute path without control characters.');
    let bytes = null;
    try {
      const stat = await fs.lstat(this.filename);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error('Preferences must be a regular, unlinked file no larger than 4 MiB.');
      bytes = await fs.readFile(this.filename);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { bytes, document: parseLanPreferences(bytes || Buffer.alloc(0), process.platform === 'win32' ? 'windows-1252' : 'UTF-8') };
  }
  async unchanged(catalog) {
    const current = await this.readCatalog();
    if (catalog.bytes === null ? current.bytes !== null : current.bytes === null || !catalog.bytes.equals(current.bytes)) throw new Error('LAN segment preferences changed concurrently; inspect and retry.');
  }
  exclusive(callback) {
    const job = this.tail.then(async () => {
      // Check the configured path before creating a sibling lock. Never break an existing lock.
      await this.readCatalog();
      const lock = `${this.filename}.lan-segments.lock`;
      try { await fs.mkdir(lock, { mode: 0o700 }); } catch (error) {
        if (error.code === 'EEXIST') throw new Error('LAN segment edit lock exists; another operation may be active. Inspect before removing a stale lock.');
        throw error;
      }
      try { await this.assertGUIClosed(); return await callback(); } finally { await fs.rmdir(lock); }
    });
    this.tail = job.catch(() => {}); return job;
  }
  async writeCatalog(catalog, segments, beforeCommit) {
    const bytes = renderPreferences(catalog.document, segments);
    const backup = catalog.bytes === null ? null : `${this.filename}.backup-${randomUUID()}`;
    const temporary = `${this.filename}.edit-${randomUUID()}`;
    const write = async (filename, content) => {
      await fs.writeFile(filename, '', { flag: 'wx', mode: 0o600 });
      if (this.protectFile) await this.protectFile(filename);
      await fs.writeFile(filename, content);
    };
    try {
      if (backup) await write(backup, catalog.bytes);
      await write(temporary, bytes);
      if (beforeCommit) await beforeCommit();
      await this.assertGUIClosed(); await this.unchanged(catalog);
      await fs.rename(temporary, this.filename);
    } catch (error) {
      await fs.unlink(temporary).catch(cleanup => { if (cleanup.code !== 'ENOENT') throw cleanup; });
      throw error;
    }
    return { preferencesPath: this.filename, backup };
  }
  async readVM(input) {
    const vmx = await this.backend.vmx(input);
    const bytes = await fs.readFile(vmx);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const values = new Map();
    for (const line of text.split(/\r?\n/)) {
      const match = line.replace(/^\uFEFF/, '').match(assignment);
      if (!match) {
        if (/^\s*(?:ethernet\d+\.|\.encoding|checkpoint\.vmstate|suspend\.filename)/i.test(line)) throw new Error('Malformed VM network or state setting.');
        continue;
      }
      const key = match[1].toLowerCase();
      if (key.startsWith('encryption.')) throw new Error('Encrypted VMX files cannot be inspected safely for LAN segment references.');
      if (/^(ethernet\d+\.|\.encoding|checkpoint\.vmstate|suspend\.filename)/.test(key)) {
        const index = key.match(/^ethernet(\d+)\./)?.[1];
        if (index !== undefined && (String(Number(index)) !== index || Number(index) > 255)) throw new Error('Unsupported VM adapter index; cannot verify LAN segment references.');
        if (values.has(key)) throw new Error('Duplicate VM network or state setting.');
        values.set(key, unescapeBytes(match[2]));
      }
    }
    if (values.has('.encoding') && !/^utf-?8$/i.test(values.get('.encoding'))) throw new Error('LAN adapter inspection and editing require a UTF-8 VMX.');
    return { vmx, text, values };
  }
  adapters(vm, segments) {
    const indices = [...new Set([...vm.values.keys()].map(key => key.match(/^ethernet(\d+)\./)?.[1]).filter(value => value !== undefined))].map(Number).sort((a, b) => a - b);
    return indices.map(index => {
      const prefix = `ethernet${index}`;
      const type = vm.values.get(`${prefix}.connectiontype`) || null;
      const id = vm.values.get(`${prefix}.pvnid`)?.toLowerCase() || null;
      return { adapter: index, device: prefix, present: /^true$/i.test(vm.values.get(`${prefix}.present`) || ''), network: type, segmentId: id, segmentName: segments.find(entry => entry.id === id)?.name || null, startConnected: !/^false$/i.test(vm.values.get(`${prefix}.startconnected`) || '') };
    });
  }
  async list(input = {}) {
    const a = lanSegmentSchemas.list_lan_segments.parse(input);
    const catalog = await this.readCatalog();
    return { preferencesPath: this.filename, segments: catalog.document.segments, ...(a.vmx ? { vmx: a.vmx, adapters: this.adapters(await this.readVM(a.vmx), catalog.document.segments) } : {}), note: 'Catalog is per host user. Supply vmx to inspect adapters. Inventory is not a disk scan; unregistered VMs may also reference these segment IDs.' };
  }
  async create(input) {
    const a = lanSegmentSchemas.create_lan_segment.parse(input);
    return this.exclusive(async () => {
      const catalog = await this.readCatalog();
      const existing = catalog.document.segments.filter(entry => entry.name.toLowerCase() === a.name.toLowerCase());
      if (existing.length > 1) throw new Error('LAN segment name is ambiguous; catalog was not changed.');
      if (existing.length) return { created: false, segment: existing[0], backup: null };
      if (catalog.document.segments.length >= 10000) throw new Error('LAN segment catalog is full.');
      let id;
      do {
        const bytes = randomBytes(16); bytes[0] = 0x52;
        const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0'));
        id = `${hex.slice(0, 8).join(' ')}-${hex.slice(8).join(' ')}`;
      } while (catalog.document.segments.some(entry => entry.id === id));
      const segment = { name: a.name, id };
      return { created: true, segment, ...await this.writeCatalog(catalog, [...catalog.document.segments, segment]) };
    });
  }
  async remove(input) {
    const a = lanSegmentSchemas.remove_lan_segment.parse(input);
    return this.exclusive(async () => {
      const catalog = await this.readCatalog();
      const segment = resolveSegment(catalog.document.segments, a.segment);
      const inventoryBytes = await fs.readFile(this.backend.inventoryPath);
      for (const line of inventoryBytes.toString('utf8').split(/\r?\n/)) {
        if (!/^\s*vmlist\d+\.config\b/i.test(line)) continue;
        const entry = line.match(assignment);
        const value = entry && unescapeBytes(entry[2]);
        if (!entry || (value && (!path.isAbsolute(value) || path.extname(value).toLowerCase() !== '.vmx'))) throw new Error('Malformed VM inventory; cannot verify LAN segment references.');
      }
      const inventory = await this.backend.listVMs();
      if (inventory.warnings.length) throw new Error('Cannot verify segment usage because VM inventory is unavailable. Restore inventory before removal.');
      const references = [];
      const skippedMissingVMs = [];
      const scanned = new Set();
      const snapshots = [];
      for (const input of [...inventory.vms.map(vm => vm.vmx), ...a.vmx_paths]) {
        let vm;
        try { vm = await this.readVM(input); } catch (error) {
          // Stale inventory paths with no file cannot contain a live reference. All other errors block deletion.
          if (error.code === 'ENOENT' && !a.vmx_paths.includes(input)) { skippedMissingVMs.push(input); continue; }
          throw new Error(`Cannot inspect a VM for LAN segment references: ${error.message}`);
        }
        const key = process.platform === 'win32' ? vm.vmx.toLowerCase() : vm.vmx;
        if (scanned.has(key)) continue; scanned.add(key);
        snapshots.push(vm);
        for (const nic of this.adapters(vm, catalog.document.segments)) {
          if (nic.segmentId === segment.id) references.push({ vmx: vm.vmx, adapter: nic.adapter });
        }
      }
      if (references.length) throw new Error(`LAN segment is referenced by VM adapters; detach them before removal: ${JSON.stringify(references)}`);
      const recheck = async () => {
        if (!inventoryBytes.equals(await fs.readFile(this.backend.inventoryPath))) throw new Error('VM inventory changed during removal; inspect and retry.');
        const current = await this.backend.listVMs();
        if (current.warnings.length || JSON.stringify(current.vms) !== JSON.stringify(inventory.vms)) throw new Error('VM inventory or running state changed during removal; inspect and retry.');
        for (const vm of snapshots) if (await fs.readFile(vm.vmx, 'utf8') !== vm.text) throw new Error('A VMX changed during segment removal; inspect and retry.');
      };
      return { removed: true, segment, checkedVMs: scanned.size, skippedMissingVMs, ...await this.writeCatalog(catalog, catalog.document.segments.filter(entry => entry.id !== segment.id), recheck), note: 'Checked registered/running and explicitly supplied VMX files. Unregistered VMs outside this set were not scanned.' };
    });
  }
  async editAdapter(input, detach) {
    const a = lanSegmentSchemas[detach ? 'detach_vm_adapter_from_lan_segment' : 'attach_vm_adapter_to_lan_segment'].parse(input);
    if (detach && (a.network === 'custom' ? !a.vmnet : a.vmnet !== undefined)) throw new Error('Supply vmnet only with network=custom; custom requires vmnet.');
    return this.exclusive(async () => {
      const catalog = await this.readCatalog();
      const vm = await this.readVM(a.vmx);
      // Detach orphaned IDs too, even if the catalog entry was deleted outside this plugin.
      const segment = detach && idPattern.test(a.segment) ? { id: a.segment.toLowerCase(), name: catalog.document.segments.find(entry => entry.id === a.segment.toLowerCase())?.name || null } : resolveSegment(catalog.document.segments, a.segment);
      const prefix = `ethernet${a.adapter}`;
      const present = vm.values.get(`${prefix}.present`) || '';
      if (detach ? !/^(true|false)$/i.test(present) : !/^true$/i.test(present)) throw new Error('Selected network adapter is not present. LAN tools do not create or delete adapters.');
      if (detach && vm.values.get(`${prefix}.pvnid`)?.toLowerCase() !== segment.id) throw new Error('Adapter is not attached to the selected LAN segment; VMX was not changed.');
      for (const key of ['checkpoint.vmstate', 'suspend.filename']) {
        const saved = vm.values.get(key);
        if (saved) {
          try { await fs.access(path.resolve(path.dirname(vm.vmx), saved)); throw new Error('VM has a saved/suspended state; power it off first.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      const settings = {
        [`${prefix}.connectionType`]: detach ? a.network : 'pvn',
        [`${prefix}.pvnID`]: detach ? null : segment.id,
        [`${prefix}.vnet`]: detach && a.network === 'custom' ? a.vmnet : null,
        [`${prefix}.startConnected`]: detach ? 'FALSE' : 'TRUE',
        [`${prefix}.connected`]: detach ? 'FALSE' : 'TRUE',
      };
      const result = await this.vmFiles.configure({ vmx: vm.vmx, settings }, { expectedOriginal: vm.text, beforeCommit: async () => { await this.assertGUIClosed(); await this.unchanged(catalog); } });
      return { ...result, adapter: a.adapter, segment, attached: !detach, network: detach ? a.network : 'pvn', startConnected: !detach };
    });
  }
  attach(input) { return this.editAdapter(input, false); }
  detach(input) { return this.editAdapter(input, true); }
}
