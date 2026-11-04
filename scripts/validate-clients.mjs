import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import Ajv from 'ajv';

const require = createRequire(import.meta.url);
const desktop = JSON.parse(await fs.readFile('packaging/claude-desktop/manifest.json', 'utf8'));
const plugin = JSON.parse(await fs.readFile('vmware-workstation/plugin.json', 'utf8'));
const claude = JSON.parse(await fs.readFile('vmware-workstation/.claude-plugin/plugin.json', 'utf8'));
const metadata = JSON.parse(await fs.readFile('package.json', 'utf8'));
for (const manifest of [desktop, plugin, claude]) assert.equal(manifest.version, metadata.version);
const schema = JSON.parse(await fs.readFile(require.resolve('@anthropic-ai/mcpb/mcpb-manifest-v0.3.schema.json'), 'utf8'));
const ajv = new Ajv({ strict: false, validateFormats: false });
assert.ok(ajv.validate(schema, desktop), JSON.stringify(ajv.errors));
// The official packer also validates referenced assets in the staged package.
const { tools } = JSON.parse(await fs.readFile('vmware-workstation/tool-schemas.json', 'utf8'));
assert.deepEqual(desktop.tools, tools.map(({ name, description }) => ({ name, description })), 'Desktop metadata must describe the shared catalog');
const registration = JSON.parse(await fs.readFile('vmware-workstation/.mcp.json', 'utf8'));
assert.deepEqual(registration.mcpServers['vmware-workstation'].args, ['${CLAUDE_PLUGIN_ROOT}/server/server.cjs']);
const claudePackage = require.resolve('@anthropic-ai/claude-code/package.json');
const packageMetadata = JSON.parse(await fs.readFile(claudePackage, 'utf8'));
const binary = path.join(path.dirname(claudePackage), typeof packageMetadata.bin === 'string' ? packageMetadata.bin : packageMetadata.bin.claude);
for (const target of ['.', 'vmware-workstation']) {
  const { stdout } = await promisify(execFile)(binary, ['plugin', 'validate', '--strict', target], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
  console.log(stdout.trim());
}
console.log(`Claude and MCPB manifests validated at ${metadata.version}; ${tools.length} shared tools.`);
