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
import { OvfManager, ovfSchemas } from './ovf.mjs';
import { JobManager, jobSchemas } from './jobs.mjs';
import { DiskManager, diskSchemas } from './disks.mjs';
import { SerialManager, serialSchemas } from './serial.mjs';
import { Readiness, readinessSchemas } from './readiness.mjs';
import { GuestExec, guestExecSchema } from './guest-exec.mjs';
import { IsoManager, isoSchemas } from './iso.mjs';
import { HardwareManager } from './hardware.mjs';
import { hardwareSchemas } from './hardware-schemas.mjs';
import { JobStore, jobDirectory } from './job-store.mjs';
import { JobOperations, jobStartSchema } from './job-operations.mjs';

const backend = new Workstation();
const credentials = new Credentials();
const rest = new RestClient({ credentials, backend, coordinateDiskEdits: true });
const vmFiles = new VMFiles(backend, { protectSensitiveFile: localFileProtector(backend) });
const lanSegments = new LanSegments(backend, vmFiles, { protectFile: localFileProtector(backend) });
const consoles = new ConsoleManager({ backend, credentials, rest });
const jobs = new JobManager({ redact: text => credentials.redact(text), resources: backend.resources,
  store: new JobStore({ directory: jobDirectory(), protectFile: localFileProtector(backend) }) });
const ovf = new OvfManager({ backend, credentials, jobs, rest });
const disks = new DiskManager({ backend, vmFiles });
const serial = new SerialManager({ backend, vmFiles, credentials, rest });
const readiness = new Readiness({ backend, credentials, consoles, protectFile: localFileProtector(backend) });
const guestExec = new GuestExec({ backend, credentials, protectFile: localFileProtector(backend) });
const media = new IsoManager({ backend, vmFiles });
const hardware = new HardwareManager({ backend, vmFiles, disks, lan: lanSegments });
const jobOperations = new JobOperations({ backend, jobs, disks, ovf });
const server = new McpServer({ name: 'vmware-workstation', version: '0.12.0' });
const vmx = z.string().min(1).describe('Absolute path to an existing VMware .vmx file, obtained from inventory or supplied by the user.');
const name = z.string().min(1).max(256).describe('Exact snapshot name.');

tool('vm_hardware_capabilities', 'Inspect installed native Workstation product version and conservative typed hardware limits. No power or configuration changes. vTPM writes require an unavailable encryption backend; nested CPU and guest driver support remain unverified.', hardwareSchemas.vm_hardware_capabilities, true, () => hardware.capabilities());
tool('vm_hardware_get', 'Read typed declared CPU topology, memory, nested virtualization, firmware/security, storage and NIC configuration. Omits unrelated VMX secrets and does not infer missing values or claim live device support.', hardwareSchemas.vm_hardware_get, true, a => hardware.get(a));
tool('vm_hardware_set', 'Apply explicit typed offline hardware changes with VMX backup and concurrency checks. Requires confirm=true, supported installed worker, full power-off and closed VMware GUI. Preserves omitted devices and NIC identity; no disk replacement, encryption or vTPM mutation.', hardwareSchemas.vm_hardware_set, false, a => hardware.set(a));

