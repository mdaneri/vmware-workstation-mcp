// Run only against the VM created for this chat's authorized live validation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isWithin, parseAssignments } from '../src/workstation.mjs';
const root = await fs.realpath('test-vms');
const evidence = JSON.parse(await fs.readFile(path.join(root, 'latest-validation.json'), 'utf8'));
const vmx = await fs.realpath(evidence.vmx);
assert.ok(isWithin(root, vmx) && path.basename(vmx) === 'machine.vmx');
const config = parseAssignments(await fs.readFile(vmx, 'utf8'));
assert.equal(config.displayName, 'Codex VMware Plugin Validation - Modified');
assert.equal(config['ethernet0.present'], 'FALSE');
const client = new Client({ name: 'authorized-disposable-vm-snapshots', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe' }));
const name = `plugin-validation-${randomUUID()}`;
try {
  for (const tool of ['vmrun_snapshot', 'vmrun_revert_to_snapshot', 'vmrun_delete_snapshot']) {
    const result = await client.callTool({ name: tool, arguments: { vmx, name } });
    assert.ok(!result.isError, JSON.stringify({ tool, result }));
    evidence.results.push({ tool, data: JSON.parse(result.content[0].text) });
    console.log(`${tool}: succeeded on the isolated powered-off test VM.`);
  }
  evidence.snapshotLifecyclePassed = true;
} finally {
  await client.close();
  await fs.writeFile(path.join(root, 'latest-validation.json'), JSON.stringify(evidence, null, 2) + '\n');
}
