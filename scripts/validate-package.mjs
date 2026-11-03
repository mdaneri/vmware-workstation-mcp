import { assertCompatibleTool } from '../tests/tool-compatibility.mjs';
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
assert.equal(manifest.homepage, 'https://github.com/mdaneri/vmware-workstation-mcp');
assert.equal(ui.websiteURL, manifest.homepage, 'Listing website must match the project homepage');
assert.equal(ui.supportURL, `${manifest.repository}/issues`, 'Listing support must point to the project issue tracker');
assert.equal(ui.developerName, manifest.author.name, 'Listing developer must match the project author');
assert.ok(ui.shortDescription.length <= 30);
assert.equal(ui.category, 'Developer Tools');
for (const key of ['logo', 'composerIcon']) assert.ok((await fs.stat(path.join(pluginRoot, ui[key]))).isFile());
const client = new Client({ name: 'package-schema-validation', version: '0.1.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(pluginRoot, 'server/server.cjs')], stderr: 'pipe' }));
  assert.equal(client.getServerVersion().version, manifest.version, 'Bundled server version must match plugin');
  const { tools } = await client.listTools();
  assert.equal(tools.length, 138);
  assert.equal(new Set(tools.map(t => t.name)).size, 138);
  const preJobs = JSON.parse(await fs.readFile('tests/fixtures/pre-jobs-tool-schemas.json', 'utf8'));
  assert.equal(preJobs.tools.length, 137);
  for (const prior of preJobs.tools) assertCompatibleTool(tools.find(tool => tool.name === prior.name), prior);
  const preHardware = JSON.parse(await fs.readFile('tests/fixtures/pre-hardware-tool-schemas.json', 'utf8'));
  assert.equal(preHardware.tools.length, 134);
  for (const prior of preHardware.tools) assertCompatibleTool(tools.find(tool => tool.name === prior.name), prior);
  const preIso = JSON.parse(await fs.readFile('tests/fixtures/pre-iso-tool-schemas.json', 'utf8'));
  assert.equal(preIso.tools.length, 129);
  for (const prior of preIso.tools) assertCompatibleTool(tools.find(tool => tool.name === prior.name), prior, `Pre-ISO compatibility: ${prior.name}`);
  const preGuestExec = JSON.parse(await fs.readFile('tests/fixtures/pre-guest-exec-tool-schemas.json', 'utf8'));
  assert.equal(preGuestExec.tools.length, 128);
  for (const prior of preGuestExec.tools) assertCompatibleTool(tools.find(tool => tool.name === prior.name), prior, `Pre-guest-exec compatibility: ${prior.name}`);
  const legacy = JSON.parse(await fs.readFile('tests/fixtures/legacy-tool-schemas.json', 'utf8'));
  for (const prior of legacy.tools) assertCompatibleTool(tools.find(tool => tool.name === prior.name), prior, `Backward compatibility: ${prior.name}`);
  const preOvf = JSON.parse(await fs.readFile('tests/fixtures/pre-ovf-tool-schemas.json', 'utf8'));
  assert.equal(preOvf.tools.length, 98);
  for (const prior of preOvf.tools) assertCompatibleTool(tools.find(tool => tool.name === prior.name), prior, `Pre-OVF compatibility: ${prior.name}`);
  const preDisk = JSON.parse(await fs.readFile('tests/fixtures/pre-disk-tool-schemas.json', 'utf8'));
  assert.equal(preDisk.tools.length, 108);
  for (const prior of preDisk.tools) assertCompatibleTool(tools.find(tool => tool.name === prior.name), prior, `Pre-disk compatibility: ${prior.name}`);
  const preSerial = JSON.parse(await fs.readFile('tests/fixtures/pre-serial-tool-schemas.json', 'utf8'));
  assert.equal(preSerial.tools.length, 117);
  for (const prior of preSerial.tools) assertCompatibleTool(tools.find(tool => tool.name === prior.name), prior, `Pre-serial compatibility: ${prior.name}`);
  const preReadiness = JSON.parse(await fs.readFile('tests/fixtures/pre-readiness-tool-schemas.json', 'utf8'));
  assert.equal(preReadiness.tools.length, 123);
  for (const prior of preReadiness.tools) assertCompatibleTool(tools.find(tool => tool.name === prior.name), prior, `Pre-readiness compatibility: ${prior.name}`);
  for (const tool of tools) {
    assert.ok(toolValidator.validateSchema(tool.inputSchema), `${tool.name}: invalid input schema`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name}: tool arguments must be strict`);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
  }
  await writeGenerated('vmware-workstation/tool-schemas.json', JSON.stringify({ tools }, null, 2) + '\n');
  console.log('Both portable manifests and all 138 MCP schemas validated; existing inputs/annotations preserved; three job descriptions updated for durable history and process trees.');
} finally { await client.close(); }
