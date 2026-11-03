import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { labSchema, labSchemas } from './lab-schemas.mjs';
import { requireOffline, readHardware } from './vm-hardware.mjs';
import { isWithin } from './workstation.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const exists = async file => fs.lstat(file).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = s => ({ dev: s.dev, ino: s.ino });
const same = (s, expected) => s && s.dev === expected?.dev && s.ino === expected?.ino;
const manifestName = 'lab-manifest.json', markerName = '.lab-owner';

export function orderLab(input) {
  const lab = labSchema.parse(input), nodes = new Map(lab.vms.map(v => [v.id, v]));
  if (nodes.size !== lab.vms.length) fail('INVALID_LAB', 'VM identifiers must be unique.');
  const done = new Set(), visiting = new Set(), order = [];
  function visit(id) {
    if (!nodes.has(id)) fail('INVALID_DEPENDENCY', 'Every dependency must name a VM in this lab.');
    if (visiting.has(id)) fail('DEPENDENCY_CYCLE', 'Lab dependency graph contains a cycle.');
    if (done.has(id)) return;
    visiting.add(id); const node = nodes.get(id);
    if (new Set(node.depends_on).size !== node.depends_on.length) fail('INVALID_DEPENDENCY', 'Duplicate dependencies are refused.');
    for (const dependency of node.depends_on) visit(dependency);
    visiting.delete(id); done.add(id); order.push(id);
    if ((node.readiness.kind === 'service') !== (node.readiness.port !== undefined)) fail('INVALID_READINESS', 'Supply port only for service readiness.');
    for (const network of Object.values(node.networks)) if (!Object.hasOwn(lab.networks, network)) fail('INVALID_NETWORK', 'VM mapping refers to an undeclared lab network.');
  }
  for (const id of nodes.keys()) visit(id);
  return { lab, order };
}