tool('iso_list', 'Inspect optical devices, ISO backings and configured connection/start-connected state. Does not claim live connection state or mount anything.', isoSchemas.iso_list, true, a => media.list(a));
tool('iso_mount', 'Attach an existing allowlisted local ISO to an optical or unused IDE/SATA slot, with VMX backup. Requires confirm=true and fully powered-off, unlocked VM. Refuses ambiguous devices and occupied disk slots. No live hot-swap or power-on.', isoSchemas.iso_mount, false, a => media.edit(a));
tool('iso_eject', 'Disable the selected optical device and remove its backing path, with VMX backup. Requires confirm=true and full power-off. Preserves ISO files, controller and unrelated devices. A later mount re-enables the slot.', isoSchemas.iso_eject, false, a => media.edit(a, true));
tool('vm_boot_status', 'Inspect firmware/boot VMX values and installed vmrun version. Boot-order and next-boot firmware writes report unsupported until installed-version compatibility is proven; no configuration or power changes.', isoSchemas.vm_boot_status, true, a => media.bootStatus(a));
tool('vm_boot_configure', 'Request boot-order or next-boot firmware configuration. Currently fails explicitly with UNSUPPORTED_CAPABILITY and writes nothing: no installed-version-verified headless backend is available.', isoSchemas.vm_boot_configure, false, a => media.configureBoot(a));
tool('guest_exec', 'Execute an explicitly authorized guest program with literal arguments or an explicit interpreter/script using a required local credential profile. Captures bounded redacted stdout/stderr and verifies exit codes through a unique completion record. Requires Tools and Python 3 on Linux or Windows PowerShell 5.1. Transport success alone never means guest success. Timeout/cancellation may leave a running guest process; never retry automatically.', guestExecSchema, false, (a, extra) => guestExec.execute(a, extra), true, true, false);
for (const kind of ['boot', 'ip', 'service']) tool(`vm_wait_for_${kind}`, {
  boot: 'Wait for VMware Tools running in the selected VM, indicating OS agent readiness only. Power-on, login and application readiness are separate. Bounded total timeout, polling and MCP cancellation; never starts a VM.',
  ip: 'Wait for a valid guest IP published by VMware Tools. Does not establish network reachability or service readiness. Bounded total timeout and cancellation; never starts a VM.',
  service: 'Probe only the selected VM Tools-reported IP and explicit port. TCP means connection accepted; HTTP(S) means expected status, with no redirects or retained body/headers. Does not execute guest commands. Bounded deadline and cancellation.',
}[kind], readinessSchemas[`vm_wait_for_${kind}`], true, (a, extra) => readiness.wait(kind, a, extra), false, kind === 'service');
tool('vm_get_recent_errors', 'Read bounded current vmware.log data only after verifying its selected VM identity. Returns normalized error excerpts and actions; arbitrary log text/paths/secrets are omitted. No host log scan.', readinessSchemas.vm_get_recent_errors, true, a => readiness.recentErrors(a));
tool('vm_collect_diagnostics', 'Save selected VM allowlisted hardware, lifecycle, Tools/IP, snapshot count and normalized log excerpts into a NEW approved directory. Optional direct VNC guest pixels are unredacted: review before sharing. Never captures host desktop or executes guest commands.', readinessSchemas.vm_collect_diagnostics, false, (a, extra) => readiness.collect(a, extra), false, false, false);
function tool(name, description, schema, readOnly, callback, destructive = !readOnly, openWorld = false, idempotent = readOnly) {
  server.registerTool(name, {
    description, inputSchema: schema instanceof z.ZodObject ? schema : z.object(schema).strict(),
    annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: openWorld },
  }, async (args, extra) => {
    try {
      if (name.startsWith('job_') || name.startsWith('ovf_') && name !== 'ovf_tool_status') await jobs.initialize();
      const result = await callback(args, extra);
      if (result?.job_id || name === 'job_list') return { content: [{ type: 'text', text: JSON.stringify(jobs.publicResult(result), null, 2) }] };
      if (Array.isArray(result?.content)) return { content: result.content.map(block => block.type === 'text' ? { ...block, text: credentials.redact(block.text) } : block) };
      return { content: [{ type: 'text', text: credentials.redact(JSON.stringify(result, null, 2)) }] };
    } catch (error) {
      if (name.startsWith('serial_')) return { isError: true, content: [{ type: 'text', text: credentials.redact(JSON.stringify({ code: error.code || 'SERIAL_SETUP_REQUIRED', message: error.message })) }] };
      return { isError: true, content: [{ type: 'text', text: credentials.redact(error.details || name.startsWith('disk_') ? JSON.stringify({ code: error.code || 'DISK_PREFLIGHT_FAILED', message: error.message, action: 'Inspect the target and disk_manager_status before retrying.', ...error.details }) : error.message) }] };
    }
  });
}

