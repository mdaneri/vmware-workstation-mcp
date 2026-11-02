import fs from 'node:fs/promises';
import path from 'node:path';
import { credentialsPath } from './host-platform.mjs';
import { readPrivateFile } from './local-file-security.mjs';

export class Credentials {
  constructor(env = process.env) {
    this.env = env; this.secrets = new Set();
    this.filename = credentialsPath(env);
  }
  async load() {
    if (!this.filename) return {};
    try {
      const result = JSON.parse(process.platform === 'linux' ? await readPrivateFile(this.filename) : await fs.readFile(this.filename, 'utf8'));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
      return result;
    } catch (error) {
      if (!this.env.VMWARE_CREDENTIALS_FILE && error.code === 'ENOENT') return {};
      throw new Error('Cannot read local VMware credentials as a JSON object. Check VMWARE_CREDENTIALS_FILE or the default credentials file, permissions, and format. On Linux use an owned regular file with mode 600.');
    }
  }
  profile(value = 'default') {
    if (!/^[a-z][a-z0-9_]{0,31}$/i.test(value)) throw new Error('Credential profile must start with a letter and contain at most 32 letters, digits or underscores.');
    return value.toLowerCase();
  }
  remember(password) {
    if (typeof password === 'string' && password) {
      this.secrets.add(password);
      this.secrets.add(encodeURIComponent(password));
      this.secrets.add(new URLSearchParams({ secret: password }).toString().slice(7));
      this.secrets.add(JSON.stringify(password).slice(1, -1));
    }
    return password;
  }
  async guest(profile = 'default') {
    const name = this.profile(profile);
    const file = await this.load();
    const prefix = `VMWARE_GUEST_${name.toUpperCase()}`;
    const username = this.env[`${prefix}_USERNAME`] ?? file.guest?.[name]?.username;
    const password = this.remember(this.env[`${prefix}_PASSWORD`] ?? file.guest?.[name]?.password);
    if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) throw new Error(`Guest credential profile '${name}' is not configured. Use VMWARE_CREDENTIALS_FILE or ${prefix}_USERNAME/PASSWORD; never paste passwords into chat.`);
    return { username, password };
  }
  async vm(profile) {
    const name = this.profile(profile);
    const file = await this.load();
    const password = this.remember(this.env[`VMWARE_VM_${name.toUpperCase()}_PASSWORD`] ?? file.vm?.[name]?.password);
    if (typeof password !== 'string' || !password) throw new Error(`Encrypted VM password profile '${name}' is not configured.`);
    return password;
  }
  async console(vmx, requestedProfile) {
    const file = await this.load();
    const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    const profiles = file.console || {};
    const resolved = await Promise.all(Object.entries(profiles).map(async ([name, entry]) => [name, typeof entry?.vmx === 'string' ? await fs.realpath(entry.vmx).catch(() => entry.vmx) : null]));
    const matches = resolved.filter(([, target]) => target && canonical(target) === canonical(vmx));
    if (!requestedProfile && matches.length > 1) throw new Error('Multiple console profiles identify this VM. Use its configured profile alias as vm_id.');
    const name = this.profile(requestedProfile || matches[0]?.[0] || 'default');
    const entry = profiles[name];
    const profileTarget = resolved.find(([profile]) => profile === name)?.[1];
    if (profileTarget && canonical(profileTarget) !== canonical(vmx)) throw new Error('Console credential profile belongs to another VM.');
    const password = this.remember(this.env[`VMWARE_CONSOLE_${name.toUpperCase()}_PASSWORD`] ?? entry?.password);
    if (typeof password !== 'string' || !/^[\x20-\x7e]{1,8}$/.test(password)) throw new Error(`Console password profile '${name}' must contain 1 to 8 ASCII characters. Configure it locally; never paste passwords into chat.`);
    return { profile: name, password };
  }
  async rest() {
    const file = await this.load();
    const username = this.env.VMWARE_REST_USERNAME ?? file.rest?.username;
    const password = this.remember(this.env.VMWARE_REST_PASSWORD ?? file.rest?.password);
    if (typeof username !== 'string' || !username || typeof password !== 'string' || !password || username.includes(':')) throw new Error('REST credentials are not configured. Set VMWARE_REST_USERNAME/PASSWORD or VMWARE_CREDENTIALS_FILE. REST usernames cannot contain colons.');
    const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    this.secrets.add(token);
    return { authorization: `Basic ${token}` };
  }
  redact(text) {
    let result = text;
    for (const [name, value] of Object.entries(this.env)) if (/^VMWARE_.*PASSWORD$/.test(name)) this.remember(value);
    for (const value of [...this.secrets].sort((a, b) => b.length - a.length)) result = result.split(value).join('[REDACTED]');
    return result;
  }
}
