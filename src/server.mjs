import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Workstation } from './workstation.mjs';
import { Credentials } from './credentials.mjs';
import { commands, commandSchema, executeCommand, snake } from './vmrun-commands.mjs';
import { RestClient, restOperations, restProvenance, restSchema, restToolName } from './rest.mjs';
import importedHelp from './catalogs/vmrun-help.json' with { type: 'json' };
import { VMFiles, createVMSchema, configureVMSchema } from './vm-files.mjs';
import { ConsoleManager, consoleSchemas } from './console.mjs';
import { localFileProtector } from './local-file-security.mjs';
import { LanSegments, lanSegmentSchemas } from './lan-segments.mjs';

const backend = new Workstation();
const credentials = new Credentials();
const rest = new RestClient({ credentials, backend });
const vmFiles = new VMFiles(backend, { protectSensitiveFile: localFileProtector(backend) });
const lanSegments = new LanSegments(backend, vmFiles, { protectFile: localFileProtector(backend) });
const consoles = new ConsoleManager({ backend, credentials, rest });
const server = new McpServer({ name: 'vmware-workstation', version: '0.4.0' });
const vmx = z.string().min(1).describe('Absolute path to an existing VMware .vmx file, obtained from inventory or supplied by the user.');
const name = z.string().min(1).max(256).describe('Exact snapshot name.');
function tool(name, description, schema, readOnly, callback, destructive = !readOnly, openWorld = false) {
  server.registerTool(name, {
    description, inputSchema: schema instanceof z.ZodObject ? schema : z.object(schema).strict(),
    annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly, openWorldHint: openWorld },
  }, async args => {
    try {
      const result = await callback(args);
      if (Array.isArray(result?.content)) return { content: result.content.map(block => block.type === 'text' ? { ...block, text: credentials.redact(block.text) } : block) };
      return { content: [{ type: 'text', text: credentials.redact(JSON.stringify(result, null, 2)) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: credentials.redact(error.message) }] };
    }
  });
}
tool('console_screenshot', 'Capture a fresh PNG from this VM native VNC/RFB framebuffer. Never captures the host desktop. Works during BIOS/UEFI, PXE and installation without VMware Tools.', consoleSchemas.console_screenshot, true, a => consoles.screenshot(a.vm_id));
tool('console_click', 'Click VM framebuffer coordinates using a direct RFB PointerEvent. No host mouse, window activation or desktop focus is used.', consoleSchemas.console_click, false, a => consoles.click(a.vm_id, a.x, a.y, a.button));
tool('console_key', 'Send a named key or chord to this VM via RFB, for example F2, Escape, Enter, ArrowDown, Ctrl+Alt+Delete. No host keyboard input is used.', consoleSchemas.console_key, false, a => consoles.key(a.vm_id, a.key));
tool('console_type', 'Type text into the VM via RFB key events, including at pre-OS prompts. Does not use the clipboard, guest agents, or host keyboard injection. Guest keyboard layout affects text.', consoleSchemas.console_type, false, a => consoles.type(a.vm_id, a.text));
tool('console_scroll', 'Send RFB wheel events to the VM at the last console pointer position or framebuffer center. amount is the number of wheel ticks.', consoleSchemas.console_scroll, false, a => consoles.scroll(a.vm_id, a.direction, a.amount));
tool('console_status', 'Check this VM native loopback-only VNC configuration and authenticated RFB session. Does not start the VM or modify its VNC settings.', consoleSchemas.console_status, true, a => consoles.status(a.vm_id));
tool('create_vm', 'Create a new blank VMX and sparse virtual disk in a NEW directory using VMware Virtual Disk Manager. Configure CPUs, memory, firmware, networking and optional ISO. Does not install a guest OS or power on/register the VM.', createVMSchema, false, a => vmFiles.create(a), false);
tool('configure_vm', 'Edit a powered-off UTF-8 VMX with a backup. Set arbitrary VMX key/value strings or null to remove keys. Refuses running, locked, or detected suspended VMs. Use for CPU, memory, boot media, network and other VMX configuration.', configureVMSchema, false, a => vmFiles.configure(a));

