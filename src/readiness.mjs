import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { parseAssignments, parseCountedList, isWithin } from './workstation.mjs';

const target = { vmx: z.string().min(1), vm_password_profile: z.string().optional() };
const wait = { ...target, timeout_seconds: z.number().int().min(1).max(600).default(120), poll_interval_ms: z.number().int().min(100).max(10000).default(1000) };
export const readinessSchemas = {
  vm_wait_for_boot: z.object(wait).strict(),
  vm_wait_for_ip: z.object(wait).strict(),
  vm_wait_for_service: z.object({ ...wait, port: z.number().int().min(1).max(65535), protocol: z.enum(['tcp', 'http', 'https']).default('tcp'), path: z.string().max(1024).regex(/^\/(?!\/)[^\x00-\x20#]*$/).default('/'), expected_status: z.number().int().min(200).max(599).default(200) }).strict(),
  vm_get_recent_errors: z.object({ ...target, max_bytes: z.number().int().min(1024).max(262144).default(32768), max_entries: z.number().int().min(1).max(200).default(50) }).strict(),
  vm_collect_diagnostics: z.object({ ...target, destination_directory: z.string().min(1), include_console: z.boolean().default(false), max_log_bytes: z.number().int().min(1024).max(262144).default(32768) }).strict(),
};

const categories = [
  ['lock_contention', /failed to lock|cannot lock|already in use|resource busy|lock contention/i, 'Close competing VMware writers; inspect ownership before retrying. Never delete locks automatically.'],
  ['disk_error', /disk.*(?:error|failed|cannot|not found)|cannot open.*disk|no space|disk full|DISKLIB.*(?:error|failed)/i, 'Check selected VM disk paths, free space and backing-chain access while offline.'],
  ['nic_misconfiguration', /(?:ethernet|network adapter|vnet|vmnet).*(?:failed|error|not found|not connected|invalid)/i, 'Inspect the selected adapter connection, VMnet or LAN segment and guest IP configuration.'],
  ['boot_failure', /no bootable|operating system not found|boot.*(?:failed|failure)|PXE-E\d+/i, 'Inspect guest-only VNC evidence and selected boot firmware/media.'],
  ['capability_unavailable', /not found.*vmrun|vmrun.*not found|not supported|unsupported|not installed/i, 'Inspect workstation_capabilities and install/configure the required native utility.'],
];
export function failureCategory(text) { return categories.find(([, pattern]) => pattern.test(String(text)))?.[0] || 'observation_unavailable'; }
const actionFor = category => categories.find(([name]) => name === category)?.[2] || 'Inspect the selected VM state, Tools configuration and native utility availability.';
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

// A service destination comes only from Tools, never an arbitrary host/URL.
export function routableGuestIP(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] !== 0 && parts[0] !== 127 && parts[0] < 224 && !(parts[0] === 169 && parts[1] === 254);
  }
  // Conservative IPv6: global unicast and private ULA only; no mapped IPv4,
  // multicast, link-local, unspecified or loopback addresses.
  return net.isIPv6(address) && /^(?:[23][0-9a-f]{3}|f[cd][0-9a-f]{2}):/i.test(address);
}

export async function probeService({ address, port, protocol, path: requestPath, expected_status }, { timeout, signal }) {
  return new Promise(resolve => {
    let channel; let timer;
    const finish = result => { clearTimeout(timer); signal?.removeEventListener('abort', abort); channel?.destroy(); resolve(result); };
    const abort = () => finish({ ready: false, state: 'unknown', category: 'observation_cancelled' });
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish({ ready: false, state: 'application_unready', category: 'service_timeout' }), timeout);
    if (protocol === 'tcp') {
      channel = net.createConnection({ host: address, port });
      channel.once('connect', () => finish({ ready: true, state: 'running', evidence: 'tcp_connection_accepted' }));
    } else {
      channel = (protocol === 'https' ? https : http).request({ hostname: address, port, method: 'GET', path: requestPath, agent: false, maxHeaderSize: 8192 }, response => {
        // Never retain body, headers, redirects, credentials or guest output.
        const status = response.statusCode;
        response.destroy();
        finish({ ready: status === expected_status, state: status === expected_status ? 'running' : 'application_unready', evidence: 'http_status', status });
      });
      channel.end();
    }
    channel.once('error', error => finish({ ready: false, state: ['ENETUNREACH', 'EHOSTUNREACH'].includes(error.code) ? 'network_unavailable' : 'application_unready', category: 'service_unavailable' }));
  });
}

export class Readiness {
  constructor({ backend, credentials, consoles, protectFile, probe = probeService } = {}) {
    Object.assign(this, { backend, credentials, consoles, protectFile, probe });
  }
  async config(vmx) {
    const handle = await fs.open(vmx, 'r');
    try {
      if ((await handle.stat()).size > 1024 * 1024) throw new Error('Selected VMX exceeds diagnostic size limit.');
      const bytes = Buffer.alloc(1024 * 1024 + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 1024 * 1024) throw new Error('Selected VMX exceeds diagnostic size limit.');
      return Object.fromEntries(Object.entries(parseAssignments(bytes.subarray(0, bytesRead).toString('utf8'))).map(([key, value]) => [key.toLowerCase(), value]));
    } finally { await handle.close(); }
  }
  async authentication(a) { return a.vm_password_profile ? ['-vp', await this.credentials.vm(a.vm_password_profile)] : []; }
  async observation(vmx, config, options) {
    const run = (command, args = []) => this.backend.run([command, ...(command === 'list' ? [] : [vmx]), ...args], options);
    let running;
    try { running = parseCountedList(await run('list')); }
    catch (error) {
      if (error.code === 'OBSERVATION_DEADLINE') return { expired: true, state: 'unknown', lifecycle: 'unknown', category: 'observation_timeout' };
      const category = failureCategory(error.message); return { state: 'unknown', lifecycle: 'unknown', category, action: actionFor(category) };
    }
    const paths = await Promise.all(running.map(file => fs.realpath(file).catch(() => file)));
    if (!paths.some(file => same(file, vmx))) {
      // Saved-state references must stay within this VM directory. Do not read
      // external saved-state files or scan unrelated directories.
      for (const field of ['checkpoint.vmstate', 'suspend.filename']) {
        const saved = config[field];
        if (saved) {
          const candidate = path.resolve(path.dirname(vmx), saved);
          if (!isWithin(path.dirname(vmx), candidate)) return { state: 'unknown', lifecycle: 'unknown', category: 'external_saved_state' };
          const stat = await fs.lstat(candidate).catch(() => null);
          if (stat?.isFile() && !stat.isSymbolicLink()) return { state: 'suspended', lifecycle: 'suspended' };
          return { state: 'unknown', lifecycle: 'unknown', category: 'saved_state_unavailable' };
        }
      }
      const names = await fs.readdir(path.dirname(vmx));
      if (names.some(name => /\.vmss$/i.test(name))) return { state: 'unknown', lifecycle: 'unknown', category: 'saved_state_unattributed' };
      if (names.some(name => /\.lck$/i.test(name))) return { state: 'unknown', lifecycle: 'unknown', category: 'lock_contention', action: actionFor('lock_contention') };
      return { state: 'powered_off', lifecycle: 'powered_off', evidence: 'not_listed_no_saved_state_or_lock', confidence: 'inferred' };
    }
    const result = { lifecycle: 'running', state: 'tools_unavailable', tools: 'unknown', address: null };
    try { const tools = await run('checkToolsState'); result.tools = ['running', 'installed', 'unknown'].includes(tools) ? tools : 'unknown'; }
    catch (error) { result.category = failureCategory(error.message); }
    if (result.tools === 'running') result.state = 'running';
    // IP publication can disagree with Tools state; observe independently.
    try { const address = (await run('getGuestIPAddress')).trim(); if (net.isIP(address)) result.address = address; }
    catch { /* An IP failure does not prove Tools is stopped. */ }
    if (result.tools === 'running' && !result.address) result.state = 'network_unavailable';
    return result;
  }
  async wait(kind, input, { signal } = {}) {
    const a = readinessSchemas[`vm_wait_for_${kind}`].parse(input);
    const deadline = performance.now() + a.timeout_seconds * 1000;
    const timerController = new AbortController();
    const timer = setTimeout(() => timerController.abort(), a.timeout_seconds * 1000);
    const totalSignal = AbortSignal.any([timerController.signal, ...(signal ? [signal] : [])]);
    try {
      const vmx = await this.backend.vmx(a.vmx); const config = await this.config(vmx); const authentication = await this.authentication(a);
      let attempts = 0; let last = { state: 'unknown', lifecycle: 'unknown' }; let expiredAttempt = false;
      const start = performance.now();
      while (performance.now() < deadline && !totalSignal.aborted) {
        attempts++;
        const observed = await this.observation(vmx, config, { authentication, deadline, signal: totalSignal, timeout: Math.max(1, Math.min(5000, Math.floor(deadline - performance.now()))) });
        if (observed.expired) { expiredAttempt = true; break; }
        if (totalSignal.aborted || performance.now() >= deadline) break;
        last = observed;
        if (last.lifecycle === 'running' && last.tools !== 'running') {
          // Boot progress is an inference from this VM's attributed current log,
          // never a synonym for a successful power command.
          const logs = await this.logs(vmx, 4096, 10);
          if (logs.boot_progress) last.state = 'booting';
        }
        let ready = kind === 'boot' ? last.tools === 'running' : !!last.address;
        if (kind === 'service') {
          ready = false;
          if (last.address && routableGuestIP(last.address) && !totalSignal.aborted) {
            const service = await this.probe({ ...a, address: last.address }, { timeout: Math.max(1, Math.min(3000, Math.floor(deadline - performance.now()))), signal: totalSignal });
            last = { ...last, state: service.state, service }; ready = service.ready;
          } else if (last.address) last = { ...last, state: 'network_unavailable', category: 'unsafe_service_address' };
        }
        if (ready && !totalSignal.aborted && performance.now() < deadline) return { result: 'ready', ready: true, timed_out: false, criterion: kind, attempts, elapsed_ms: Math.round(performance.now() - start), ...last };
        if (['powered_off', 'suspended'].includes(last.state)) break;
        await delay(Math.max(1, Math.min(a.poll_interval_ms, deadline - performance.now())), undefined, { signal: totalSignal }).catch(() => {});
      }
      const cancelled = !!signal?.aborted;
      const timedOut = !cancelled && (expiredAttempt || totalSignal.aborted || performance.now() >= deadline);
      return { result: cancelled ? 'cancelled' : timedOut ? 'timed_out' : 'not_ready', ready: false, timed_out: timedOut, criterion: kind, attempts, elapsed_ms: Math.round(performance.now() - start), ...last };
    } finally { clearTimeout(timer); }
  }
  async logs(vmx, maxBytes, maxEntries) {
    let handle;
    try {
      const filename = path.join(path.dirname(vmx), 'vmware.log');
      const entry = await fs.lstat(filename);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error();
      handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== entry.ino || (process.platform !== 'win32' && stat.dev !== entry.dev)) throw new Error();
      const head = Buffer.alloc(Math.min(65536, stat.size)); await handle.read(head, 0, head.length, 0);
      const identities = [...head.toString('utf8').matchAll(/Config file:\s*([^\r\n]+)/gi)].map(match => match[1].trim().replace(/^"|"$/g, ''));
      if (!identities.length || !identities.every(value => path.isAbsolute(value) && same(path.normalize(value), path.normalize(vmx)))) return { available: false, category: 'log_identity_unverified', entries: [] };
      const length = Math.min(maxBytes, stat.size); const bytes = Buffer.alloc(length); const offset = stat.size - length;
      const { bytesRead } = await handle.read(bytes, 0, length, offset);
      const lines = bytes.subarray(0, bytesRead).toString('utf8').split(/\r?\n/); if (offset) lines.shift();
      const events = [];
      for (const line of lines) {
        const category = failureCategory(line);
        if (category !== 'observation_unavailable' || /\b(?:error|failed|warning|panic)\b/i.test(line)) {
          // Free-form log text can contain arbitrary credentials, guest output
          // and unrelated host data. Emit only normalized, allowlisted excerpts.
          events.push({ category, excerpt: category === 'observation_unavailable' ? 'VMware reported an unclassified error or warning; raw text omitted.' : `VMware reported ${category.replaceAll('_', ' ')}.`, action: actionFor(category) });
        }
      }
      return { available: true, bytes_scanned: bytesRead, truncated: offset > 0 || events.length > maxEntries, entries: events.slice(-maxEntries), boot_progress: Date.now() - stat.mtimeMs < 300000 && lines.some(line => /(?:BIOS|EFI|firmware).*(?:boot|start)|PowerOn.*(?:success|complete)|VMX.*powering on/i.test(line)) };
    } catch { return { available: false, category: 'log_unavailable', entries: [] }; }
    finally { await handle?.close(); }
  }
  async recentErrors(input) {
    const a = readinessSchemas.vm_get_recent_errors.parse(input);
    return this.logs(await this.backend.vmx(a.vmx), a.max_bytes, a.max_entries);
  }
  hardware(config) {
    const summary = {};
    for (const [key, value] of Object.entries(config)) {
      if (/^(memsize|numvcpus|virtualhw.version)$/.test(key) && /^\d{1,9}$/.test(value)) summary[key] = Number(value);
      if (key === 'firmware' && /^(bios|efi)$/i.test(value)) summary[key] = value.toLowerCase();
      if (/^ethernet\d{1,2}\.(present|startconnected)$/.test(key) && /^(true|false)$/i.test(value)) summary[key] = value.toLowerCase() === 'true';
      if (/^ethernet\d{1,2}\.connectiontype$/.test(key) && /^(nat|bridged|hostonly|custom|pvn|none)$/i.test(value)) summary[key] = value.toLowerCase();
      if (/^(scsi|sata|ide|nvme)\d{1,2}:\d{1,2}\.present$/.test(key) && /^(true|false)$/i.test(value)) summary[key] = value.toLowerCase() === 'true';
    }
    return summary;
  }
  async collect(input, { signal } = {}) {
    const a = readinessSchemas.vm_collect_diagnostics.parse(input);
    const roots = this.backend.env.VMWARE_DIAGNOSTICS_ROOTS || this.backend.env.VMWARE_ALLOWED_HOST_ROOTS;
    if (!roots) throw new Error('Configure VMWARE_DIAGNOSTICS_ROOTS or VMWARE_ALLOWED_HOST_ROOTS before saving diagnostics.');
    const allowed = roots.split(path.delimiter).filter(Boolean);
    if (!allowed.length || allowed.some(root => !path.isAbsolute(root))) throw new Error('Diagnostic roots must be existing absolute directories.');
    const directory = await this.backend.hostPath(a.destination_directory, 'host-destination-directory');
    const canonical = await Promise.all(allowed.map(root => fs.realpath(root)));
    if (!canonical.some(root => isWithin(root, directory) && !same(root, directory))) throw new Error('Diagnostic destination must be a NEW directory inside an approved root.');
    const vmx = await this.backend.vmx(a.vmx); const config = await this.config(vmx);
    const deadline = performance.now() + 30000;
    const totalSignal = AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
    const options = { authentication: await this.authentication(a), timeout: 5000, deadline, signal: totalSignal };
    const report = { format_version: 1, captured_at: new Date().toISOString(), target: 'selected-vm', hardware: this.hardware(config), lifecycle: await this.observation(vmx, config, options), logs: await this.logs(vmx, a.max_log_bytes, 100), snapshots: { available: false }, console: { included: false }, omissions: ['Raw VMX, disk paths, snapshot names, free-form logs, guest output, credentials and host inventory are excluded.'] };
    if (report.lifecycle.lifecycle === 'running' && report.lifecycle.tools !== 'running' && report.logs.boot_progress) report.lifecycle.state = 'booting';
    report.application = { state: 'unknown', note: 'No service probe or guest command was requested by this collection.' };
    for (const [key, value] of Object.entries(report.hardware)) if (/^ethernet\d+\.(present|startconnected)$/.test(key) && value === false) report.logs.entries.push({ category: 'nic_misconfiguration', excerpt: 'Selected adapter is disabled or disconnected at power-on.', action: actionFor('nic_misconfiguration') });
    try {
      const snapshots = parseCountedList(await this.backend.run(['listSnapshots', vmx], options));
      report.snapshots = { available: true, count: snapshots.length, entries: snapshots.slice(0, 100).map((_, index) => ({ index, name: '[REDACTED]' })), truncated: snapshots.length > 100 };
    } catch { report.snapshots = { available: false, category: 'observation_unavailable' }; }
    let image;
    if (a.include_console) {
      try {
        if (totalSignal.aborted) throw new Error();
        const evidence = await this.consoles.screenshot(vmx);
        image = evidence.content.find(block => block.type === 'image' && block.mimeType === 'image/png');
        if (!image || image.data.length > 14 * 1024 * 1024) throw new Error();
        report.console = { included: true, file: 'guest-console.png', transport: 'direct RFB', redacted: false, note: 'Opt-in guest pixels may contain sensitive information. Review before sharing.' };
      } catch { image = undefined; report.console = { included: false, category: 'console_unavailable', action: 'Use console_status and the offline VNC setup guide. No desktop fallback.' }; }
    }
    signal?.throwIfAborted();
    // mkdir without recursive or overwrite prevents following an existing target.
    await fs.mkdir(directory, { mode: 0o700 });
    const write = async (name, data) => {
      if (!same(await fs.realpath(directory), directory) || !(await fs.lstat(directory)).isDirectory()) throw new Error('Diagnostic directory changed; no further data will be written.');
      const filename = path.join(directory, name);
      await fs.writeFile(filename, data, { flag: 'wx', mode: 0o600 });
      await this.protectFile(filename);
    };
    await write('diagnostics.json', JSON.stringify(report, (key, value) => typeof value === 'string' ? this.credentials.redact(value) : value, 2) + '\n');
    if (image) await write('guest-console.png', Buffer.from(image.data, 'base64'));
    return { directory, files: ['diagnostics.json', ...(image ? ['guest-console.png'] : [])], report };
  }
}
