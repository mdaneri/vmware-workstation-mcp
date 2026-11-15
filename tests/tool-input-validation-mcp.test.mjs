import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import metadata from '../package.json' with { type: 'json' };
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Keep the expected names independent of tools/list so dropping a registration
// or adding a tool without input-validation coverage fails this test.
const expectedTools = [
  'a_vmware_catalog',
  'a_vmware_mutate',
  'a_vmware_query',
  'attach_vm_adapter_to_lan_segment',
  'configure_vm',
  'console_click',
  'console_key',
  'console_screenshot',
  'console_scroll',
  'console_status',
  'console_type',
  'create_lan_segment',
  'create_snapshot',
  'create_vm',
  'delete_snapshot',
  'detach_vm_adapter_from_lan_segment',
  'disk_attach',
  'disk_compact',
  'disk_convert',
  'disk_create',
  'disk_defragment',
  'disk_detach',
  'disk_expand',
  'disk_inspect',
  'disk_manager_status',
  'get_guest_ip',
  'get_vm_details',
  'guest_exec',
  'iso_eject',
  'iso_list',
  'iso_mount',
  'job_cancel',
  'job_list',
  'job_logs',
  'job_start',
  'job_status',
  'lab_deploy',
  'lab_destroy',
  'lab_start',
  'lab_status',
  'lab_stop',
  'lab_validate',
  'list_lan_segments',
  'list_snapshots',
  'list_vms',
  'ovf_convert',
  'ovf_export',
  'ovf_import',
  'ovf_inspect',
  'ovf_tool_status',
  'ovf_validate',
  'plugin_catalog',
  'plugin_mutate',
  'plugin_query',
  'remove_lan_segment',
  'rest_change_power_state',
  'rest_config_vm_params',
  'rest_create_network',
  'rest_create_nic_device',
  'rest_create_shared_folder',
  'rest_create_vm',
  'rest_delete_nic_device',
  'rest_delete_portforward',
  'rest_delete_shared_folder',
  'rest_delete_vm',
  'rest_get_all_networks',
  'rest_get_all_nic_devices',
  'rest_get_all_shared_folders',
  'rest_get_all_vms',
  'rest_get_ip_address',
  'rest_get_mac_to_ips',
  'rest_get_nic_info',
  'rest_get_portforwards',
  'rest_get_power_state',
  'rest_get_vm',
  'rest_get_vm_params',
  'rest_get_vm_restrictions',
  'rest_register_vm',
  'rest_update_mac_to_ip',
  'rest_update_nic_device',
  'rest_update_portforward',
  'rest_update_shared_folder',
  'rest_update_vm',
  'revert_snapshot',
  'serial_configure',
  'serial_connect',
  'serial_disconnect',
  'serial_read',
  'serial_status',
  'serial_write',
  'template_deploy',
  'template_export',
  'template_list',
  'template_validate',
  'vm_boot_configure',
  'vm_boot_status',
  'vm_collect_diagnostics',
  'vm_get_recent_errors',
  'vm_hardware_capabilities',
  'vm_hardware_get',
  'vm_hardware_set',
  'vm_power',
  'vm_security_capabilities',
  'vm_security_status',
  'vm_wait_for_boot',
  'vm_wait_for_ip',
  'vm_wait_for_service',
  'vmrun_add_shared_folder',
  'vmrun_capture_screen',
  'vmrun_check_tools_state',
  'vmrun_clone',
  'vmrun_connect_named_device',
  'vmrun_copy_file_from_guest_to_host',
  'vmrun_copy_file_from_host_to_guest',
  'vmrun_create_directory_in_guest',
  'vmrun_create_tempfile_in_guest',
  'vmrun_delete_directory_in_guest',
  'vmrun_delete_file_in_guest',
  'vmrun_delete_port_forwarding',
  'vmrun_delete_snapshot',
  'vmrun_delete_vm',
  'vmrun_directory_exists_in_guest',
  'vmrun_disable_shared_folders',
  'vmrun_disconnect_named_device',
  'vmrun_download_photon_vm',
  'vmrun_enable_shared_folders',
  'vmrun_file_exists_in_guest',
  'vmrun_get_guest_ip_address',
  'vmrun_install_tools',
  'vmrun_kill_process_in_guest',
  'vmrun_list',
  'vmrun_list_directory_in_guest',
  'vmrun_list_host_networks',
  'vmrun_list_port_forwardings',
  'vmrun_list_processes_in_guest',
  'vmrun_list_snapshots',
  'vmrun_pause',
  'vmrun_read_variable',
  'vmrun_remove_shared_folder',
  'vmrun_rename_file_in_guest',
  'vmrun_reset',
  'vmrun_revert_to_snapshot',
  'vmrun_run_program_in_guest',
  'vmrun_run_script_in_guest',
  'vmrun_set_port_forwarding',
  'vmrun_set_shared_folder_state',
  'vmrun_snapshot',
  'vmrun_start',
  'vmrun_stop',
  'vmrun_suspend',
  'vmrun_type_keystrokes_in_guest',
  'vmrun_unpause',
  'vmrun_upgradevm',
  'vmrun_write_variable',
  'workstation_capabilities',
  'workstation_status',
];

test('the declared CLI exposes the complete MCP catalog', { timeout: 15000 }, async t => {
  const executable = path.resolve(metadata.bin['vmware-workstation-mcp']);
  const client = new Client({ name: 'cli-discovery', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.platform === 'win32' ? process.execPath : executable,
    args: process.platform === 'win32' ? [executable] : [],
    stderr: 'pipe',
  }));
  assert.equal(client.getServerVersion().version, metadata.version);
  const { tools, nextCursor } = await client.listTools();
  assert.equal(nextCursor, undefined);
  assert.deepEqual(tools.map(tool => tool.name).sort(), expectedTools);
});

test('the repository stdio entrypoint rejects unknown arguments for every registered tool', { timeout: 30000 }, async t => {
  const client = new Client({ name: 'tool-input-validation', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ['--disallow-code-generation-from-strings', '.'],
    stderr: 'pipe',
  }));
  const { tools, nextCursor } = await client.listTools();
  assert.equal(nextCursor, undefined);
  assert.deepEqual(tools.map(tool => tool.name).sort(), expectedTools);

  for (const { name, inputSchema } of tools) {
    await t.test(name, async () => {
      assert.equal(inputSchema.type, 'object');
      assert.equal(inputSchema.additionalProperties, false);
      const unexpected = 'unknown_test_argument';
      assert.ok(!Object.hasOwn(inputSchema.properties ?? {}, unexpected));
      const result = await client.callTool({ name, arguments: { [unexpected]: true } });
      assert.equal(result.isError, true);
      const message = result.content.filter(block => block.type === 'text').map(block => block.text).join(' ');
      assert.ok(message.includes(`Input validation error: Invalid arguments for tool ${name}:`), message);
      assert.match(message, /Unrecognized key[^.]*unknown_test_argument/);
    });
  }
});