tool('serial_status', 'Inspect optional per-VM serial capability/configuration and session state without connecting or starting a VM. Only a connected session proves native endpoint ownership.', serialSchemas.serial_status, true, a => serial.status(a));
tool('serial_configure', 'Explicitly replace or disable one serial port configuration in a powered-off unlocked VMX, with a backup. Requires confirm=true after authorization. Uses only a generated per-VM local pipe/socket; never starts a VM.', serialSchemas.serial_configure, false, a => serial.configure(a));
tool('serial_connect', 'Explicitly connect to the configured VM serial pipe/socket after verifying native VMware ownership. Guest serial output must be enabled separately. No host terminal, desktop or remote TCP access.', serialSchemas.serial_connect, false, (a, extra) => serial.connect(a, extra), false);
tool('serial_read', 'Read at most max_bytes from an explicitly connected VM serial port. Bounded wait returns timed_out with empty data. Base64 preserves bytes; UTF-8 also returns raw_base64. MCP cancellation preserves unread bytes.', serialSchemas.serial_read, true, (a, extra) => serial.read(a, extra), false, false, false);
tool('serial_write', 'Send 1-65536 UTF-8 or canonical base64 bytes to an explicitly connected VM serial port. Can change guest state; requires authorization for the intended input. Timeout/cancellation may leave partial input; never replay automatically.', serialSchemas.serial_write, false, (a, extra) => serial.write(a, extra));
tool('serial_disconnect', 'Close this VM serial session, cancel pending I/O and discard its buffer. Does not stop the VM or change its serial hardware.', serialSchemas.serial_disconnect, false, a => serial.disconnect(a), false);
tool('console_screenshot', 'Capture a fresh PNG from this VM native VNC/RFB framebuffer. Never captures the host desktop. Works during BIOS/UEFI, PXE and installation without VMware Tools.', consoleSchemas.console_screenshot, true, a => consoles.screenshot(a.vm_id));
tool('console_click', 'Click VM framebuffer coordinates using a direct RFB PointerEvent. No host mouse, window activation or desktop focus is used.', consoleSchemas.console_click, false, a => consoles.click(a.vm_id, a.x, a.y, a.button));
tool('console_key', 'Send a named key or chord to this VM via RFB, for example F2, Escape, Enter, ArrowDown, Ctrl+Alt+Delete. No host keyboard input is used.', consoleSchemas.console_key, false, a => consoles.key(a.vm_id, a.key));
tool('console_type', 'Type text into the VM via RFB key events, including at pre-OS prompts. Does not use the clipboard, guest agents, or host keyboard injection. Guest keyboard layout affects text.', consoleSchemas.console_type, false, a => consoles.type(a.vm_id, a.text));
tool('console_scroll', 'Send RFB wheel events to the VM at the last console pointer position or framebuffer center. amount is the number of wheel ticks.', consoleSchemas.console_scroll, false, a => consoles.scroll(a.vm_id, a.direction, a.amount));
tool('console_status', 'Check this VM native loopback-only VNC configuration and authenticated RFB session. Does not start the VM or modify its VNC settings.', consoleSchemas.console_status, true, a => consoles.status(a.vm_id));
tool('create_vm', 'Create a new blank VMX and sparse virtual disk in a NEW directory using VMware Virtual Disk Manager. Configure CPUs, memory, firmware, networking and optional ISO. Does not install a guest OS or power on/register the VM.', createVMSchema, false, a => vmFiles.create(a), false);
tool('configure_vm', 'Edit a powered-off UTF-8 VMX with a backup. Set arbitrary VMX key/value strings or null to remove keys. Refuses running, locked, or detected suspended VMs. Use for CPU, memory, boot media, network and other VMX configuration.', configureVMSchema, false, a => vmFiles.configure(a));

