// Opt-in native VMware validation. Never run in default tests or hosted CI.
// Required: VMWARE_READINESS_LIVE=1 and VMWARE_READINESS_LIVE_ISO (local live
// Linux ISO with Tools, DHCP, and a read-only service already configured).
// Optional: VMWARE_READINESS_LIVE_PORT=80, _PROTOCOL=tcp|http|https,
// _GUEST_PROFILE (locally configured credentials), _REST=1 (read-only REST),
// _LAN_SEGMENT (existing segment; GUI must be closed). LAN mode creates two
// disposable VMs and requires guest credentials + /bin/ping in the live ISO;
// it checks guest-to-guest traffic, not host connectivity to a private segment.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Workstation, isWithin } from '../src/workstation.mjs';

const env = process.env;
if (env.VMWARE_READINESS_LIVE !== '1') throw new Error('Set VMWARE_READINESS_LIVE=1 only after authorizing disposable VM creation, boot and hard stop.');
if (/microsoft|wsl/i.test(os.release())) throw new Error('This live harness requires native Windows/Linux VMware, not WSL.');
if (!env.VMWARE_READINESS_LIVE_ISO) throw new Error('Select a local disposable live Linux ISO with Tools and DHCP using VMWARE_READINESS_LIVE_ISO.');
const iso = await new Workstation().hostPath(env.VMWARE_READINESS_LIVE_ISO, 'input-file');
if (path.extname(iso).toLowerCase() !== '.iso') throw new Error('Select a local ISO file.');
const segment = env.VMWARE_READINESS_LIVE_LAN_SEGMENT;
const guestProfile = env.VMWARE_READINESS_LIVE_GUEST_PROFILE;
if (segment && !guestProfile) throw new Error('LAN connectivity validation requires a configured live-ISO guest profile.');
const port = Number(env.VMWARE_READINESS_LIVE_PORT || 80);
const protocol = env.VMWARE_READINESS_LIVE_PROTOCOL || 'tcp';
assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535 && ['tcp', 'http', 'https'].includes(protocol));
await fs.mkdir('test-vms', { recursive: true });
const root = await fs.realpath(await fs.mkdtemp(path.resolve('test-vms', 'readiness-live-')));
const inventory = path.join(root, 'inventory.vmls'); await fs.writeFile(inventory, '');
const evidence = { started_at: new Date().toISOString(), platform: process.platform, release: os.release(), passed: false, checks: {}, limitations: ['New live-ISO guests only. No installation, host UI, console capture or existing VM mutations. Artifacts retained.'] };
const client = new Client({ name: 'disposable-readiness-live', version: '0.8.0' });
const targets = []; const powerAttempted = new Set();
async function call(name, args = {}) {
  for (const field of ['vmx', 'vm_id', 'directory', 'destination_directory', 'host_path']) if (args[field]) {
    assert.ok(path.isAbsolute(args[field]) && isWithin(root, path.resolve(args[field])), 'Explicit targets must stay in disposable root.');
    let ancestor = args[field];
    while (true) {
      try { assert.ok(isWithin(root, await fs.realpath(ancestor))); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); }
    }
  }
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 150000 });
  assert.ok(!result.isError, `${name} failed; inspect local configuration. Raw output not included in evidence.`);
  return JSON.parse(result.content[0].text);
}
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe', env: { ...env, VMWARE_INVENTORY_PATH: inventory, VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: [root, path.dirname(iso)].join(path.delimiter), VMWARE_DIAGNOSTICS_ROOTS: root } }));
  const before = (await call('list_vms')).vms.filter(vm => vm.running).map(vm => vm.vmx).sort();
  const ips = [];
  for (let index = 0; index < (segment ? 2 : 1); index++) {
    const { vmx } = await call('create_vm', { directory: path.join(root, `vm-${index}`), name: `Disposable readiness ${index}`, iso_path: iso, network: segment ? 'hostonly' : 'nat', memory_mb: 2048, cpus: 2, disk_gb: 1 });
    targets.push(vmx);
    const off = await call('vm_wait_for_boot', { vmx, timeout_seconds: 1 }); assert.equal(off.ready, false); assert.equal(off.state, 'powered_off');
    if (segment) await call('attach_vm_adapter_to_lan_segment', { vmx, adapter: 0, segment });
    powerAttempted.add(vmx); await call('vm_power', { vmx, action: 'start', gui: false });
    const boot = await call('vm_wait_for_boot', { vmx, timeout_seconds: 120 }); assert.equal(boot.ready, true);
    const ip = await call('vm_wait_for_ip', { vmx, timeout_seconds: 120 }); assert.equal(ip.ready, true); ips.push(ip.address);
    evidence.checks[`guest_${index}_tools_ip`] = 'passed';
    if (guestProfile) {
      await call('vmrun_list_processes_in_guest', { vmx, guest_profile: guestProfile });
      evidence.checks[`guest_${index}_authenticated_operation`] = 'passed';
    }
    if (!segment) {
      const service = await call('vm_wait_for_service', { vmx, port, protocol, timeout_seconds: 120 }); assert.equal(service.ready, true);
      evidence.checks.service = { result: 'passed', criterion: protocol };
    }
    const bundle = await call('vm_collect_diagnostics', { vmx, destination_directory: path.join(root, `diagnostics-${index}`) }); assert.equal(bundle.report.console.included, false);
  }
  if (segment) {
    // The only guest script is in a new disposable guest. vmrun host execution
    // still uses execFile with separate arguments and shell:false. Capture only
    // a generated success marker, never process output or guest secrets.
    assert.ok(netIP(ips[1]), 'LAN probe requires a plain IPv4 address');
    const marker = randomUUID(); const guestFile = `/tmp/readiness-${marker}`;
    await call('vmrun_run_script_in_guest', { vmx: targets[0], guest_profile: guestProfile, interpreter: '/bin/sh', script: `/bin/ping -c 1 -W 5 ${ips[1]} >/dev/null 2>&1 && printf '${marker}' > '${guestFile}'` });
    const hostFile = path.join(root, 'lan-marker.txt');
    await call('vmrun_copy_file_from_guest_to_host', { vmx: targets[0], guest_profile: guestProfile, guest_path: guestFile, host_path: hostFile });
    assert.equal(await fs.readFile(hostFile, 'utf8'), marker);
    evidence.checks.lan_connectivity = 'passed'; evidence.checks.service = 'skipped_private_segment_has_no_host_route';
  } else evidence.checks.lan_connectivity = 'skipped_no_disposable_peer_segment';
  if (!guestProfile) evidence.checks.authenticated_guest = 'skipped_no_live_iso_guest_profile';
  if (env.VMWARE_READINESS_LIVE_REST === '1') {
    const result = await call('rest_get_all_vms'); assert.ok(result.status >= 200 && result.status < 300);
    evidence.checks.rest_authenticated_inventory = 'passed';
  } else evidence.checks.rest_authenticated_inventory = 'skipped_not_opted_in';
  for (const vmx of targets) { await call('vm_power', { vmx, action: 'stop', mode: 'hard' }); powerAttempted.delete(vmx); }
  const after = (await call('list_vms')).vms.filter(vm => vm.running).map(vm => vm.vmx).sort(); assert.deepEqual(after, before);
  evidence.passed = true;
} finally {
  for (const vmx of powerAttempted) await call('vm_power', { vmx, action: 'stop', mode: 'hard' }).catch(() => { evidence.checks.cleanup = 'failed_stop_disposable_vm_inspect_manually'; });
  // Preserve VM files and attached segment configuration for inspection. No
  // catalog entry was created or removed; the supplied segment remains intact.
  evidence.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  await client.close(); console.log(`Readiness live evidence: ${path.join(root, 'evidence.json')}`);
}
function netIP(value) { return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value); }
