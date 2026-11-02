import fs from 'node:fs/promises';
import { commands, snake } from '../src/vmrun-commands.mjs';
import { restOperations, restToolName } from '../src/rest.mjs';
import { consoleSchemas } from '../src/console.mjs';
let text = '# Complete operation reference\n\nGenerated from the command implementations and installed REST contract. Source version: vmrun 1.17.0.25688693; vmrest 1.3.1 build 25688693.\n\n';
text += '## New VM creation and local configuration\n\n`create_vm` creates a blank VMX and sparse VMDK in a new directory. Required: `directory`, `name`. Options: `guest_os`, `memory_mb`, `cpus`, `disk_gb`, `hardware_version`, `firmware`, `network`, `vmnet`, `iso_path`, `timeout_seconds`.\n\n`configure_vm` edits a powered-off UTF-8 VMX with a backup. Required: `vmx`, `settings` (VMX keys to string values, or null to remove). It rejects running/locked/detected suspended VMs.\n\n';
text += '## vmrun commands (47)\n\nAll tools accept `timeout_seconds` (default 120). VM tools require `vmx` and accept optional `vm_password_profile` and `guest_profile`. Guest operations default `guest_profile` to `default`. Output-file operations accept `overwrite` (default false). Optional arguments are marked with `?`; defaulted arguments show their defaults.\n\n| CLI command | MCP tool | Operation arguments | Guest auth | Effect |\n| --- | --- | --- | --- | --- |\n';
for (const c of commands) {
  const parameters = c.parameters.map(p => `\`${p.name}${p.optional ? '?' : p.default !== undefined ? `=${p.default}` : ''}\``).join(', ') || '(none)';
  text += `| \`${c.command}\` | \`vmrun_${snake(c.command)}\` | ${parameters} | ${c.guestAuth ? 'Required' : 'Optional for VM commands'} | ${c.readOnly ? 'Read' : 'Change'} |\n`;
}
text += '\n## REST operations (28)\n\nParameter names follow the tool schema; JSON body fields preserve VMware names such as `parentId`, `host_path`, and `guestIp`. Optional `vm_password_profile` selects the encrypted VM password. No tool accepts a raw password. All accept `timeout_seconds`.\n\n| API operation | MCP tool | Method and route | Tool arguments |\n| --- | --- | --- | --- |\n';
for (const o of restOperations) {
  const parameters = o.parameters.map(p => p.secret ? 'vm_password_profile?' : `${snake(p.name.replace(/\s+/g, '_'))}${p.required ? '' : '?'}`).map(p => `\`${p}\``).join(', ') || '(none)';
  text += `| \`${o.id}\` | \`${restToolName(o)}\` | \`${o.method} ${o.path}\` | ${parameters} |\n`;
}
text += '\nThe vendor operation ID `updataSharedFolder` is exposed with the corrected tool name `rest_update_shared_folder`.\n\n## Direct native VNC/RFB console (6)\n\nAll console tools accept `vm_id`: an absolute VMX path, a unique inventory name, a configured console profile alias, or a REST VM ID when REST is configured. The VM must be running with native VNC explicitly bound to loopback and a local password profile. VMware Tools and guest login are unnecessary. Setup: [console guide](console.md).\n\n| Tool | Arguments |\n| --- | --- |\n';
for (const [name, schema] of Object.entries(consoleSchemas)) text += `| \`${name}\` | ${Object.keys(schema.shape).map(key => `\`${key}\``).join(', ')} |\n`;
text += '\n## Convenience tools (9) and capabilities\n\n`workstation_status`, `list_vms`, `get_vm_details`, `vm_power`, `list_snapshots`, `create_snapshot`, `revert_snapshot`, `delete_snapshot`, and `get_guest_ip` provide short workflows over vmrun. `workstation_capabilities` reports installed coverage and tool mappings. Total: **93 MCP tools**.\n';
await fs.writeFile('vmware-workstation/reference.md', text);
