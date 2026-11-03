import { z } from 'zod';
import catalog from './catalogs/rest.json' with { type: 'json' };
import { snake } from './vmrun-commands.mjs';

export const restOperations = catalog.operations;
export const restProvenance = { source: catalog.source, sha256: catalog.sha256 };
export const restToolName = operation => `rest_${snake(operation.id === 'updataSharedFolder' ? 'updateSharedFolder' : operation.id)}`;
const parameterKey = name => snake(name.replace(/\s+/g, '_'));

export function schemaFromAPI(schema) {
  let result;
  if (schema.enum) result = z.union(schema.enum.map(value => z.literal(value)));
  else if (schema.type === 'object') {
    const shape = {};
    for (const [key, value] of Object.entries(schema.properties || {})) {
      let field = schemaFromAPI(value);
      if (!schema.required?.includes(key)) field = field.optional();
      shape[key] = field;
    }
    result = z.object(shape).strict();
  } else if (schema.type === 'array') result = z.array(schemaFromAPI(schema.items)).max(10000);
  else if (schema.type === 'integer') result = z.number().int();
  else if (schema.type === 'number') result = z.number().finite();
  else if (schema.type === 'boolean') result = z.boolean();
  else result = z.string().max(1024 * 1024).refine(value => !value.includes('\0'));
  if (schema.minimum !== undefined) result = result.refine(v => v >= schema.minimum);
  if (schema.maximum !== undefined) result = result.refine(v => v <= schema.maximum);
  return result;
}

export function restSchema(operation) {
  const fields = {};
  for (const p of operation.parameters) {
    if (p.secret) {
      fields.vm_password_profile = z.string().optional().describe('Local encrypted-VM password profile name, never the password.');
      continue;
    }
    let field = schemaFromAPI(p.schema);
    if (p.in === 'path') field = field.refine(value => !['.', '..'].includes(String(value)) && !/[\\/\x00-\x1f]/.test(String(value)), 'Path parameters must be single path segments.');
    if (!p.required) field = field.optional();
    fields[parameterKey(p.name)] = field;
  }
  fields.timeout_seconds = z.number().int().min(1).max(3600).default(120);
  return z.object(fields).strict();
}

export class RestClient {
  constructor({ env = process.env, credentials, backend, fetcher = fetch, coordinateDiskEdits = false } = {}) {
    this.env = env; this.credentials = credentials; this.backend = backend; this.fetcher = fetcher;
    this.tail = Promise.resolve();
    this.coordinateDiskEdits = coordinateDiskEdits;
  }
  baseURL() {
    const url = new URL(this.env.VMWARE_REST_URL || 'http://127.0.0.1:8697');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('VMWARE_REST_URL must be an HTTP(S) origin without credentials, path, query, or fragment.');
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !loopback) throw new Error('Remote REST connections require HTTPS. Plain HTTP is limited to loopback.');
    return url.origin;
  }
  async request(method, route, { body, password, timeout = 120000 } = {}) {
    const url = new URL(route, this.baseURL());
    if (url.origin !== this.baseURL() || !url.pathname.startsWith('/api/')) throw new Error('REST route is outside the Workstation API.');
    if (password) url.searchParams.set('vmPassword', password);
    const auth = await this.credentials.rest();
    try {
      const response = await this.fetcher(url, {
        method, headers: { Authorization: auth.authorization, Accept: 'application/vnd.vmware.vmw.rest-v1+json', ...(body !== undefined ? { 'Content-Type': 'application/vnd.vmware.vmw.rest-v1+json' } : {}) },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(timeout),
      });
      const reader = response.body?.getReader();
      const chunks = []; let size = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 1024 * 1024) { await reader.cancel(); throw new Error('RESPONSE_TOO_LARGE'); }
          chunks.push(Buffer.from(value));
        }
      }
      const text = this.credentials.redact(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) throw Object.assign(new Error('HTTP_ERROR'), { status: response.status, details: text.slice(0, 4000) });
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = text; } }
      return { status: response.status, data };
    } catch (error) {
      const uncertain = method !== 'GET' ? ' The operation may have taken effect; inspect state before retrying.' : '';
      const reason = error.status ? `HTTP ${error.status}` : error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : error.message === 'RESPONSE_TOO_LARGE' ? 'response exceeded 1 MiB' : 'connection, TLS, or response failure';
      throw new Error(`Workstation REST ${method} failed (${reason}).${uncertain}${error.details ? ` ${this.credentials.redact(error.details)}` : ''}`);
    }
  }
  async assertVM(id) {
    if (!this.env.VMWARE_ALLOWED_ROOTS) return;
    const result = await this.request('GET', '/api/vms');
    if (!Array.isArray(result.data)) throw new Error('Cannot resolve REST VM ID to a VMX for allowed-root validation.');
    const record = result.data.find(vm => vm.id === id);
    if (!record?.path) throw new Error('REST VM ID was not found in inventory.');
    await this.backend.vmx(record.path);
  }
  async execute(operation, input) {
    const a = restSchema(operation).parse(input);
    const job = this.tail.then(async () => {
      let route = operation.path;
      let body;
      let password;
      for (const p of operation.parameters) {
        const value = a[parameterKey(p.name)];
        if (p.secret) { if (a.vm_password_profile) password = await this.credentials.vm(a.vm_password_profile); continue; }
        if (p.in === 'path') route = route.replace(`{${p.name}}`, encodeURIComponent(value));
        else if (p.in === 'body') body = value;
      }
      if (a.id !== undefined && operation.path.startsWith('/api/vms/')) await this.assertVM(a.id);
      if (operation.id === 'createVM' && body?.parentId) await this.assertVM(body.parentId);
      if (operation.id === 'registerVM' && body?.path) body.path = await this.backend.vmx(body.path);
      if (body?.host_path) body.host_path = await this.backend.hostPath(body.host_path, 'directory');
      const request = () => this.request(operation.method, route, { body, password, timeout: a.timeout_seconds * 1000 });
      let result;
      const id = a.id ?? (operation.id === 'createVM' ? body?.parentId : undefined);
      const coordinate = this.coordinateDiskEdits && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(this.baseURL()).hostname);
      if (coordinate && operation.method !== 'GET' && id !== undefined) {
        const inventory = await this.request('GET', '/api/vms');
        const record = Array.isArray(inventory.data) && inventory.data.find(vm => vm.id === id);
        if (!record?.path) throw new Error('Cannot resolve REST VM ID to coordinate safe disk edits. Refresh REST inventory.');
        const vmx = await this.backend.vmx(record.path);
        result = await this.backend.resources.use([vmx], request);
      } else if (coordinate && operation.id === 'registerVM' && body?.path) {
        result = await this.backend.resources.use([body.path], request);
      } else result = await request();
      return { operation: operation.id, ...result };
    });
    this.tail = job.catch(() => {});
    return job;
  }
}
