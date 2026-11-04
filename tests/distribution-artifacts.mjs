import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { pluginFiles, desktopFiles } from '../scripts/distribution-files.mjs';

const metadata = JSON.parse(await fs.readFile('package.json', 'utf8'));
const baseline = JSON.parse(await fs.readFile('vmware-workstation/tool-schemas.json', 'utf8'));
const sharedBundle = await fs.readFile('vmware-workstation/server/server.cjs');
for (const extension of ['zip', 'mcpb']) {
  test(`extracted ${extension} starts from another cwd with the identical 156-tool server`, { timeout: 30000 }, async t => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'vmware distribution with spaces '));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const root = path.join(temporary, 'plugin cache');
    const cwd = path.join(temporary, 'unrelated project');
    await fs.mkdir(cwd, { recursive: true });
    const bytes = await fs.readFile(`dist/vmware-workstation-${metadata.version}.${extension}`);
    const entries = unzipSync(bytes);
    const expected = extension === 'zip' ? pluginFiles : [...desktopFiles, 'manifest.json'];
    assert.deepEqual(Object.keys(entries).sort(), expected.toSorted());
    assert.deepEqual(Buffer.from(entries['server/server.cjs']), sharedBundle);
    for (const [name, contents] of Object.entries(entries)) {
      const destination = path.join(root, name);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, contents);
    }
    const manifest = JSON.parse(Buffer.from(entries[extension === 'zip' ? '.claude-plugin/plugin.json' : 'manifest.json']));
    assert.equal(manifest.version, metadata.version);
    const config = extension === 'zip' ? JSON.parse(Buffer.from(entries['.mcp.json'])).mcpServers['vmware-workstation'] : manifest.server.mcp_config;
    const args = config.args.map(value => value.replaceAll('${CLAUDE_PLUGIN_ROOT}', root).replaceAll('${__dirname}', root));
    const env = { ...process.env, NODE_PATH: '', VMWARE_CREDENTIALS_FILE: path.join(temporary, 'must-not-read.json') };
    for (const key of Object.keys(env)) if (key.startsWith('VMWARE_DESKTOP_')) delete env[key];
    if (extension === 'mcpb') for (const key of Object.keys(config.env)) env[key] = ''; // Every optional field unset.
    const client = new Client({ name: 'extracted-distribution', version: '1' });
    t.after(() => client.close());
    await client.connect(new StdioClientTransport({ command: process.execPath, args, cwd, env, stderr: 'pipe' }));
    assert.equal(client.getServerVersion().version, metadata.version);
    assert.deepEqual(await client.listTools(), baseline, 'Complete descriptors and order must match the canonical bundle');
    for (const name of ['plugin_catalog', 'a_vmware_catalog']) {
      const result = await client.callTool({ name, arguments: { tool: 'template_list' } });
      assert.ok(!result.isError);
      const identity = JSON.parse(result.content[0].text);
      assert.equal(identity.server.version, metadata.version);
      assert.equal(identity.server.tool_count, 156);
    }
    const direct = await client.callTool({ name: 'template_list', arguments: {} });
    for (const name of ['plugin_query', 'a_vmware_query']) assert.deepEqual(await client.callTool({ name, arguments: { tool: 'template_list', arguments: {} } }), direct);
    const rejected = await client.callTool({ name: 'plugin_query', arguments: { tool: 'start_vm', arguments: {} } });
    assert.ok(rejected.isError, 'A read-only bridge must not dispatch mutations');
    await client.close();
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, 'server/inspect-catalog.cjs')], { cwd, env, windowsHide: true, timeout: 15000 });
    assert.equal(JSON.parse(stdout).tool_count, 156);
    if (extension === 'mcpb') {
      await assert.rejects(promisify(execFile)(process.execPath, args, {
        cwd, env: { ...env, VMWARE_DESKTOP_CREDENTIALS_FILE: 'relative-private-file.json' }, windowsHide: true, timeout: 5000,
      }), error => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /Invalid Claude Desktop setting: credentials_file/);
        assert.ok(!error.stderr.includes('relative-private-file.json'));
        assert.equal(error.stdout, '');
        return true;
      });
    }
    const checksumText = await fs.readFile(`dist/vmware-workstation-${metadata.version}-SHA256SUMS.txt`, 'utf8');
    assert.ok(checksumText.includes(`${createHash('sha256').update(bytes).digest('hex')}  vmware-workstation-${metadata.version}.${extension}`));
    assert.ok(!(await fs.readdir(root)).includes('node_modules'));
  });
}
