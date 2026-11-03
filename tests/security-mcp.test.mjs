import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('bundled security tools preserve all 148 prior definitions, hide fake secrets and never mutate', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'security-mcp-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ext = process.platform === 'win32' ? '.exe' : '';
  for (const name of ['vmrun', 'vmware-vmx', 'vmcli']) await fs.writeFile(path.join(root, name + ext), '', { mode: 0o755 });
  const secret = `generated-fake-secret-${crypto.randomUUID()}`;
  const vmx = path.join(root, 'selected.vmx');
  const original = `.encoding = "UTF-8"\nfirmware = "efi"\nvtpm.present = "TRUE"\nencryption.data = "${secret}"\nvtpm.ekCRT = "${secret}"\n`;
  await fs.writeFile(vmx, original);
  const preload = path.join(root, 'runner.cjs');
  await fs.writeFile(preload, String.raw`
const { promisify } = require('node:util');
const assert = require('node:assert/strict'), path = require('node:path');
const stub = () => { throw new Error('Unexpected callback'); };
stub[promisify.custom] = async (file, args, options) => {
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  if (path.basename(file).startsWith('vmcli')) {
    assert.equal(args.length, 1); assert.ok(['--version', '--help'].includes(args[0]));
    return { stdout: args[0] === '--help' ? 'Usage: vmcli.exe <module> <command>' : 'vmcli.exe version 0.1.25688693' };
  }
  if (path.basename(file).startsWith('vmware-vmx') || file === 'pwsh' && options.env?.VMWARE_HARDWARE_VERSION_TARGET) return { stdout: 'VMware Workstation 26.0.1 build-25688693' };
  throw new Error('Unexpected process: ' + path.basename(file));
};
require('node:child_process').execFile = stub;
`);
  const client = new Client({ name: 'security-mcp', version: '1' }); t.after(() => client.close());
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--require', preload, path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe', env: {
      ...process.env, VMRUN_PATH: path.join(root, 'vmrun' + ext), VMWARE_VMX_PATH: path.join(root, 'vmware-vmx' + ext),
      VMWARE_VMCLI_PATH: path.join(root, 'vmcli' + ext), VMWARE_ALLOWED_ROOTS: root,
    } });
  let stderr = ''; transport.stderr.on('data', data => { stderr += data; });
  await client.connect(transport);
  const tools = (await client.listTools()).tools; assert.equal(tools.length, 150);
  const prior = JSON.parse(await fs.readFile('tests/fixtures/pre-security-tool-schemas.json', 'utf8'));
  assert.equal(prior.tools.length, 148);
  for (const tool of prior.tools) assert.deepEqual(tools.find(current => current.name === tool.name), tool);
  for (const name of ['vm_security_capabilities', 'vm_security_status']) {
    assert.equal(tools.find(tool => tool.name === name).annotations.readOnlyHint, true);
    const result = await client.callTool({ name, arguments: name.endsWith('status') ? { vmx } : {} });
    assert.ok(!result.isError, JSON.stringify(result)); assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(JSON.parse(result.content[0].text).backend.available, false);
    if (name.endsWith('status')) {
      const status = JSON.parse(result.content[0].text);
      assert.equal(status.inspection, 'configuration_only'); assert.equal(status.vtpm.declared_present, true);
      assert.equal(status.encryption.state, 'unknown'); assert.equal(status.vtpm.presence, 'unknown');
    }
  }
  assert.equal(await fs.readFile(vmx, 'utf8'), original);
  const invalid = await client.callTool({ name: 'vm_security_status', arguments: { vmx, password: 'fake' } });
  assert.equal(invalid.isError, true);
  await fs.writeFile(vmx, `malformed ${secret}`);
  const malformed = await client.callTool({ name: 'vm_security_status', arguments: { vmx } });
  assert.equal(JSON.parse(malformed.content[0].text).inspection, 'unknown'); assert.ok(!JSON.stringify(malformed).includes(secret));
  await fs.writeFile(vmx, original);
  assert.equal(await fs.readFile(vmx, 'utf8'), original); assert.ok(!stderr.includes(secret));
  assert.deepEqual((await fs.readdir(root)).sort(), ['runner.cjs', 'selected.vmx', 'vmcli' + ext, 'vmrun' + ext, 'vmware-vmx' + ext].sort());
});
