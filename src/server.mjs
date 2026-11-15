#!/usr/bin/env node
import './zod-interpreted.mjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pluginVersion } from './plugin-catalog.mjs';
import { createToolDefinitions } from './tool-definitions.mjs';
import { registerTools } from './register-tools.generated.mjs';

const { catalog, shutdown } = createToolDefinitions();
const server = new McpServer({ name: 'vmware-workstation', version: pluginVersion }, {
  instructions: 'If a VMware tool is missing, call a_vmware_catalog with tool=<exact name> to discover its schema and route through a_vmware_query (read-only) or a_vmware_mutate (authorized changes, confirm=true). Both reuse original strict validation and handlers. Never bypass intentional client policy. get_guest_ip supports bounded waiting. Never replay mutations or substitute raw CLI/guest execution.',
});
registerTools(server, catalog.entries);
process.stdin.once('end', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
server.connect(new StdioServerTransport()).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
