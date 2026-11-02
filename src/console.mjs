import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { connect, Framebuffer, security, encodings, buttons, keysyms, keysymFromChar } from 'rfb2';
import pngjs from 'pngjs';
import { z } from 'zod';
import { parseAssignments } from './workstation.mjs';
import { inspectLinuxListener } from './linux-listener.mjs';

export const consoleSchemas = {
  console_screenshot: z.object({ vm_id: z.string().min(1) }).strict(),
  console_click: z.object({ vm_id: z.string().min(1), x: z.number().int().min(0), y: z.number().int().min(0), button: z.enum(['left', 'middle', 'right']).default('left') }).strict(),
  console_key: z.object({ vm_id: z.string().min(1), key: z.string().min(1).max(128) }).strict(),
  console_type: z.object({ vm_id: z.string().min(1), text: z.string().max(4096).refine(value => !/[\x00-\x07\x0b\x0c\x0e-\x1f\x7f]/.test(value), 'Text contains unsupported control characters.') }).strict(),
  console_scroll: z.object({ vm_id: z.string().min(1), direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(100).default(1) }).strict(),
  console_status: z.object({ vm_id: z.string().min(1) }).strict(),
};
const MAX_PIXELS = 16 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const keyAliases = { enter: 'Return', esc: 'Escape', ctrl: 'ControlLeft', control: 'ControlLeft', alt: 'AltLeft', shift: 'ShiftLeft', meta: 'SuperLeft', super: 'SuperLeft', win: 'SuperLeft', cmd: 'SuperLeft', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', backspace: 'BackSpace', pgup: 'PageUp', pgdn: 'PageDown', plus: 'Plus', space: 'Space' };
const shifted = /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/;
const modifierCodes = new Set([keysyms.ControlLeft, keysyms.ControlRight, keysyms.AltLeft, keysyms.AltRight, keysyms.ShiftLeft, keysyms.ShiftRight, keysyms.SuperLeft, keysyms.SuperRight, keysyms.MetaLeft, keysyms.MetaRight]);
export function keySequence(key) {
  if (key === '+') return [keysyms.ShiftLeft, keysymFromChar('+')];
  const parts = key.split('+');
  if (parts.length > 5 || parts.some(part => !part)) throw new Error('Use a key name or chord such as F2, Enter, ArrowDown, Ctrl+Alt+Delete, or Ctrl+Plus.');
  const sequence = parts.map(part => {
    const name = keyAliases[part.toLowerCase()] || Object.keys(keysyms).find(name => name.toLowerCase() === part.toLowerCase());
    if (name === 'Plus') return keysymFromChar('+');
    if (name) return keysyms[name];
    if ([...part].length === 1) return keysymFromChar(part);
    throw new Error(`Unknown console key '${part}'.`);
  });
  if (sequence.slice(0, -1).some(code => !modifierCodes.has(code)) || new Set(sequence).size !== sequence.length) throw new Error('Only distinct modifier keys may precede the final key in a chord.');
  const final = parts.at(-1);
  if ((shifted.test(final) || final.toLowerCase() === 'plus') && !sequence.includes(keysyms.ShiftLeft) && !sequence.includes(keysyms.ShiftRight)) sequence.unshift(keysyms.ShiftLeft);
  return sequence;
}

// Only reads native TCP/process metadata; never touches desktop pixels, focus, or input.
export async function inspectNativeListener(backend, endpoint) {
  if (process.platform === 'linux') return inspectLinuxListener(endpoint.port);
  if (process.platform !== 'win32') throw new Error('Native listener verification requires Windows or Linux.');
  const port = endpoint.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid VNC listener port.');
  const command = `$ErrorActionPreference='Stop'; $connections=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue); @($connections | ForEach-Object { $owner=Get-CimInstance Win32_Process -Filter ('ProcessId='+$_.OwningProcess); [pscustomobject]@{address=$_.LocalAddress;port=$_.LocalPort;processName=$owner.Name;commandLine=$owner.CommandLine} }) | ConvertTo-Json -Compress`;
  const result = await backend.execute('pwsh', ['-NoProfile', '-Command', command], { windowsHide: true, shell: false, timeout: 10000, encoding: 'utf8', maxBuffer: 256 * 1024 });
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export class ConsoleManager {
  constructor({ backend, credentials, rest, connector = connect, listenerInspector = inspectNativeListener, idleMs = 300000, maxConnections = 8, keyDelayMs = 12 } = {}) {
    this.backend = backend; this.credentials = credentials; this.rest = rest;
    this.connector = connector; this.listenerInspector = listenerInspector;
    this.idleMs = idleMs; this.maxConnections = maxConnections; this.keyDelayMs = keyDelayMs;
    this.sessions = new Map(); this.closed = false;
  }
  async endpoint(vmID) {
    const file = await this.credentials.load();
    const aliases = Object.fromEntries(Object.entries(file.console || {}).filter(([, entry]) => typeof entry?.vmx === 'string').map(([name, entry]) => [name, entry.vmx]));
    const vmx = await this.backend.resolveVM(vmID, { aliases, restInventory: this.rest ? async () => {
      const response = await this.rest.request('GET', '/api/vms');
      if (!Array.isArray(response.data)) throw new Error('REST inventory did not return VM IDs and paths.');
      return response.data;
    } : undefined });
    const config = Object.fromEntries(Object.entries(parseAssignments(await fs.readFile(vmx, 'utf8'))).map(([key, value]) => [key.toLowerCase(), value]));
    if (String(config['remotedisplay.vnc.enabled']).toLowerCase() !== 'true') throw new Error('Native VNC is disabled for this VM. Configure it while powered off; console calls never enable VNC or start a VM automatically.');
    const host = config['remotedisplay.vnc.ip'];
    if (!['127.0.0.1', '::1'].includes(host)) throw new Error('VNC must explicitly bind to 127.0.0.1 or ::1 in the VMX. Wildcard/external listeners are refused.');
    const portText = config['remotedisplay.vnc.port'];
    if (!/^\d+$/.test(portText || '')) throw new Error('Configure an explicit native VNC port in the VMX.');
    const port = Number(portText);
    if (port < 1024 || port > 65535) throw new Error('VNC port must be between 1024 and 65535.');
    // Never use (or return) a plaintext VMX password as the credential source.
    this.credentials.remember(config['remotedisplay.vnc.password']);
    const auth = await this.credentials.console(vmx, Object.hasOwn(aliases, vmID) ? vmID : undefined);
    const key = process.platform === 'win32' ? vmx.toLowerCase() : vmx;
    const signature = createHash('sha256').update(`${host}:${port}\0${auth.password}`).digest('hex');
    return { vmx, host, port, ...auth, key, signature };
  }
  async verify(endpoint) {
    const listeners = await this.listenerInspector(this.backend, endpoint);
    if (!listeners.length) throw new Error('No native VNC listener is running. Power on this VM headlessly after configuring VNC.');
    if (listeners.some(item => !['127.0.0.1', '::1'].includes(item.address))) throw new Error('VNC port is exposed beyond loopback. Stop the VM and fix its native listener configuration.');
    const canonical = value => process.platform === 'win32' ? value.replace(/\//g, '\\').toLowerCase() : value;
    const matchesVM = item => Array.isArray(item.arguments)
      ? item.arguments.some(argument => canonical(argument) === canonical(endpoint.vmx))
      : typeof item.commandLine === 'string' && canonical(item.commandLine).includes(canonical(endpoint.vmx));
    const candidates = listeners.filter(item => item.address === endpoint.host);
    const matches = candidates.filter(item => /^vmware-vmx(?:\.exe)?$/i.test(item.processName || '') && matchesVM(item));
    // Every socket owner at the selected address must verify; SO_REUSEPORT must not hide a second owner.
    if (candidates.some(item => Array.isArray(item.arguments)) && matches.length !== candidates.length) throw new Error('The Linux VNC listener owner or exact VMX argument could not be verified. Run the plugin as the VM owner in the same PID/network namespace.');
    if (matches.length) return 'native worker command line and loopback listener';
    const native = listeners.filter(item => item.address === endpoint.host && /^vmware-vmx(?:\.exe)?$/i.test(item.processName || ''));
    if (!native.length || native.some(item => item.commandLine)) throw new Error('The VNC listener does not belong to the selected VMware VM. Refusing a possible cross-VM connection.');
    // Windows may hide a worker command line started through VMware's authorization service.
    // Fall back to the authoritative running inventory, an unambiguous VMX port, and VNC auth.
    const inventory = await this.backend.listVMs();
    const owners = [];
    for (const vm of inventory.vms.filter(item => item.running)) {
      let config; let vmx;
      try { vmx = await fs.realpath(vm.vmx); config = Object.fromEntries(Object.entries(parseAssignments(await fs.readFile(vmx, 'utf8'))).map(([key, value]) => [key.toLowerCase(), value])); }
      catch { throw new Error('Cannot verify VNC port ownership because a running VMX is unreadable.'); }
      if (Number(config['remotedisplay.vnc.port']) === endpoint.port) owners.push(vmx);
    }
    if (owners.length !== 1 || canonical(owners[0]) !== canonical(endpoint.vmx)) throw new Error('VNC port does not uniquely identify this running VM. Use a unique native VNC port for each VM.');
    return 'native worker, unique running VMX port, and VNC password authentication';
  }
  async session(endpoint) {
    if (this.closed) throw new Error('Console manager is closed.');
    const existing = this.sessions.get(endpoint.key);
    if (existing && existing.signature === endpoint.signature && !existing.closed) return existing.ready;
    if (existing) this.drop(existing);
    if (this.sessions.size >= this.maxConnections) throw new Error('Console connection limit reached. Wait for idle sessions to expire or restart the MCP server.');
    const session = { ...endpoint, closed: false, tail: Promise.resolve(), active: 0, lastUsed: Date.now(), client: null, screen: null, pointer: null };
    this.sessions.set(endpoint.key, session);
    session.ready = (async () => {
      try {
        session.listenerVerification = await this.verify(endpoint);
        const client = await this.connector({ host: endpoint.host, port: endpoint.port, password: endpoint.password, security: [security.VNC], shared: true, timeout: TIMEOUT_MS, initialUpdate: false, autoUpdate: false, pixelFormat: 'bgrx', maxClipboardBytes: 0, encodings: [encodings.hextile, encodings.copyRect, encodings.raw, encodings.pseudoDesktopSize] });
        session.client = client;
        client.on('error', error => { session.error = this.failure(error); this.drop(session); });
        client.on('close', () => this.drop(session));
        this.checkSize(client.width, client.height);
        if (session.closed || this.closed) { client.destroy(); throw new Error('Console connection was closed.'); }
        session.screen = new Framebuffer(client.width, client.height, client.pixelFormat);
        client.on('rect', rect => {
          try {
            if (rect.type === 'desktopSize' || rect.type === 'extendedDesktopSize') this.checkSize(rect.width, rect.height);
            session.screen.apply(rect);
          } catch (error) { session.error = this.failure(error); this.drop(session); }
        });
        this.touch(session);
        return session;
      } catch (error) { this.drop(session); throw new Error(this.failure(error)); }
    })();
    return session.ready;
  }
  checkSize(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) throw new Error('RFB framebuffer exceeds the 16 megapixel console limit.');
  }
  failure(error) {
    // Library error reasons are server-provided. Emit only stable codes for protocol errors.
    return this.credentials.redact(error?.code ? `RFB console failed (${error.code}). Check the VM listener and console password profile.` : error?.message || 'RFB console connection failed.');
  }
  touch(session) {
    if (session.closed) return;
    session.lastUsed = Date.now(); clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => { if (!session.active) this.drop(session); else this.touch(session); }, this.idleMs);
    session.idleTimer.unref();
  }
  drop(session) {
    if (session.closed) return;
    session.closed = true; clearTimeout(session.idleTimer);
    session.client?.destroy();
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
  }
  close() { this.closed = true; for (const session of this.sessions.values()) this.drop(session); }
  async withSession(vmID, callback) {
    const endpoint = await this.endpoint(vmID);
    const session = await this.session(endpoint);
    session.active++;
    const operation = session.tail.then(async () => {
      if (session.closed) throw new Error(session.error || 'Console disconnected. Inspect state before retrying input.');
      this.touch(session);
      return callback(session);
    });
    session.tail = operation.catch(() => {});
    try { return await operation; } finally { session.active--; this.touch(session); }
  }
  metadata(session) { return { vmx: session.vmx, connected: !session.closed, host: session.host, port: session.port, width: session.screen.width, height: session.screen.height, protocol: session.client.protocolVersion, authentication: 'VNC password', listenerVerification: session.listenerVerification, transport: 'direct RFB; no host desktop capture or input' }; }
  async refresh(session) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const update = await new Promise((resolve, reject) => {
        const client = session.client;
        const finish = (error, result) => { clearTimeout(timer); client.off('update', onUpdate); client.off('close', onClose); client.off('error', onError); error ? reject(error) : resolve(result); };
        const onUpdate = update => finish(null, update);
        const onClose = () => finish(new Error(session.error || 'Console disconnected while receiving a frame.'));
        const onError = error => finish(new Error(this.failure(error)));
        const timer = setTimeout(() => { finish(new Error('Timed out waiting for a fresh VM framebuffer.')); this.drop(session); }, TIMEOUT_MS);
        client.once('update', onUpdate); client.once('close', onClose); client.once('error', onError);
        try { client.requestUpdate(false, 0, 0, client.width, client.height); } catch (error) { finish(error); }
      });
      if (session.closed) throw new Error(session.error || 'Console disconnected.');
      if (update.rects.some(rect => ['desktopSize', 'extendedDesktopSize'].includes(rect.type))) continue;
      if (update.rects.some(rect => rect.type === 'pixels' || rect.type === 'copy')) return;
    }
    throw new Error('RFB server did not supply a complete fresh framebuffer.');
  }
  async screenshot(vmID) {
    return this.withSession(vmID, async session => {
      await this.refresh(session);
      const png = pngjs.PNG.sync.write({ width: session.screen.width, height: session.screen.height, data: session.screen.toRgba() });
      if (png.length > 10 * 1024 * 1024) throw new Error('Console PNG exceeds the 10 MiB screenshot limit. Reduce guest resolution.');
      return { content: [{ type: 'text', text: JSON.stringify({ ...this.metadata(session), mimeType: 'image/png', capturedAt: new Date().toISOString() }) }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') }] };
    });
  }
  async status(vmID) {
    try { return await this.withSession(vmID, session => this.metadata(session)); }
    catch (error) { return { connected: false, reason: this.failure(error), transport: 'direct RFB', requiresVMwareTools: false }; }
  }
  async click(vmID, x, y, button = 'left') {
    return this.withSession(vmID, async session => {
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= session.client.width || y >= session.client.height || !['left', 'middle', 'right'].includes(button)) throw new Error('Click coordinates or button are outside the current VM framebuffer.');
      session.pointer = { x, y };
      try { session.client.pointerEvent(x, y, buttons[button]); await delay(this.keyDelayMs); }
      finally { if (!session.closed) session.client.pointerEvent(x, y, 0); }
      if (session.closed) throw new Error('Console disconnected during click. Input is never automatically replayed.');
      return { vmx: session.vmx, sent: true, x, y, button, channel: 'RFB PointerEvent' };
    });
  }
  async sendKeys(session, sequence) {
    const down = [];
    try {
      for (const code of sequence) { session.client.keyEvent(code, true); down.push(code); }
      await delay(this.keyDelayMs);
    } finally { for (const code of down.reverse()) if (!session.closed) session.client.keyEvent(code, false); }
    if (session.closed) throw new Error('Console disconnected during input. Input is never automatically replayed.');
  }
  async key(vmID, key) {
    const sequence = keySequence(key);
    return this.withSession(vmID, async session => { await this.sendKeys(session, sequence); return { vmx: session.vmx, sent: true, key, channel: 'RFB KeyEvent' }; });
  }
  async type(vmID, text) {
    consoleSchemas.console_type.parse({ vm_id: vmID, text });
    const characters = [...text.replace(/\r\n?/g, '\n')];
    return this.withSession(vmID, async session => {
      for (const character of characters) await this.sendKeys(session, shifted.test(character) ? [keysyms.ShiftLeft, keysymFromChar(character)] : [keysymFromChar(character)]);
      return { vmx: session.vmx, sent: true, characters: characters.length, channel: 'RFB KeyEvent', note: 'Typed as VM keyboard events; guest layout determines rendered text. No clipboard or host input APIs were used.' };
    });
  }
  async scroll(vmID, direction, amount = 1) {
    consoleSchemas.console_scroll.parse({ vm_id: vmID, direction, amount });
    return this.withSession(vmID, async session => {
      const previous = session.pointer || { x: Math.floor(session.client.width / 2), y: Math.floor(session.client.height / 2) };
      const point = { x: Math.min(previous.x, session.client.width - 1), y: Math.min(previous.y, session.client.height - 1) };
      const mask = { up: 8, down: 16, left: 32, right: 64 }[direction];
      for (let i = 0; i < amount; i++) {
        try { session.client.pointerEvent(point.x, point.y, mask); await delay(this.keyDelayMs); }
        finally { if (!session.closed) session.client.pointerEvent(point.x, point.y, 0); }
        if (session.closed) throw new Error('Console disconnected during scroll. Input is never automatically replayed.');
      }
      return { vmx: session.vmx, sent: true, direction, amount, channel: 'RFB PointerEvent wheel' };
    });
  }
}
