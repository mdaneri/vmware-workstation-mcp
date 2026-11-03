// Explicit opt-in integration test. Creates two isolated VMs, never touches an existing VM.
// Host focus is observed read-only. No host capture, input, or activation APIs are used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import pngjs from 'pngjs';
import { Workstation } from '../src/workstation.mjs';

if (process.platform !== 'win32') throw new Error('This native integration test requires Windows and VMware Workstation.');
const root = path.resolve('test-vms', `console-live-${Date.now()}`); await fs.mkdir(root, { recursive: true });
const evidence = { startedAt: new Date().toISOString(), root, vms: [], operations: [], passed: false, limitations: ['No OS installation ISO was supplied; live validation covers BIOS/UEFI consoles without VMware Tools.'] };
const backend = new Workstation();
const observer = spawn('pwsh', ['-NoProfile', '-File', path.resolve('scripts/Observe-Foreground.ps1')], { windowsHide: true });
const focus = []; let pending = ''; let observerError = '';
observer.stdout.on('data', chunk => { pending += chunk; const lines = pending.split(/\r?\n/); pending = lines.pop(); for (const line of lines) if (line) focus.push(JSON.parse(line)); });
observer.stderr.on('data', chunk => { observerError += chunk; });
const credentialsPath = path.join(root, 'credentials.json');
const protect = filename => backend.execute('pwsh', ['-NoProfile', '-File', path.resolve('vmware-workstation/scripts/Protect-LocalFile.ps1'), '-LiteralPath', filename], { windowsHide: true, shell: false, timeout: 10000, encoding: 'utf8' });
const credentialData = { console: {} };
const client = new Client({ name: 'native-vnc-focus-isolation-integration', version: '0.2.0' });
const testEnv = { ...process.env, VMWARE_CREDENTIALS_FILE: credentialsPath };
let connected = false;
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  assert.ok(!result.isError, `${name}: ${result.content.filter(c => c.type === 'text').map(c => c.text).join(' ')}`);
  const data = JSON.parse(result.content.find(c => c.type === 'text').text);
  evidence.operations.push({ tool: name, vm: args.vm_id || args.vmx || null, result: name === 'console_type' ? { sent: data.sent, characters: data.characters } : data });
  return { data, content: result.content };
}
async function frame(vm, suffix) {
  const result = await call('console_screenshot', { vm_id: vm.alias });
  const png = Buffer.from(result.content.find(c => c.type === 'image').data, 'base64');
  const image = pngjs.PNG.sync.read(png);
  assert.ok(image.width > 0 && image.height > 0);
  assert.ok(new Set(image.data).size > 2, 'VM screenshot must contain real firmware pixels.');
  const filename = path.join(root, `${vm.alias}-${suffix}.png`); await fs.writeFile(filename, png);
  return { filename, width: image.width, height: image.height, hash: createHash('sha256').update(image.data).digest('hex') };
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
try {
  await fs.writeFile(credentialsPath, '', { flag: 'wx' }); await protect(credentialsPath);
  await fs.writeFile(credentialsPath, JSON.stringify(credentialData));
  for (let i = 0; !focus.length && i < 100; i++) await delay(50);
  assert.ok(focus.length && focus[0].processName && !/^vmware/i.test(focus[0].processName), 'Bring a non-VMware app to the foreground before running this test.');
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('vmware-workstation/server/server.cjs')], env: testEnv, stderr: 'pipe' })); connected = true;
  const tools = (await client.listTools()).tools; assert.equal(tools.length, 148);
  for (const firmware of ['bios', 'efi']) {
    const alias = firmware === 'bios' ? 'bios_console' : 'uefi_console';
    const created = (await call('create_vm', { directory: path.join(root, alias), name: `MCP VNC ${firmware.toUpperCase()} Integration`, firmware, memory_mb: 256, cpus: 1, disk_gb: 1, network: 'none' })).data;
    const vm = { alias, vmx: created.vmx, port: await freePort(), firmware, started: false }; evidence.vms.push(vm);
    credentialData.console[alias] = { vmx: vm.vmx, password: randomBytes(6).toString('base64url') };
    await fs.writeFile(credentialsPath, JSON.stringify(credentialData));
    await backend.execute(process.execPath, [path.resolve('vmware-workstation/server/configure-console.cjs'), '--vmx', vm.vmx, '--port', String(vm.port), '--profile', alias], { env: testEnv, windowsHide: true, shell: false, timeout: 30000, encoding: 'utf8' });
    await call('configure_vm', { vmx: vm.vmx, settings: { 'bios.forceSetupOnce': 'TRUE' } });
    await call('vmrun_start', { vmx: vm.vmx, mode: 'nogui' }); vm.started = true;
  }
  const statuses = await Promise.all(evidence.vms.map(vm => call('console_status', { vm_id: vm.alias })));
  for (const result of statuses) { assert.equal(result.data.connected, true, JSON.stringify(result.data)); assert.equal(result.data.host, '127.0.0.1'); }
  // Both VMs remain connected in one MCP process while interactions interleave.
  await delay(500);
  const before = await Promise.all(evidence.vms.map(vm => frame(vm, 'before')));
  for (let i = 0; i < evidence.vms.length; i++) {
    const vm = evidence.vms[i];
    await call('console_key', { vm_id: vm.alias, key: vm.firmware === 'bios' ? 'ArrowRight' : 'ArrowDown' });
    let after;
    for (let attempt = 0; attempt < 5; attempt++) { await delay(200); after = await frame(vm, 'after-key'); if (after.hash !== before[i].hash) break; }
    assert.notEqual(after.hash, before[i].hash, `${vm.alias}: firmware display must react to an RFB key while host focus stays elsewhere.`);
    vm.screenshots = { before: before[i], after };
    await call('console_click', { vm_id: vm.alias, x: 10, y: 10, button: 'left' });
    await call('console_type', { vm_id: vm.alias, text: 'a' });
    await call('console_scroll', { vm_id: vm.alias, direction: 'down', amount: 1 });
  }
  evidence.focusBeforeCleanup = { sampleCount: focus.length, foregroundProcesses: [...new Set(focus.map(s => s.processName))] };
  assert.ok(focus.length > 10);
  assert.ok(focus.every(sample => !/^vmware/i.test(sample.processName || '')), 'A VMware window became foreground during native console integration.');
  assert.equal(observerError, '');
  evidence.passed = true;
} finally {
  for (const vm of evidence.vms) if (vm.started) {
    try { await call('vmrun_stop', { vmx: vm.vmx, mode: 'hard' }); vm.stopped = true; } catch (error) { vm.cleanupError = error.message; evidence.passed = false; }
    // Only these new blank test VMs are changed. Remove VNC secrets/listeners from their VMX.
    if (vm.stopped) {
      try { await call('configure_vm', { vmx: vm.vmx, settings: { 'RemoteDisplay.vnc.enabled': 'FALSE', 'RemoteDisplay.vnc.password': null, 'RemoteDisplay.vnc.key': null } }); } catch (error) { vm.cleanupError = error.message; evidence.passed = false; }
    }
  }
  if (connected) await client.close();
  observer.kill();
  await fs.unlink(credentialsPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  evidence.focusSamples = focus;
  await fs.writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ passed: evidence.passed, evidence: path.join(root, 'evidence.json'), VMs: evidence.vms.map(vm => ({ alias: vm.alias, vmx: vm.vmx, stopped: vm.stopped })), focusSamples: focus.length, foregroundProcesses: [...new Set(focus.map(s => s.processName))] }, null, 2));
}
