import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import Ajv from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeGenerated } from './write-generated.mjs';

const pluginRoot = path.resolve('vmware-workstation');
const ajv = new Ajv2020({ strict: false });
const toolValidator = new Ajv({ strict: false });
for (const filename of ['plugin.json', 'mcp.json']) {
  const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, filename), 'utf8'));
  const response = await fetch(manifest.$schema);
  assert.ok(response.ok, `Cannot load ${manifest.$schema}`);
  const schema = await response.json();
  assert.ok(ajv.validate(schema, manifest), JSON.stringify(ajv.errors));
}
const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, 'plugin.json'), 'utf8'));
const development = JSON.parse(await fs.readFile('package.json', 'utf8'));
assert.equal(manifest.version, development.version, 'Plugin and source versions must agree');
const ui = manifest.extensions['com.openai'].interface;
assert.ok(ui.shortDescription.length <= 30);
assert.equal(ui.category, 'Developer Tools');
for (const key of ['logo', 'composerIcon']) assert.ok((await fs.stat(path.join(pluginRoot, ui[key]))).isFile());
const client = new Client({ name: 'package-schema-validation', version: '0.1.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(pluginRoot, 'server/server.cjs')], stderr: 'pipe' }));
  assert.equal(client.getServerVersion().version, manifest.version, 'Bundled server version must match plugin');
  const { tools } = await client.listTools();
  assert.equal(tools.length, 98);
  assert.equal(new Set(tools.map(t => t.name)).size, 98);
  const legacy = JSON.parse(await fs.readFile('tests/fixtures/legacy-tool-schemas.json', 'utf8'));
  for (const prior of legacy.tools) assert.deepEqual(tools.find(tool => tool.name === prior.name), prior, `Backward compatibility: ${prior.name}`);
  for (const tool of tools) {
    assert.ok(toolValidator.validateSchema(tool.inputSchema), `${tool.name}: invalid input schema`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name}: tool arguments must be strict`);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
  }
  await writeGenerated('vmware-workstation/tool-schemas.json', JSON.stringify({ tools }, null, 2) + '\n');
  console.log('Both portable manifests and all 98 MCP schemas validated; all original 87 tool schemas/annotations are unchanged.');
} finally { await client.close(); }