tool('disk_manager_status', 'Discover native VMware Virtual Disk Manager and the exact flags/disk types advertised by its installed help. Missing capabilities return actionable status.', diskSchemas.disk_manager_status, true, () => disks.status());
tool('disk_inspect', 'Read a local VMDK descriptor, capacity, extents and backing-chain metadata. No disk-manager repair, guest mount or filesystem access.', diskSchemas.disk_inspect, true, a => disks.inspect(a));
tool('disk_create', 'Create a local VMDK in a NEW parent directory to protect companion extents. Supports installed growable/preallocated single/split disk types 0-3.', diskSchemas.disk_create, false, a => disks.perform('create', a), false);
tool('disk_expand', 'Expand an independent offline VMDK to total capacity_mb. Requires explicit confirmation; refuses snapshots, locks, shared/backing chains. Does not resize guest partitions or filesystems.', diskSchemas.disk_expand, false, a => disks.perform('expand', a));
tool('disk_convert', 'Convert an independent offline local VMDK into a NEW parent directory, preserving the original. Supports advertised types 0-3 and stream-optimized output type 5. Partial output is retained on failure.', diskSchemas.disk_convert, false, a => disks.perform('convert', a), false);
tool('disk_compact', 'Compact an independent offline growable VMDK using installed -k capability. Requires explicit confirmation. Guest free-space preparation is separate; no guest filesystem resize.', diskSchemas.disk_compact, false, a => disks.perform('compact', a));
tool('disk_defragment', 'Defragment an independent offline growable VMDK using installed -d capability. Requires explicit confirmation and conservative free-space checks.', diskSchemas.disk_defragment, false, a => disks.perform('defragment', a));
tool('disk_attach', 'Attach an independent VMDK to an existing controller and explicit unused unit in a powered-off VMX, with a backup. Refuses snapshots, locked/suspended VMs and known shared disks. confirm requires authorization.', diskSchemas.disk_attach, false, a => disks.edit(a, false));
tool('disk_detach', 'Remove the explicit VMX disk slot after verifying its expected VMDK, with a backup. Never deletes the underlying VMDK or extents. Requires authorization and a powered-off snapshot-free VM.', diskSchemas.disk_detach, false, a => disks.edit(a, true));

