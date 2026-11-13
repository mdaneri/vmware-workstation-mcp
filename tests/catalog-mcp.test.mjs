import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { annotationCorrections, assertCompatibleTool } from './tool-compatibility.mjs';

test('raw and fresh MCP catalogs include every tool family; identity diagnoses a partial client without native calls', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-catalog-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const preload = path.join(root, 'deny-native.cjs');
  await fs.writeFile(preload, `
const fs = require('node:fs');
const nativeRead = fs.promises.readFile;
fs.promises.readFile = function(filename, ...args) {
  if (String(filename) === process.env.VMWARE_CREDENTIALS_FILE) throw new Error('Credentials must not be read');
  return nativeRead.call(this, filename, ...args);
};
const { promisify } = require('node:util');
const deny = () => { throw new Error('Native operations must not execute'); };
deny[promisify.custom] = deny;
require('node:child_process').execFile = deny;
`);
  async function connect() {
    const client = new Client({ name: 'catalog-regression', version: '1' });
    t.after(() => client.close());
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ['--require', preload, path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe',
      env: { ...process.env, VMWARE_CREDENTIALS_FILE: path.join(root, 'forbidden-credentials.json') },
    }));
    return client;
  }
  const client = await connect();
  const raw = await client.listTools();
  assert.equal(raw.nextCursor, undefined);
  assert.equal(raw.tools.length, 156);
  assert.deepEqual(raw, JSON.parse(await fs.readFile('vmware-workstation/tool-schemas.json', 'utf8')), 'Generated catalog must match the bundled MCP response');
  const names = raw.tools.map(tool => tool.name).sort();
  // #40: a 46-name prefix ends before all of the original plugin_* bridges.
  // Recovery must work using only names actually present in that client view.
  const early = ['a_vmware_catalog', 'a_vmware_mutate', 'a_vmware_query'];
  assert.deepEqual(names.slice(0, 3), early);
  assert.deepEqual(raw.tools.slice(0, 3).map(tool => tool.name), early);
  assert.deepEqual(raw.tools.slice(0, 3).map(tool => tool.annotations), [
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  ]);
  for (const name of ['a_vmware_query', 'a_vmware_mutate']) assert.match(raw.tools.find(tool => tool.name === name).inputSchema.properties.tool.description, /a_vmware_catalog/);
  const previous = JSON.parse(await fs.readFile('tests/fixtures/pre-early-catalog-tool-schemas.json', 'utf8'));
  assert.equal(previous.tools.length, 153);
  for (const original of previous.tools) assertCompatibleTool(raw.tools.find(tool => tool.name === original.name), original);
  for (const count of [46, 74]) {
    await t.test(`recovery through a ${count}-name assistant-visible prefix`, async () => {
      const visible = new Set(names.slice(0, count));
      const visibleCall = async (name, args = {}) => {
        assert.ok(visible.has(name), `Hidden entrypoint: ${name}`);
        return client.callTool({ name, arguments: args });
      };
      if (count === 46) for (const name of ['plugin_catalog', 'plugin_query', 'plugin_mutate']) assert.ok(!visible.has(name));
      assert.ok(!visible.has('vmrun_get_guest_ip_address'));
      const selected = JSON.parse((await visibleCall('a_vmware_catalog', { tool: 'vmrun_get_guest_ip_address', observed_tools: [...visible] })).content[0].text);
      assert.equal(selected.comparison.alphabetical_prefix_only, true);
      assert.equal(selected.selected_tool.bridge, 'a_vmware_query');
      assert.deepEqual(selected.selected_tool.inputSchema, raw.tools.find(tool => tool.name === 'vmrun_get_guest_ip_address').inputSchema);
      const templates = await visibleCall('a_vmware_query', { tool: 'template_list' });
      assert.ok(!templates.isError, JSON.stringify(templates));
      assert.equal(JSON.parse(templates.content[0].text).templates.length, 3);
      for (const name of ['vm_get_recent_errors', 'vm_hardware_capabilities', 'workstation_status', 'vm_wait_for_ip']) {
        const found = JSON.parse((await visibleCall('a_vmware_catalog', { tool: name })).content[0].text);
        assert.equal(found.selected_tool.bridge, 'a_vmware_query');
      }
      for (const name of [...early, 'plugin_catalog', 'plugin_query', 'plugin_mutate', 'vm_power']) {
        assert.equal((await visibleCall('a_vmware_query', { tool: name })).isError, true);
      }
      for (const name of [...early, 'plugin_catalog', 'plugin_query', 'plugin_mutate', 'template_list']) {
        assert.equal((await visibleCall('a_vmware_mutate', { tool: name, confirm: true })).isError, true);
      }
      for (const name of early) {
        const selected = JSON.parse((await visibleCall('a_vmware_catalog', { tool: name })).content[0].text);
        assert.equal(selected.selected_tool.bridge, null);
      }
      const boot = { vmx: 'relative.vmx', confirm: true };
      assert.deepEqual(await visibleCall('a_vmware_query', { tool: 'vm_boot_configure', arguments: boot }),
        await client.callTool({ name: 'vm_boot_configure', arguments: boot }));
      assert.equal((await visibleCall('a_vmware_mutate', { tool: 'vm_boot_configure', confirm: true, arguments: boot })).isError, true);
    });
  }
  const prior = JSON.parse(await fs.readFile('tests/fixtures/pre-catalog-tool-schemas.json', 'utf8'));
  assert.equal(prior.tools.length, 150);
  for (const tool of prior.tools) {
    const current = raw.tools.find(t => t.name === tool.name);
    assertCompatibleTool(current, tool);
  }
  for (const name of ['vmrun_get_guest_ip_address', 'vm_wait_for_ip', 'serial_read', 'template_list',
    'vm_hardware_get', 'vm_security_status', 'vm_boot_status', 'vm_power', 'revert_snapshot',
    'rest_update_portforward', 'rest_update_shared_folder', 'rest_update_vm', 'workstation_status', 'workstation_capabilities']) {
    assert.ok(names.includes(name), name);
  }
  const inspect = async (c, args = {}) => {
    const result = await c.callTool({ name: 'plugin_catalog', arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const full = await inspect(client);
  assert.deepEqual(full.tool_names, names);
  assert.equal(full.server.version, client.getServerVersion().version);
  assert.equal(full.server.tool_names_sha256, createHash('sha256').update(JSON.stringify(names)).digest('hex'));
  assert.equal(full.comparison, null);
  // Model the observed alphabetical exposure cutoff. Every original operation
  // remains discoverable and callable through the three visible bridge tools.
  const prefix = names.slice(0, 74);
  for (const name of ['plugin_catalog', 'plugin_query', 'plugin_mutate']) assert.ok(prefix.includes(name));
  const queries = raw.tools.find(t => t.name === 'plugin_query');
  const mutations = raw.tools.find(t => t.name === 'plugin_mutate');
  assert.equal(queries.annotations.readOnlyHint, true);
  assert.equal(mutations.annotations.readOnlyHint, false);
  assert.equal(mutations.annotations.destructiveHint, true);
  const reads = queries.inputSchema.properties.tool.enum;
  const writes = mutations.inputSchema.properties.tool.enum;
  assert.deepEqual([...reads, ...writes].sort(), prior.tools.map(t => t.name).sort());
  assert.equal(reads.some(name => writes.includes(name)), false);
  for (const tool of raw.tools) {
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', tool.name);
    assert.equal(typeof tool.annotations.destructiveHint, 'boolean', tool.name);
    assert.ok(!(tool.annotations.readOnlyHint && tool.annotations.destructiveHint), tool.name);
  }
  for (const [name, hints] of Object.entries(annotationCorrections)) {
    const tool = raw.tools.find(tool => tool.name === name);
    for (const [hint, expected] of Object.entries(hints)) assert.equal(tool.annotations[hint], expected, `${name}: ${hint}`);
    if (hints.readOnlyHint === undefined) continue;
    for (const [bridge, readOnly] of [['plugin_query', true], ['plugin_mutate', false], ['a_vmware_query', true], ['a_vmware_mutate', false]]) {
      const selector = raw.tools.find(tool => tool.name === bridge).inputSchema.properties.tool;
      assert.equal(selector.enum.includes(name), hints.readOnlyHint === readOnly, `${bridge}: ${name}`);
    }
  }
  for (const original of prior.tools) {
    const selected = (await inspect(client, { tool: original.name })).selected_tool;
    const direct = raw.tools.find(t => t.name === original.name);
    assert.deepEqual(selected.inputSchema, direct.inputSchema);
    assert.deepEqual(selected.annotations, direct.annotations);
    assert.equal(selected.bridge, direct.annotations.readOnlyHint ? 'a_vmware_query' : 'a_vmware_mutate');
  }
  const templates = await client.callTool({ name: 'plugin_query', arguments: { tool: 'template_list' } });
  assert.ok(!templates.isError, JSON.stringify(templates));
  assert.equal(JSON.parse(templates.content[0].text).templates.length, 3);
  for (const args of [
    { tool: 'vm_power', arguments: { vmx: 'relative.vmx', action: 'start' } },
    { tool: 'plugin_mutate', arguments: {} },
    { tool: 'template_list', arguments: { password: 'never-print-this' } },
    { tool: 'vmrun_get_guest_ip_address', arguments: { vmx: 'relative.vmx', timeout_seconds: 0 } },
  ]) {
    const denied = await client.callTool({ name: 'plugin_query', arguments: args });
    assert.equal(denied.isError, true);
    assert.ok(!JSON.stringify(denied).includes('never-print-this'));
  }
  for (const args of [
    { tool: 'serial_read', arguments: {} },
    { tool: 'ovf_inspect', confirm: true, arguments: {} },
    { tool: 'template_list', confirm: true },
  ]) assert.equal((await client.callTool({ name: 'plugin_mutate', arguments: args })).isError, true);
  const unsupportedArgs = { vmx: 'relative.vmx', confirm: true };
  const unsupported = await client.callTool({ name: 'vm_boot_configure', arguments: unsupportedArgs });
  const bridgedError = await client.callTool({ name: 'plugin_query', arguments: { tool: 'vm_boot_configure', arguments: unsupportedArgs } });
  assert.equal(bridgedError.isError, true);
  assert.deepEqual(bridgedError, unsupported);
  const observed = names.slice(0, 74);
  const partial = await inspect(client, { observed_tools: observed });
  assert.equal(partial.server.instance_id, full.server.instance_id);
  assert.equal(partial.comparison.alphabetical_prefix_only, true);
  assert.deepEqual(partial.comparison.missing_from_observed, names.slice(74));
  assert.equal(partial.comparison.matches, false);
  assert.equal((await inspect(client, { observed_tools: names })).comparison.matches, true);
  const unknown = await inspect(client, { observed_tools: ['unknown_tool', names[1], names[1]] });
  assert.deepEqual(unknown.comparison.unknown_to_server, ['unknown_tool']);
  assert.equal(unknown.comparison.observed_count, 2);
  assert.equal(unknown.comparison.alphabetical_prefix_only, false);
  assert.equal((await inspect(client, { observed_tools: [] })).comparison.alphabetical_prefix_only, false);
  const fresh = await connect();
  assert.deepEqual((await fresh.listTools()).tools, raw.tools);
  const reconnected = await inspect(fresh);
  assert.notEqual(reconnected.server.instance_id, full.server.instance_id);
  assert.equal(reconnected.server.tool_names_sha256, full.server.tool_names_sha256);
});

test('packaged catalog diagnostic reports raw server identity without VMware', async () => {
  const root = path.resolve('vmware-workstation');
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, 'server/inspect-catalog.cjs'), root], { windowsHide: true, timeout: 30000 });
  const report = JSON.parse(stdout);
  assert.equal(report.inspection, 'fresh_stdio_connection_only');
  assert.equal(report.tool_count, 156);
  assert.equal(report.unique_tool_count, 156);
  assert.equal(report.server.version, report.installed_version);
  assert.equal(report.bundle_sha256, createHash('sha256').update(await fs.readFile(path.join(root, 'server/server.cjs'))).digest('hex'));
});