tool('list_lan_segments', 'List the current host user LAN segment catalog. Optionally supply vmx to inspect adapter indices and segment associations, including orphaned IDs. Does not scan disks or change VMs.', lanSegmentSchemas.list_lan_segments, true, a => lanSegments.list(a));
tool('create_lan_segment', 'Create a named private LAN segment in Workstation preferences with a backup, or return the uniquely named existing segment. Close the Workstation/Player GUI first. Does not create a VMnet, DHCP server or VM adapter.', lanSegmentSchemas.create_lan_segment, false, a => lanSegments.create(a), false);
tool('remove_lan_segment', 'Remove a LAN segment from Workstation preferences with a backup. Refuses references in registered/running and supplied unregistered VMX files; detach those adapters first. Cannot discover other unregistered VMs. Close the Workstation/Player GUI first.', lanSegmentSchemas.remove_lan_segment, false, a => lanSegments.remove(a));
tool('attach_vm_adapter_to_lan_segment', 'Attach an existing powered-off VM adapter to a LAN segment. adapter is the zero-based ethernetN index. Backs up the UTF-8 VMX, clears any custom VMnet, and enables connection at next power-on. Close the Workstation/Player GUI first.', lanSegmentSchemas.attach_vm_adapter_to_lan_segment, false, a => lanSegments.attach(a));
tool('detach_vm_adapter_from_lan_segment', 'Detach an existing powered-off VM adapter from the specified LAN segment, preserving the adapter. Backs up the UTF-8 VMX, removes its segment ID, selects a replacement network (default NAT), and leaves the adapter disconnected at next power-on. Close the Workstation/Player GUI first.', lanSegmentSchemas.detach_vm_adapter_from_lan_segment, false, a => lanSegments.detach(a));
tool('workstation_status', 'Check local vmrun availability and count running VMs without changing them.', {}, true, () => backend.status());
tool('list_vms', 'List registered and running VMs. Stale inventory entries are retained and marked. This does not scan disks.', {}, true, () => backend.listVMs());
tool('get_vm_details', 'Read selected VM hardware configuration and whether the VM is running. Does not expose the full VMX.', { vmx }, true, a => backend.details(a.vmx));
tool('vm_power', 'Start, gracefully stop, reset, suspend, pause or unpause a VM. Defaults to soft mode. Hard stop/reset can lose data; use only when explicitly requested. No automatic hard fallback.', {
  vmx, action: z.enum(['start', 'stop', 'reset', 'suspend', 'pause', 'unpause']),
  mode: z.enum(['soft', 'hard']).default('soft'), gui: z.boolean().default(false),
}, false, a => backend.power(a.vmx, a.action, a.mode, a.gui));
tool('list_snapshots', 'List snapshot names without changing the VM.', { vmx }, true, a => backend.snapshots(a.vmx));
tool('create_snapshot', 'Create a named snapshot on the selected VM. Requires a user request to create it.', { vmx, name }, false, a => backend.snapshot(a.vmx, 'snapshot', a.name), false);
tool('revert_snapshot', 'Revert the VM to an existing snapshot. Discards later VM state; requires explicit user authorization for this VM and snapshot.', { vmx, name }, false, a => backend.snapshot(a.vmx, 'revertToSnapshot', a.name));
tool('delete_snapshot', 'Delete one named snapshot, preserving children. Removes a restore point; requires explicit user authorization for this VM and snapshot.', { vmx, name }, false, a => backend.snapshot(a.vmx, 'deleteSnapshot', a.name));
tool('get_guest_ip', 'Get the IP address reported by VMware Tools in a running VM. Does not log into the guest or wait for startup.', { vmx }, true, a => backend.guestIP(a.vmx));
for (const command of commands) {
  tool(`vmrun_${snake(command.command)}`, command.description, commandSchema(command), !!command.readOnly,
    a => executeCommand(backend, credentials, command, a), !command.readOnly, ['runProgramInGuest', 'runScriptInGuest', 'downloadPhotonVM'].includes(command.command));
}
for (const operation of restOperations) {
  tool(restToolName(operation), `${operation.category}: ${operation.id}. Calls ${operation.method} ${operation.path} on the configured Workstation REST service.`, restSchema(operation), operation.method === 'GET', a => rest.execute(operation, a));
}
tool('workstation_capabilities', 'Show full vmrun/REST tool coverage, compare the installed vmrun help against the implemented catalog, and report REST configuration without exposing secrets.', {}, true, async () => {
  const help = await backend.help();
  const installed = [...help.split('Examples:')[0].matchAll(/^([A-Za-z]\w+)\s{2,}.+$/gm)].map(match => match[1]).filter(value => !['Usage', 'COMMAND', 'POWER', 'SNAPSHOT', 'HOST', 'GUEST', 'GENERAL', 'Template'].includes(value));
  return {
    vmrunVersion: help.match(/vmrun version ([\w.]+)/)?.[1] || null,
    referenceVersion: importedHelp.version,
    vmrunCommands: commands.map(c => ({ command: c.command, tool: `vmrun_${snake(c.command)}` })),
    unimplementedInstalledCommands: installed.filter(name => !commands.some(c => c.command === name)),
    catalogCommandsMissingFromInstalledHelp: commands.filter(c => !installed.includes(c.command)).map(c => c.command),
    restOperations: restOperations.map(o => ({ operation: o.id, tool: restToolName(o), method: o.method, path: o.path })),
    restURL: rest.baseURL(), restSchema: restProvenance,
    credentialsFilePath: credentials.filename,
    consoleTools: Object.keys(consoleSchemas),
    lanSegmentTools: Object.keys(lanSegmentSchemas),
    lanSegmentPreferencesPath: lanSegments.filename,
    note: 'Coverage describes callable implementations. It does not prove a REST service is running, credentials work, or guest operations succeed.',
  };
});
process.stdin.once('end', () => consoles.close());
process.once('SIGTERM', () => { consoles.close(); process.exit(0); });
process.once('SIGINT', () => { consoles.close(); process.exit(0); });
server.connect(new StdioServerTransport()).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
