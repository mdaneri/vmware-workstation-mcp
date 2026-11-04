import fs from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { desktopSettings } from '../src/desktop-settings.mjs';
import { writeGenerated } from './write-generated.mjs';

const metadata = JSON.parse(await fs.readFile('package.json', 'utf8'));
const plugin = JSON.parse(await fs.readFile('vmware-workstation/plugin.json', 'utf8'));
plugin.version = metadata.version;
const json = value => JSON.stringify(value, null, 2) + '\n';
await writeGenerated('vmware-workstation/plugin.json', json(plugin));
const { name, version, description, author, homepage, repository, license, keywords } = plugin;
await writeGenerated('vmware-workstation/.claude-plugin/plugin.json', json({ name, version, description, author, homepage, repository, license, keywords }));
// Derive metadata from the freshly built registration, never a second catalog
// or a potentially stale checked-in snapshot. No VMware tools are called.
const client = new Client({ name: 'client-metadata-build', version: '1' });
let tools;
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('vmware-workstation/server/server.cjs')], stderr: 'pipe' }));
  assert.equal(client.getServerVersion().version, version);
  ({ tools } = await client.listTools());
  await writeGenerated('vmware-workstation/tool-schemas.json', json({ tools }));
} finally { await client.close(); }
const user_config = {}, env = {};
for (const [key, [, type, title, description]] of Object.entries(desktopSettings)) {
  user_config[key] = { type, title, description, required: false, default: '' };
  env[`VMWARE_DESKTOP_${key.toUpperCase()}`] = `\${user_config.${key}}`;
}
await writeGenerated('packaging/claude-desktop/manifest.json', json({
  manifest_version: '0.3', name, display_name: 'VMware Workstation', version,
  description, author, homepage, repository: { type: 'git', url: metadata.repository.url.replace(/^git\+/, '') },
  documentation: `${homepage}/blob/main/vmware-workstation/claude-installation.md`, support: `${homepage}/issues`, license, keywords,
  long_description: 'Independent community integration for native VMware Workstation on Windows and Linux (Claude Desktop Linux is beta). VMware Workstation must be installed locally. Inventory requires no credentials. REST requires vmrest and local credentials; guest operations require VMware Tools and guest credentials. VNC consoles require per-VM authenticated loopback setup. Runs as your local user using stdio and opens no new network listener. Encryption and vTPM provisioning are unsupported.',
  icon: 'assets/icon.png',
  server: { type: 'node', entry_point: 'server/claude-desktop.cjs', mcp_config: { command: 'node', args: ['${__dirname}/server/claude-desktop.cjs'], env } },
  compatibility: { platforms: ['win32', 'linux'], runtimes: { node: '>=22.12.0' } },
  tools: tools.map(({ name, description }) => ({ name, description })),
  user_config,
}));
const svg = await fs.readFile('vmware-workstation/assets/icon.svg');
await writeGenerated('vmware-workstation/assets/icon.png', new Resvg(svg, { fitTo: { mode: 'width', value: 512 } }).render().asPng());