// A lab never adopts an existing directory, VM or LAN segment as owned.
// Intent is journalled before mutations. Ambiguous intents are never replayed.
export class LabManager {
  constructor({ backend, templates, lan, readiness, protectFile } = {}) { Object.assign(this, { backend, templates, lan, readiness, protectFile }); }
  async root(input) {
    const root = await this.backend.hostPath(input, 'destination-directory');
    await this.backend.hostPath(root, 'host-destination-directory');
    if (root !== path.resolve(input) || path.dirname(root) === root) fail('UNSAFE_LAB_PATH', 'Use a canonical lab directory without symlink aliases.');
    return root;
  }
  async writePrivate(file, text, flags = 'wx') {
    const handle = await fs.open(file, flags, 0o600);
    try { await this.protectFile(file); await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  }
  async save(m) {
    if (Buffer.byteLength(JSON.stringify(m)) > 4 * 1024 * 1024) fail('MANIFEST_LIMIT', 'Lab manifest exceeds 4 MiB.');
    const temporary = path.join(m.directory, `.lab-${randomUUID()}.tmp`);
    try { await this.writePrivate(temporary, JSON.stringify(m, null, 2)); await fs.rename(temporary, path.join(m.directory, manifestName)); }
    finally { await fs.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async read(input) {
    const directory = await this.root(input), rootStat = await fs.lstat(directory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('UNSAFE_MANIFEST', 'Lab root must be a regular directory.');
    const read = async name => {
      const filename = path.join(directory, name), stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024 || process.platform === 'linux' && (stat.uid !== process.getuid() || stat.mode & 0o077)) fail('UNSAFE_MANIFEST', 'Lab state must be private regular files under 4 MiB.');
      return fs.readFile(filename, 'utf8');
    };
    const m = JSON.parse(await read(manifestName));
    if (m.schema_version !== '1.0' || m.directory !== directory || !same(rootStat, m.identity) || !/^[0-9a-f-]{36}$/.test(m.owner) || await read(markerName) !== m.owner) fail('UNSAFE_MANIFEST', 'Lab ownership does not match this root.');
    const { lab, order } = orderLab(m.lab);
    if (JSON.stringify(order) !== JSON.stringify(m.order) || m.recipe !== digest({ lab, networks: m.bindings, media: m.media }) || !Array.isArray(m.vms) || m.vms.length !== lab.vms.length || !Array.isArray(m.segments) || m.segments.length > Object.keys(lab.networks).length) fail('UNSAFE_MANIFEST', 'Invalid lab manifest recipe or resources.');
    if (m.media_paths !== undefined && (!m.media_paths || Array.isArray(m.media_paths) || typeof m.media_paths !== 'object' || Object.keys(m.media_paths).length !== Object.keys(m.media).length || Object.keys(m.media).some(key => typeof m.media_paths[key] !== 'string' || !path.isAbsolute(m.media_paths[key]) || path.resolve(m.media_paths[key]) !== m.media_paths[key]))) fail('UNSAFE_MANIFEST', 'Resolved media paths must match the original binding names and be absolute normalized paths.');
    for (let i = 0; i < m.vms.length; i++) {
      const v = m.vms[i];
      if (v.id !== lab.vms[i].id || !Array.isArray(v.files) || v.files.length > 1024 || v.files.some(f => typeof f.path !== 'string' || path.isAbsolute(f.path) || !isWithin(path.join(directory, v.id), path.resolve(directory, f.path)))) fail('UNSAFE_MANIFEST', 'Manifest paths must stay inside the named VM directory.');
    }
    for (const s of m.segments) if (lab.networks[s.key]?.kind !== 'private_lan' || s.name !== this.segmentName(m, s.key)) fail('UNSAFE_MANIFEST', 'Manifest segment ownership is invalid.');
    return m;
  }
  segmentName(m, key) { return `lab-${m.lab.id}-${m.owner}-${key}`; }
  async canonicalMedia(media) {
    return Object.fromEntries(await Promise.all(Object.entries(media).map(async ([key, file]) => [key, await this.backend.hostPath(file, 'input-file')])));
  }
  async plan(input) {
    const { lab, order } = orderLab(input.lab), directory = await this.root(input.directory);
    if (await exists(directory)) fail('TARGET_EXISTS', 'Choose a NEW lab directory, or explicitly resume the matching manifest.');
    await this.backend.hostPath(path.dirname(directory), 'directory');
    const required = Object.keys(lab.networks).filter(k => lab.networks[k].kind === 'binding');
    if (Object.keys(input.networks).length !== required.length || required.some(k => !Object.hasOwn(input.networks, k))) fail('INVALID_NETWORK', 'Supply exactly the external lab network bindings. Private LANs are created by the lab.');
    const mediaNames = new Set(lab.vms.flatMap(v => Object.values(v.media)));
    if (Object.keys(input.media).length !== mediaNames.size || [...mediaNames].some(k => !Object.hasOwn(input.media, k))) fail('INVALID_MEDIA', 'Supply exactly the mapped lab media bindings.');
    const mediaPaths = await this.canonicalMedia(input.media);
    const bindings = { ...input.networks }, plannedSegments = [];
    for (const [key, network] of Object.entries(lab.networks)) if (network.kind === 'private_lan') {
      // Internal synthetic identifiers exist only in this read-only plan. The
      // real catalog IDs are resolved again by the same engine on deployment.
      const id = `planned:${key}`; plannedSegments.push({ id, name: id }); bindings[key] = { network: 'lan_segment', segment: id };
    }
    const plans = [];
    for (const id of order) {
      const v = lab.vms.find(v => v.id === id);
      const a = this.templateArgs(v, directory, bindings, mediaPaths);
      const { plan } = await this.templates.prepare(a, { plannedParent: path.dirname(directory), plannedSegments });
      plans.push({ id, depends_on: v.depends_on, readiness: v.readiness, ...plan });
    }
    const bytes = plans.reduce((n, p) => n + p.resources.virtual_disk_bytes, 0);
    await this.templates.hardware.disks.freeSpace(path.dirname(directory), bytes);
    return { valid: true, dry_run: true, plan: { schema_version: '1.0', directory, order, networks: lab.networks, media_paths: mediaPaths, vms: plans,
      resources: { cpus: plans.reduce((n, p) => n + p.resources.cpus, 0), memory_mb: plans.reduce((n, p) => n + p.resources.memory_mb, 0), virtual_disk_bytes: bytes },
      warnings: ['Blank VMs; no OS installation or guest readiness is implied.', 'Private LAN IDs are allocated at deployment; external networks/media remain unowned.', 'Reservations coordinate this server only. Keep external writers closed.', 'Destroy removes only recorded files; unexpected runtime/user files are retained. Ambiguous creation intents require manual inspection.'] } };
  }
  templateArgs(v, directory, networks, media, timeout_seconds = 600) {
    return { template: v.template, directory: path.join(directory, v.id), networks: Object.fromEntries(Object.entries(v.networks).map(([k, ref]) => [k, networks[ref]])), media: Object.fromEntries(Object.entries(v.media).map(([k, ref]) => [k, media[ref]])), timeout_seconds };
  }
  async validate(input) { return this.plan(labSchemas.lab_validate.parse(input)); }
  async inventory(directory, root, limit = { count: 0 }) {
    const records = [];
    for (const name of await fs.readdir(directory)) {
      if (++limit.count > 1024) fail('ARTIFACT_LIMIT', 'VM artifact count exceeds manifest bound.');
      const file = path.join(directory, name), s = await fs.lstat(file);
      if (s.isSymbolicLink() || !s.isDirectory() && (!s.isFile() || s.nlink !== 1)) fail('UNSAFE_ARTIFACT', 'Links and special VM artifacts cannot be owned.');
      records.push({ path: path.relative(root, file), directory: s.isDirectory(), ...identity(s) });
      if (s.isDirectory()) records.push(...await this.inventory(file, root, limit));
    }
    return records;
  }
  async verifyVM(m, v) {
    const directory = path.join(m.directory, v.id), s = await fs.lstat(directory);
    if (s.isSymbolicLink() || !s.isDirectory() || !same(s, v.identity)) fail('OWNERSHIP_CHANGED', 'VM directory identity changed; inspect before retrying.');
    for (const f of v.files) {
      const file = path.resolve(m.directory, f.path), stat = await exists(file);
      if (!stat && v.state === 'destroying') continue;
      if (!same(stat, f) || stat.isSymbolicLink() || stat.isDirectory() !== f.directory || !f.directory && (!stat.isFile() || stat.nlink !== 1) || await fs.realpath(file) !== file) fail('OWNERSHIP_CHANGED', 'A tracked artifact is missing, replaced, linked or outside its canonical path.');
    }
    const vmx = path.join(directory, 'machine.vmx');
    if (await exists(vmx)) {
      await this.backend.vmx(vmx);
      const { config } = await readHardware(vmx);
      // Older manifests did not persist resolved media. Resolve those bindings
      // read-only; new manifests retain deployment paths even if an alias moves
      // or installer media is subsequently removed. Recipe bindings stay intact.
      const mediaPaths = new Set(Object.values(m.media_paths ?? await this.canonicalMedia(m.media)).map(file => this.backend.resources.key(file)));
      for (const [key, value] of Object.entries(config)) if (/\.filename$|^workingdir$|^snapshot\.directory$|^checkpoint\.vmstate$|^suspend\.filename$/.test(key) && value) {
        // Original ISO bindings may be outside the lab and remain unowned.
        if (/\.filename$/.test(key) && config[key.replace('filename', 'devicetype')] === 'cdrom-image' && mediaPaths.has(this.backend.resources.key(path.resolve(directory, value)))) continue;
        if (!isWithin(directory, path.resolve(directory, value))) fail('EXTERNAL_BACKING', 'VM now references storage/state outside its owned directory.');
      }
    }
    return vmx;
  }
  async deploy(input, extra = {}) {
    const a = labSchemas.lab_deploy.parse(input), root = await this.root(a.directory);
    if (!a.dry_run && !a.confirm) fail('CONFIRM_REQUIRED', 'Deployment requires confirm=true for this lab and requested startup.');
    return this.backend.resources.use([root], async () => {
      let m;
      if (a.resume) {
        m = await this.read(root);
        if (m.recipe !== digest({ lab: orderLab(a.lab).lab, networks: a.networks, media: a.media }) || m.state === 'destroyed' || m.state === 'destroying') fail('RECIPE_CHANGED', 'Resume requires the original recipe/bindings and an undestroyed lab.');
        if (a.dry_run) return { dry_run: true, manifest: m, action: 'Resume only verified complete VMs and untouched pending resources; uncertain intents are refused.' };
      } else {
        const planned = await this.plan(a); if (a.dry_run) return planned;
        await this.protectFile.preflight?.(); extra.signal?.throwIfAborted();
        await fs.mkdir(root, { mode: 0o700 });
        m = { schema_version: '1.0', directory: root, identity: identity(await fs.lstat(root)), owner: randomUUID(), lab: orderLab(a.lab).lab,
          order: planned.plan.order, bindings: a.networks, media: a.media, media_paths: planned.plan.media_paths, state: 'deploying', segments: [],
          vms: a.lab.vms.map(v => ({ id: v.id, state: 'pending', files: [] })) };
        m.recipe = digest({ lab: m.lab, networks: m.bindings, media: m.media });
        await this.writePrivate(path.join(root, markerName), m.owner); await this.save(m);
      }
      return this.record(m, 'deploy', async () => {
        m.media_paths ??= await this.canonicalMedia(m.media);
        const bindings = { ...m.bindings };
        for (const [key, n] of Object.entries(m.lab.networks)) if (n.kind === 'private_lan') {
          extra.signal?.throwIfAborted(); let s = m.segments.find(s => s.key === key);
          if (!s) {
            s = { key, name: this.segmentName(m, key), state: 'creating' }; m.segments.push(s); await this.save(m);
            if ((await this.lan.list()).segments.some(e => e.name.toLowerCase() === s.name.toLowerCase())) fail('SEGMENT_COLLISION', 'Planned private segment already exists; it will not be adopted.');
            const result = await this.lan.create({ name: s.name });
            if (!result.created) fail('SEGMENT_COLLISION', 'Concurrent segment creation; ownership is unknown.');
            s.id = result.segment.id; s.state = 'created'; await this.save(m);
          } else if (s.state !== 'created') fail('UNCERTAIN_RESOURCE', 'Segment creation was interrupted; inspect the intent before recovery.');
          const current = (await this.lan.list()).segments.find(e => e.id === s.id && e.name === s.name);
          if (!current) fail('OWNERSHIP_CHANGED', 'Owned LAN segment changed or disappeared.');
          bindings[key] = { network: 'lan_segment', segment: s.id };
        }
        for (const id of m.order) {
          extra.signal?.throwIfAborted(); const v = m.vms.find(v => v.id === id), node = m.lab.vms.find(v => v.id === id);
          if (v.state === 'created') { await this.verifyVM(m, v); continue; }
          if (!['pending', 'creating'].includes(v.state) || await exists(path.join(root, id))) fail('UNCERTAIN_RESOURCE', 'Partial VM directory exists. It is never adopted or overwritten; inspect it before recovery.');
          v.state = 'creating'; await this.save(m);
          await this.templates.deploy({ ...this.templateArgs(node, root, bindings, m.media_paths, a.timeout_seconds), dry_run: false, confirm: true }, extra);
          const directory = path.join(root, id); v.identity = identity(await fs.lstat(directory)); v.files = await this.inventory(directory, root); v.state = 'created'; await this.save(m);
        }
        m.state = 'deployed'; await this.save(m);
        if (a.start) await this.startVMs(m, extra);
      });
    });
  }
  async record(m, action, callback) {
    try { await callback(); delete m.failure; await this.save(m); return { dry_run: false, action, manifest: m }; }
    catch (error) {
      m.failure = { action, code: /^[A-Z_]{2,64}$/.test(error.code || '') ? error.code : 'LAB_ACTION_FAILED', outcome: 'partial_or_unknown', recovery: 'Inspect lab_status and retained artifacts. Resume only the same recipe; uncertain creation intents are never replayed. No automatic rollback or hard-stop fallback.' };
      await this.save(m);
      throw Object.assign(new Error('Lab action failed or was cancelled. Retained manifest records completed resources and uncertain intent; inspect lab_status before retrying.'), { code: 'LAB_PARTIAL_FAILURE', details: { directory: m.directory, failure: m.failure, vms: m.vms.map(v => ({ id: v.id, state: v.state })), segments: m.segments } });
    }
  }
  async status(input) {
    const a = labSchemas.lab_status.parse(input), m = await this.read(a.directory), observations = [];
    for (const v of m.vms) {
      if (v.state !== 'created') { observations.push({ id: v.id, state: v.state }); continue; }
      try { const vmx = await this.verifyVM(m, v); observations.push({ id: v.id, state: v.state, running: (await this.backend.details(vmx)).running, readiness: 'not_observed' }); }
      catch { observations.push({ id: v.id, state: 'unknown', ownership: 'unverified' }); }
    }
    return { manifest: m, observations, note: 'Manifest records completed steps, not current guest readiness. Power and readiness are separate observations.' };
  }
  async startVMs(m, extra) {
    if (m.vms.some(v => v.state !== 'created')) fail('INCOMPLETE_LAB', 'Start requires every VM to be completely deployed.');
    for (const id of m.order) {
      extra.signal?.throwIfAborted(); const v = m.vms.find(v => v.id === id), node = m.lab.vms.find(v => v.id === id);
      if (v.state !== 'created') fail('INCOMPLETE_LAB', 'Start requires every VM to be completely deployed.');
      const vmx = await this.verifyVM(m, v);
      if (!(await this.backend.details(vmx)).running) {
        await requireOffline(this.backend, vmx); v.power_intent = 'start'; await this.save(m);
        await this.backend.power(vmx, 'start', 'soft', false);
        if (!(await this.backend.details(vmx)).running) fail('POWER_UNVERIFIED', 'Start command did not establish an observed running VM.');
      }
      v.power_intent = null; const r = node.readiness;
      v.readiness = { kind: r.kind, ready: null }; await this.save(m);
      if (r.kind !== 'none') {
        let result;
        for (let attempt = 0; attempt < r.attempts; attempt++) {
          extra.signal?.throwIfAborted();
          result = await this.readiness.wait(r.kind, { vmx, timeout_seconds: r.timeout_seconds, ...(r.kind === 'service' ? { port: r.port, protocol: r.protocol, path: r.path, expected_status: r.expected_status } : {}) }, extra);
          if (result.ready || extra.signal?.aborted || result.result === 'cancelled') break;
        }
        v.readiness = { kind: r.kind, ready: result.ready === true }; await this.save(m);
        if (!result.ready) fail('READINESS_FAILED', 'Dependency readiness failed within the bounded attempts. Dependents were not started.');
      }
    }
    m.state = 'started'; await this.save(m);
  }
  async action(name, input, extra = {}) {
    const a = labSchemas[`lab_${name}`].parse(input), root = await this.root(a.directory);
    if (!a.dry_run && !a.confirm) fail('CONFIRM_REQUIRED', 'Explicit confirm=true is required for this lab lifecycle action.');
    return this.backend.resources.use([root], async () => {
      const m = await this.read(root);
      if (a.dry_run) return { dry_run: true, action: name, directory: root, order: name === 'start' ? m.order : [...m.order].reverse(), vms: m.vms, segments: m.segments, note: 'Destroy requires offline VMs and removes only recorded files. Unknown files and ambiguous intents are retained; no VMnet or external resource deletion.' };
      return this.record(m, name, async () => {
        if (name === 'start') { if (['destroying', 'destroyed'].includes(m.state)) fail('INCOMPLETE_LAB', 'Cannot start a destroyed lab.'); return this.startVMs(m, extra); }
        if (name === 'stop') {
          for (const id of [...m.order].reverse()) {
            extra.signal?.throwIfAborted(); const v = m.vms.find(v => v.id === id);
            if (v.state !== 'created') continue;
            const vmx = await this.verifyVM(m, v);
            if ((await this.backend.details(vmx)).running) {
              v.power_intent = 'stop'; await this.save(m); await this.backend.power(vmx, 'stop', a.mode, false);
              if ((await this.backend.details(vmx)).running) fail('POWER_UNVERIFIED', 'Stop command has not established power-off. No hard fallback.');
            }
            v.power_intent = null; v.readiness = { kind: 'none', ready: null }; await this.save(m);
          }
          m.state = 'stopped'; return;
        }
        // Validate the entire known set before the first deletion. Never stop
        // implicitly, recursively remove directories, or invoke deleteVM.
        const inventory = await this.backend.listVMs();
        if (inventory.warnings.length) fail('INVENTORY_UNAVAILABLE', 'Restore inventory before safe teardown.');
        const labVMs = new Set(m.vms.map(v => this.backend.resources.key(path.join(root, v.id, 'machine.vmx'))));
        for (const vm of inventory.vms) {
          if (labVMs.has(this.backend.resources.key(vm.vmx)) && vm.registered) fail('VM_REGISTERED', 'Unregister lab VMs explicitly before destroying their files.');
        }
        for (const v of m.vms) if (!['pending', 'destroyed'].includes(v.state)) {
          if (!['created', 'destroying'].includes(v.state)) fail('UNCERTAIN_RESOURCE', 'Uncertain VM creation must be inspected manually before teardown.');
          const vmx = await this.verifyVM(m, v); if (await exists(vmx)) {
            await requireOffline(this.backend, vmx);
            if ((await this.backend.snapshots(vmx)).snapshots.length) fail('VM_SNAPSHOTS', 'Lab teardown refuses snapshot chains; inspect and manage snapshots separately.');
          }
          else if (v.state !== 'destroying') fail('OWNERSHIP_CHANGED', 'Missing VMX prevents safe teardown.');
          const known = new Set(v.files.map(f => f.path));
          if ((await this.inventory(path.join(root, v.id), root)).some(f => !known.has(f.path) && /\.(?:vmdk|vmx)$/i.test(f.path))) fail('UNKNOWN_STORAGE', 'Unexpected VM/disk artifacts require manual inspection before teardown.');
        }
        if (m.segments.some(s => !['created', 'removed'].includes(s.state))) fail('UNCERTAIN_RESOURCE', 'Uncertain network creation must be inspected manually.');
        // Include complete unregistered lab VMs in the disk manager's inventory
        // checks. A different VMX can name a child/descendant or a separate
        // descriptor sharing an extent, rather than the owned parent itself.
        const vmxPaths = [];
        for (const v of m.vms) {
          const vmx = path.join(root, v.id, 'machine.vmx');
          if (['created', 'destroying'].includes(v.state) && await exists(vmx)) vmxPaths.push(vmx);
        }
        for (const v of m.vms) if (['created', 'destroying'].includes(v.state)) for (const f of v.files) {
          if (f.directory || !/\.vmdk$/i.test(f.path)) continue;
          const disk = path.resolve(root, f.path); if (!await exists(disk)) continue;
          const info = await this.templates.hardware.disks.inspect({ disk });
          const references = await this.templates.hardware.disks.preflight(info, vmxPaths);
          if (references.some(r => !labVMs.has(this.backend.resources.key(r.vmx)))) fail('SHARED_DISK', 'Another known VM references a lab-owned disk; it was retained.');
        }
        m.state = 'destroying'; await this.save(m);
        for (const id of [...m.order].reverse()) {
          extra.signal?.throwIfAborted(); const v = m.vms.find(v => v.id === id);
          if (['pending', 'destroyed'].includes(v.state)) continue;
          await this.verifyVM(m, v); v.state = 'destroying'; await this.save(m);
          for (const f of [...v.files].reverse()) {
            const file = path.resolve(root, f.path), stat = await exists(file); if (!stat) continue;
            if (!same(stat, f) || stat.isSymbolicLink() || await fs.realpath(file) !== file) fail('OWNERSHIP_CHANGED', 'Tracked artifact changed during teardown.');
            if (f.directory) await fs.rmdir(file).catch(e => { if (e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST') throw e; });
            else await fs.unlink(file);
          }
          const directory = path.join(root, id);
          v.retained_files = await fs.readdir(directory); v.state = 'destroyed'; await this.save(m);
          // Keep the empty member directory as an ownership/recovery anchor.
        }
        for (const s of m.segments) if (s.state === 'created') {
          extra.signal?.throwIfAborted();
          const found = (await this.lan.list()).segments.find(e => e.id === s.id);
          if (found && found.name !== s.name) fail('OWNERSHIP_CHANGED', 'LAN segment identity changed; it was retained.');
          if (found) await this.lan.remove({ segment: s.id }); s.state = 'removed'; await this.save(m);
        }
        m.state = 'destroyed';
      });
    });
  }
}
