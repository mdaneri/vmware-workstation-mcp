import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

// Session-local reservations. Fail promptly instead of queueing a stale mutation.
export class Resources {
  constructor() { this.active = new Map(); this.context = new AsyncLocalStorage(); }
  key(file) { return process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file); }
  assert(files) {
    const owner = this.context.getStore();
    const overlaps = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
    for (const file of files.map(file => this.key(file))) for (const [held, token] of this.active) {
      if (token !== owner && overlaps(file, held)) throw Object.assign(new Error('A conflicting operation holds this VM or disk path. Wait for it to finish, inspect state, then retry.'), { code: 'RESOURCE_BUSY' });
    }
  }
  async use(files, callback) {
    this.assert(files);
    const token = this.context.getStore() || Symbol('resource-owner');
    const added = files.map(file => this.key(file)).filter(file => !this.active.has(file));
    for (const file of added) this.active.set(file, token);
    try { return await this.context.run(token, callback); }
    finally { for (const file of added) this.active.delete(file); }
  }
}