tool('ovf_tool_status', 'Discover optional local VMware OVF Tool, version and supported flags. VMWARE_OVFTOOL_PATH overrides automatic discovery with an absolute executable path.', ovfSchemas.ovf_tool_status, true, () => ovf.status());
tool('ovf_inspect', 'Start a read-only background appliance probe. job_status.result reports hardware, disks, NICs, properties, deployment options and manifest checks. Local flat OVF/OVA packages only.', ovfSchemas.ovf_inspect, true, a => ovf.start('ovf_inspect', a));
tool('ovf_validate', 'Start read-only local OVF/OVA schema and manifest validation. Returns a job ID. Remote-host compatibility, signer trust and guest boot are not established.', ovfSchemas.ovf_validate, true, a => ovf.start('ovf_validate', a));
tool('ovf_import', 'Start an OVF/OVA import into a NEW VM directory. Supports typed network/property mappings and explicit EULA acceptance. Registration through REST and headless power-on are opt-in. Returns a job ID; poll job_status.', ovfSchemas.ovf_import, false, a => ovf.start('ovf_import', a), false);
tool('ovf_export', 'Start a powered-off VMX export to OVF/OVA. Refuses snapshots, locks, saved state, external backings, encryption and vTPM. OVF needs a new parent directory. Only OVA permits explicit overwrite=true. Returns a job ID.', ovfSchemas.ovf_export, false, a => ovf.start('ovf_export', a));
tool('ovf_convert', 'Start a local OVF/OVA/VMX conversion using VMware OVF Tool. VMX sources require power-off and no snapshots. OVF/VMX targets need new parent directories; overwrite is limited to OVA. Returns a job ID.', ovfSchemas.ovf_convert, false, a => ovf.start('ovf_convert', a));
tool('job_start', 'Start a bounded background job of explicit disk conversion/expansion, full offline cloning or headless VM power steps. Requires confirm=true for every target and action. Steps run sequentially and stop on failure; separate unrelated jobs run concurrently. Returns a job ID; inspect status, partial results and artifact paths before retrying.', jobStartSchema, false, a => jobOperations.start(a));
tool('job_status', 'Read background state, genuine backend progress and verified result/error from private bounded journals. Unfinished prior-session jobs report interrupted with unknown outcome and are never replayed.', jobSchemas.job_status, true, a => jobs.status(a.job_id));
tool('job_list', 'List up to 100 current and retained historical jobs from private redacted journals, retained for at most seven days. History does not imply a previous process has stopped.', jobSchemas.job_list, true, () => jobs.list());
tool('job_cancel', 'Request cancellation of a current job and its native process tree. Locks remain until process cleanup finishes. Partial files and VM changes may remain; inspect before retrying.', jobSchemas.job_cancel, false, a => jobs.cancel(a.job_id));
tool('job_logs', 'Read bounded, redacted background job output. Raw probe metadata/property defaults are omitted. A truncated log is explicitly marked.', jobSchemas.job_logs, true, a => jobs.logs(a.job_id));

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
  let help = ''; let executable;
  let vmrunCapability;
  try {
    executable = await backend.executable(); help = await backend.help();
    vmrunCapability = { executable, executable_discovered: true, help_verified: true, live_support: 'unknown' };
  } catch {
    vmrunCapability = { executable: executable || null, executable_discovered: !!executable, help_verified: false, live_support: 'unknown', category: 'capability_unavailable', action: 'Install native VMware Workstation or configure VMRUN_PATH; discovery does not prove hypervisor support.' };
  }
  const installed = [...help.split('Examples:')[0].matchAll(/^([A-Za-z]\w+)\s{2,}.+$/gm)].map(match => match[1]).filter(value => !['Usage', 'COMMAND', 'POWER', 'SNAPSHOT', 'HOST', 'GUEST', 'GENERAL', 'Template'].includes(value));
  return {
    vmrunVersion: help.match(/vmrun version ([\w.]+)/)?.[1] || null,
    vmrunCapability,
    referenceVersion: importedHelp.version,
    vmrunCommands: commands.map(c => ({ command: c.command, tool: `vmrun_${snake(c.command)}` })),
    unimplementedInstalledCommands: installed.filter(name => !commands.some(c => c.command === name)),
    catalogCommandsMissingFromInstalledHelp: commands.filter(c => !installed.includes(c.command)).map(c => c.command),
    restOperations: restOperations.map(o => ({ operation: o.id, tool: restToolName(o), method: o.method, path: o.path })),
    restURL: rest.baseURL(), restSchema: restProvenance,
    credentialsFilePath: credentials.filename,
    consoleTools: Object.keys(consoleSchemas),
    serialTools: Object.keys(serialSchemas),
    lanSegmentTools: Object.keys(lanSegmentSchemas),
    lanSegmentPreferencesPath: lanSegments.filename,
    ovfTool: await ovf.status(),
    ovfTools: Object.keys(ovfSchemas),
    backgroundJobTools: Object.keys(jobSchemas),
    jobSubmission: { tool: 'job_start', maximumConcurrent: 4, maximumSteps: 16, persistence: 'bounded private journals; no replay', locks: 'shared VM and resource reservations in this server; external writers must remain closed' },
    diskManager: await disks.status(),
    diskTools: Object.keys(diskSchemas),
    readinessTools: Object.keys(readinessSchemas),
    guestExecution: { tool: 'guest_exec', backend: 'vmware_tools', verifiedExitCode: 'matching_completion_record_only', linuxRequires: '/usr/bin/python3', windowsRequires: 'Windows PowerShell 5.1', liveSupport: 'unknown' },
    capabilityEvidence: { diskManager: 'Installed help when available; no live disk operation is performed.', ovfTool: 'Installed version/help when available; no live appliance operation is performed.', nativeHypervisor: 'not_proven_by_discovery', firmwareBoot: { configurable: ['bios', 'efi', 'bootOrder', 'bootDelay', 'forceSetupOnce'], evidence: 'VMX configuration implementation; not a live firmware test', liveSupport: 'unknown', consoleRequires: 'Explicit per-VM native VNC setup; console_status proves only that VM connection.' } },
    note: 'Coverage describes callable implementations. It does not prove a REST service is running, credentials work, or guest operations succeed.',
  };
});
async function shutdown() { serial.close(); consoles.close(); await jobs.close(); }
process.stdin.once('end', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
server.connect(new StdioServerTransport()).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
