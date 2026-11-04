import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Standalone diagnostic: initialize and tools/list only. Works against older
// packages without plugin_catalog. Never invokes a VMware tool or opens secrets.
async function main() {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(process.argv[1]), '..');
  const bundle = path.join(root, 'server/server.cjs');
  const client = new Client({ name: 'vmware-catalog-inspection', version: '1' });
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(root, 'plugin.json'), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return fs.readFile(path.join(root, 'manifest.json'), 'utf8');
    }));
    const bundle_sha256 = createHash('sha256').update(await fs.readFile(bundle)).digest('hex');
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bundle], cwd: root, stderr: 'pipe' }), { timeout: 15000 });
    const tools = [];
    const cursors = new Set();
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 15000 });
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('Repeated catalog cursor');
      cursors.add(cursor);
      if (tools.length > 10000 || cursors.size > 100) throw new Error('Catalog limit exceeded');
    } while (cursor);
    const names = tools.map(tool => tool.name).sort();
    console.log(JSON.stringify({
      inspection: 'fresh_stdio_connection_only', installed_version: metadata.version,
      server: client.getServerVersion(), bundle_sha256, tool_count: names.length,
      unique_tool_count: new Set(names).size,
      tool_names_sha256: createHash('sha256').update(JSON.stringify(names)).digest('hex'),
      tool_names: names,
      scope: 'Independent raw MCP tools/list, not the running desktop connection or assistant-visible catalog. No VMware tools called.',
    }, null, 2));
  } catch {
    console.error('Catalog inspection failed. Check the selected plugin root, plugin.json or manifest.json, server/server.cjs and Node.js. No VMware tool was called.');
    process.exitCode = 1;
  } finally { await client.close(); }
}
void main();
