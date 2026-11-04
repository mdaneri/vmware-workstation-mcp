import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import metadata from '../package.json' with { type: 'json' };

export const pluginVersion = metadata.version;
export const earlyCatalogTools = ['a_vmware_catalog', 'a_vmware_mutate', 'a_vmware_query'];
const entrypoints = new Set([...earlyCatalogTools, 'plugin_catalog', 'plugin_query', 'plugin_mutate']);
export const catalogSchema = z.object({
  tool: z.string().regex(/^[a-z][a-z0-9_]*$/).max(128).optional().describe('Existing tool name to discover its exact input schema, annotations and bridge route. No operation is executed.'),
  observed_tools: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/).max(128)).max(512).optional()
    .describe('Optional complete assistant-visible VMware tool names, without namespace prefixes. Compared with this running server, never used to execute tools.'),
}).strict();

// Names are collected by the same function that registers every tool. This is
// the running process catalog, independent of package files changed on disk.
export class PluginCatalog {
  constructor() {
    this.names = new Set();
    this.entries = new Map();
    this.instance = randomUUID();
  }

  add(name, entry) {
    if (this.names.has(name)) throw new Error(`Duplicate tool registration: ${name}`);
    this.names.add(name);
    this.entries.set(name, entry);
  }

  bridgeNames(readOnly) {
    return [...this.entries].filter(([name, entry]) => !entrypoints.has(name) && entry.annotations.readOnlyHint === readOnly).map(([name]) => name).sort();
  }

  bridgeSchema(readOnly, discovery = 'plugin_catalog') {
    return z.object({
      tool: z.enum(this.bridgeNames(readOnly)).describe(`Exact existing tool name discovered with ${discovery}.`),
      arguments: z.record(z.string(), z.unknown()).default({}).describe('Original tool arguments. Validated against that tool\'s unchanged strict schema before execution; no raw CLI or arbitrary operations.'),
      ...(!readOnly ? { confirm: z.literal(true).describe('Required after authorization for the exact target and effects. Original tool confirmation fields are also required.') } : {}),
    }).strict();
  }

  async invoke(readOnly, input, extra) {
    // Recheck the route and envelope even for internal callers. Never permit
    // bridge recursion or a mutation through the read-only entry point.
    const a = this.bridgeSchema(readOnly).parse(input);
    const entry = this.entries.get(a.tool);
    const args = await entry.schema.parseAsync(a.arguments);
    extra?.signal?.throwIfAborted();
    return entry.invoke(args, extra);
  }

  identity() {
    const names = [...this.names].sort();
    return {
      name: 'vmware-workstation', version: pluginVersion, instance_id: this.instance,
      tool_count: names.length,
      // SHA-256 of the UTF-8 JSON array of sorted, unprefixed names; not a
      // schema or bundle hash, and not evidence of what the client exposes.
      tool_names_sha256: createHash('sha256').update(JSON.stringify(names)).digest('hex'),
    };
  }

  inspect({ observed_tools, tool } = {}) {
    const tool_names = [...this.names].sort();
    const observed = observed_tools === undefined ? null : [...new Set(observed_tools)].sort();
    const entry = tool === undefined ? null : this.entries.get(tool);
    if (tool !== undefined && !entry) throw new Error('Unknown registered tool. Inspect tool_names before selecting an operation.');
    return {
      server: this.identity(), tool_names,
      selected_tool: entry ? {
        name: tool, description: entry.description, inputSchema: z.toJSONSchema(entry.schema, { target: 'draft-7', io: 'input' }),
        annotations: entry.annotations,
        bridge: entrypoints.has(tool) ? null : entry.annotations.readOnlyHint ? 'a_vmware_query' : 'a_vmware_mutate',
      } : null,
      comparison: observed === null ? null : {
        observed_count: observed.length,
        missing_from_observed: tool_names.filter(name => !observed.includes(name)),
        unknown_to_server: observed.filter(name => !this.names.has(name)),
        matches: JSON.stringify(observed) === JSON.stringify(tool_names),
        alphabetical_prefix_only: observed.length > 0 && observed.length < tool_names.length &&
          JSON.stringify(observed) === JSON.stringify(tool_names.slice(0, observed.length)),
      },
      scope: 'Running server registration only. Cannot observe the desktop client catalog, its filters, cache, or another server process. No VMware commands or credentials are accessed.',
      action: 'For a missing operation, discover its schema with a_vmware_catalog using tool, then use the indicated a_vmware_query or a_vmware_mutate route with the original arguments. These routes reuse the registered handlers and protections; never use them to evade intentional client policy. Compare server version and tool_names with raw MCP and assistant-visible catalogs, then reconnect/restart in a fresh chat if stale. Never replay mutations or use raw CLI/guest execution to bypass missing tools.',
    };
  }
}
