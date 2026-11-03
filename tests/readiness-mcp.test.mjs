import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('shipped MCP readiness tools preserve all prior schemas, deadlines, private bundles and capability evidence', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'readiness-mcp-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vmx = path.join(root, 'selected.vmx'); await fs.writeFile(vmx, 'memsize = "2048"\nguestinfo.secret = "never-export"\n');
  const binary = path.join(root, process.platform === 'win32' ? 'vmrun.exe' : 'vmrun'); await fs.writeFile(binary, '', { mode: 0o755 });
  const preload = path.join(root, 'mock.cjs');
  await fs.writeFile(preload, `
const { promisify } = require('node:util');
const fs = require('node:fs');
const native = require('node:child_process').execFile;
const stub = (...args) => native(...args);
stub[promisify.custom] = async (binary, args, options) => {
  if (binary !== process.env.VMRUN_PATH) return promisify(native)(binary, args, options);
  if (!args.length) return { stdout: 'vmrun version mock\\nUsage: vmrun\\nlist  List VMs\\ncheckToolsState  Check Tools\\ngetGuestIPAddress  IP\\n' };
  if (args[2] === 'list') return { stdout: 'Total running VMs: 1\\n' + process.env.READINESS_TEST_VMX };
  if (args[2] === 'checkToolsState') return { stdout: 'running' };
  if (args[2] === 'getGuestIPAddress') {
    if (fs.existsSync(process.env.READINESS_TEST_VMX + '.stall-ip')) {
      fs.writeFileSync(process.env.READINESS_TEST_VMX + '.ip-called', '');
      return new Promise((resolve, reject) => {
        const abort = () => reject(options.signal.reason);
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once: true });
      });
    }
    return { stdout: '' };
  }
  if (args[2] === 'listSnapshots') return { stdout: 'Total snapshots: 1\\nnever-export' };
  throw new Error('Unexpected command');
};
require('node:child_process').execFile = stub;
`);
  const client = new Client({ name: 'readiness-mcp-regression', version: '1' }); t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--require', preload, path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe', env: { ...process.env, VMRUN_PATH: binary, VMWARE_ALLOWED_ROOTS: root, VMWARE_ALLOWED_HOST_ROOTS: root, VMWARE_DIAGNOSTICS_ROOTS: root, VMWARE_VDISKMANAGER_PATH: path.join(root, 'missing', process.platform === 'win32' ? 'vmware-vdiskmanager.exe' : 'vmware-vdiskmanager'), VMWARE_OVFTOOL_PATH: path.join(root, 'missing', process.platform === 'win32' ? 'ovftool.exe' : 'ovftool'), READINESS_TEST_VMX: vmx } }));
  const tools = (await client.listTools()).tools; assert.equal(tools.length, 134);
  const previous = JSON.parse(await fs.readFile('tests/fixtures/pre-readiness-tool-schemas.json', 'utf8'));
  for (const prior of previous.tools) assert.deepEqual(tools.find(tool => tool.name === prior.name), prior);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }); assert.ok(!result.isError, JSON.stringify(result)); return JSON.parse(result.content[0].text);
  };
  // Tools is immediately ready; IP would stall until the request deadline.
  // A boot wait must succeed without starting that unrelated observation.
  await fs.writeFile(vmx + '.stall-ip', '');
  const boot = await call('vm_wait_for_boot', { vmx, timeout_seconds: 1 });
  assert.equal(boot.ready, true); assert.equal(boot.timed_out, false);
  assert.equal(boot.tools, 'running'); assert.equal(boot.lifecycle, 'running');
  assert.equal(boot.state, 'running'); assert.equal(boot.address, null);
  await assert.rejects(fs.access(vmx + '.ip-called'), { code: 'ENOENT' });
  await fs.unlink(vmx + '.stall-ip');
  const ip = await call('vm_wait_for_ip', { vmx, timeout_seconds: 1, poll_interval_ms: 100 }); assert.equal(ip.timed_out, true); assert.equal(ip.state, 'network_unavailable');
  const bundle = await call('vm_collect_diagnostics', { vmx, destination_directory: path.join(root, 'bundle') });
  assert.equal(bundle.report.snapshots.count, 1); assert.doesNotMatch(JSON.stringify(bundle), /never-export/);
  const file = path.join(bundle.directory, 'diagnostics.json');
  if (process.platform === 'linux') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  else {
    const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
    const result = await promisify(execFile)('pwsh', ['-NoProfile', '-Command', '$a=Get-Acl -LiteralPath $env:READINESS_ACL_TEST; if(-not $a.AreAccessRulesProtected -or @($a.Access).Count -ne 1){exit 1}'], { env: { ...process.env, READINESS_ACL_TEST: file } });
    assert.equal(result.stderr, '');
  }
  const capabilities = await call('workstation_capabilities');
  assert.equal(capabilities.diskManager.available, false); assert.equal(capabilities.ovfTool.available, false);
  assert.equal(capabilities.capabilityEvidence.nativeHypervisor, 'not_proven_by_discovery');
  assert.equal(capabilities.capabilityEvidence.firmwareBoot.liveSupport, 'unknown');
  await fs.unlink(binary);
  const missing = await call('workstation_capabilities');
  assert.equal(missing.vmrunCapability.executable_discovered, false);
  assert.equal(missing.vmrunCapability.help_verified, false);
  assert.equal(missing.vmrunCapability.live_support, 'unknown');
});
