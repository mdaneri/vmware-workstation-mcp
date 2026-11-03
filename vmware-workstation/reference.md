# Complete operation reference

Generated from the command implementations and installed REST contract. Source version: vmrun 1.17.0.25688693; vmrest 1.3.1 build 25688693.

## Reusable asynchronous jobs (1 new submission tool)

Read the [job guide](jobs.md) for sequential disk/clone/power steps, concurrent unrelated jobs, shared reservations, process-tree cancellation and private durable history. `job_start` requires explicit confirmation for every step. `job_status`, `job_list`, `job_logs` and `job_cancel` are shared with the OVF workflow. Progress stays null unless supplied by the native backend.

| Tool | Arguments |
| --- | --- |
| `job_start` | `steps`, `confirm`, `timeout_seconds` |

## Verified guest execution (1)

Read the [guest execution guide](guest-exec.md) for explicit profiles, program and script examples, runtime prerequisites, bounded output, transport versus guest exit status, timeout and cleanup semantics. No automatic retries or console fallback.

| Tool | Arguments |
| --- | --- |
| `guest_exec` | `vmx`, `guest_profile`, `vm_password_profile`, `guest_os`, `program`, `arguments`, `script`, `interpreter`, `interpreter_arguments`, `guest_temp_directory`, `timeout_seconds`, `max_output_bytes`, `confirm` |

## Optional direct serial console (6)

Read the [serial guide](serial.md) for explicit powered-off setup, guest prerequisites and runnable byte I/O examples. Windows uses local named pipes; Linux uses private local UNIX sockets. Endpoints are generated per canonical VMX and port (0-3). Connect verifies the native VMware worker and never starts a VM. Read/write require an explicit session. Reads, writes, waits, buffers and session counts are bounded; disconnect cancels pending I/O. No remote sockets, host terminal, desktop capture or keyboard injection.

| Tool | Arguments |
| --- | --- |
| `serial_status` | `vm_id`, `port` |
| `serial_configure` | `vm_id`, `port`, `enabled`, `confirm` |
| `serial_connect` | `vm_id`, `port`, `timeout_ms` |
| `serial_read` | `vm_id`, `port`, `max_bytes`, `encoding`, `timeout_ms` |
| `serial_write` | `vm_id`, `port`, `data`, `encoding`, `timeout_ms` |
| `serial_disconnect` | `vm_id`, `port` |

## VM readiness and diagnostics (5)

Read the [readiness guide](readiness.md) for distinct OS agent, IP and service criteria, total deadlines, cancellation, normalized error excerpts and private bundles. Nothing starts or reconfigures a VM. Services use only the Tools-reported IP; HTTP redirects and response bodies are never retained. Diagnostic destinations require configured approved roots and a new directory. Guest-only RFB evidence is opt-in and its pixels are not redacted.

| Tool | Arguments |
| --- | --- |
| `vm_wait_for_boot` | `vmx`, `vm_password_profile`, `timeout_seconds`, `poll_interval_ms` |
| `vm_wait_for_ip` | `vmx`, `vm_password_profile`, `timeout_seconds`, `poll_interval_ms` |
| `vm_wait_for_service` | `vmx`, `vm_password_profile`, `timeout_seconds`, `poll_interval_ms`, `port`, `protocol`, `path`, `expected_status` |
| `vm_get_recent_errors` | `vmx`, `vm_password_profile`, `max_bytes`, `max_entries` |
| `vm_collect_diagnostics` | `vmx`, `vm_password_profile`, `destination_directory`, `include_console`, `max_log_bytes` |

## VMDK lifecycle (9)

Read the [disk guide](disks.md) for create/inspect/expand/convert and explicit controller/slot attachment examples. Runtime help gates native operations. Output requires a NEW parent directory to protect companion files. In-place edits and attachment changes require `confirm: true`, powered-off snapshot-free VMs and independent disks. Detach preserves backing files. Capacity expansion does not resize guest partitions or filesystems.

| Tool | Arguments |
| --- | --- |
| `disk_manager_status` | (none) |
| `disk_inspect` | `disk` |
| `disk_create` | `destination`, `capacity_mb`, `disk_type`, `adapter`, `timeout_seconds` |
| `disk_expand` | `disk`, `vmx_paths`, `confirm`, `timeout_seconds`, `capacity_mb` |
| `disk_convert` | `disk`, `vmx_paths`, `confirm`, `timeout_seconds`, `destination`, `disk_type` |
| `disk_compact` | `disk`, `vmx_paths`, `confirm`, `timeout_seconds` |
| `disk_defragment` | `disk`, `vmx_paths`, `confirm`, `timeout_seconds` |
| `disk_attach` | `vmx`, `controller`, `controller_index`, `unit`, `confirm`, `disk`, `vmx_paths` |
| `disk_detach` | `vmx`, `controller`, `controller_index`, `unit`, `confirm`, `disk`, `vmx_paths` |

## Local OVF/OVA appliances and background jobs (10)

Optional VMware OVF Tool is discovered automatically or configured with an absolute `VMWARE_OVFTOOL_PATH`. `ovf_tool_status` reports executable, version and installed flags. All other OVF tools return a background job ID, including read-only inspection/validation. Poll `job_status` until terminal; inspect `result` or `error`. See the [appliance workflow guide](ovf.md) for path configuration, examples, overwrite policy and limitations.

| Tool | Arguments |
| --- | --- |
| `ovf_tool_status` | (none) |
| `ovf_inspect` | `source`, `timeout_seconds` |
| `ovf_validate` | `source`, `timeout_seconds` |
| `ovf_import` | `source`, `directory`, `name`, `network_mappings`, `property_mappings`, `property_profile`, `deployment_option`, `accept_eulas`, `timeout_seconds`, `register`, `power_on` |
| `ovf_export` | `vmx`, `destination`, `overwrite`, `timeout_seconds` |
| `ovf_convert` | `source`, `destination`, `overwrite`, `name`, `network_mappings`, `property_mappings`, `property_profile`, `deployment_option`, `accept_eulas`, `timeout_seconds` |
| `job_status` | `job_id` |
| `job_list` | (none) |
| `job_cancel` | `job_id` |
| `job_logs` | `job_id` |

Only flat local appliances are supported. VMX exports refuse running/locked/suspended/encrypted/vTPM/snapshot sources and external backings. OVF/VMX targets require new parent directories; only a single OVA file can be explicitly overwritten. Import registration and headless power-on default to false. Jobs use shared locks and bounded private journals; cancellation/timeouts/interruption may leave partial files and never imply rollback. See [jobs](jobs.md) for restart and retention semantics.

## ISO media and boot capabilities (5)

Read the [ISO guide](iso.md) for existing-VM mount/eject workflows, slot selection and capability failures. All media edits require confirmation, full power-off and exclusive configuration access. Boot writes and live hot-swap are unsupported. Connection fields are configuration, not verified runtime state.

| Tool | Arguments |
| --- | --- |
| `iso_list` | `vmx` |
| `iso_mount` | `vmx`, `iso_path`, `device`, `start_connected`, `confirm` |
| `iso_eject` | `vmx`, `device`, `confirm` |
| `vm_boot_status` | `vmx` |
| `vm_boot_configure` | `vmx`, `firmware_once`, `boot_order`, `confirm` |

## Typed hardware (3)

Read the [hardware guide](hardware.md) for multi-controller and multi-NIC nested lab creation, safe typed patches and capability limits. Existing devices and NIC identity are retained. vTPM changes require an unavailable encryption backend and fail explicitly.

| Tool | Arguments |
| --- | --- |
| `vm_hardware_capabilities` | (none) |
| `vm_hardware_get` | `vmx` |
| `vm_hardware_set` | `vmx`, `confirm`, `cpus`, `cores_per_socket`, `memory_mb`, `nested_virtualization`, `firmware`, `secure_boot`, `vtpm`, `controllers`, `nics` |

## New VM creation and local configuration

`create_vm` creates a blank VMX and sparse VMDK in a new directory. Required: `directory`, `name`. Options: `guest_os`, `memory_mb`, `cpus`, `disk_gb`, `hardware_version`, `firmware`, `network`, `vmnet`, `iso_path`, `timeout_seconds`. Optional typed additions: `controllers`, `disks`, `nics`, `cores_per_socket`, `nested_virtualization`, `secure_boot`, `vtpm`. Omitting every addition uses the original creation path and defaults.

`configure_vm` edits a powered-off UTF-8 VMX with a backup. Required: `vmx`, `settings` (VMX keys to string values, or null to remove). It rejects running/locked/detected suspended VMs.

## LAN segments (5)

These tools edit the current user Workstation preferences catalog and adapter VMX settings, independently of REST/VMnets. Close the Workstation/Player GUI for mutations. Adapter edits require a powered-off, unlocked UTF-8 VMX; catalog edits support UTF-8 and windows-1252 without transcoding unrelated preferences. All file changes create backups (except initializing a missing catalog). See [LAN segment workflows](README.md#lan-segments) for examples and removal coverage.

| Tool | Arguments |
| --- | --- |
| `list_lan_segments` | `vmx` |
| `create_lan_segment` | `name` |
| `remove_lan_segment` | `segment`, `vmx_paths` |
| `attach_vm_adapter_to_lan_segment` | `vmx`, `adapter`, `segment` |
| `detach_vm_adapter_from_lan_segment` | `vmx`, `adapter`, `segment`, `network`, `vmnet` |

`adapter` is zero-based (`0` = `ethernet0`); `segment` accepts a name or pvnID. `list_lan_segments.vmx` is optional. Removal checks registered/running VMs and optional `vmx_paths`, refuses any remaining references, and cannot discover other unregistered VMs. Detach selects `network` (default `nat`; `custom` requires `vmnet`) and leaves the adapter disconnected, without removing it. An orphaned pvnID can be detached by ID.

## vmrun commands (47)

All tools accept `timeout_seconds` (default 120). VM tools require `vmx` and accept optional `vm_password_profile` and `guest_profile`. Guest operations default `guest_profile` to `default`. Output-file operations accept `overwrite` (default false). Optional arguments are marked with `?`; defaulted arguments show their defaults.

| CLI command | MCP tool | Operation arguments | Guest auth | Effect |
| --- | --- | --- | --- | --- |
| `start` | `vmrun_start` | `mode=nogui` | Optional for VM commands | Change |
| `stop` | `vmrun_stop` | `mode=soft` | Optional for VM commands | Change |
| `reset` | `vmrun_reset` | `mode=soft` | Optional for VM commands | Change |
| `suspend` | `vmrun_suspend` | `mode=soft` | Optional for VM commands | Change |
| `pause` | `vmrun_pause` | (none) | Optional for VM commands | Change |
| `unpause` | `vmrun_unpause` | (none) | Optional for VM commands | Change |
| `listSnapshots` | `vmrun_list_snapshots` | `show_tree?` | Optional for VM commands | Read |
| `snapshot` | `vmrun_snapshot` | `name` | Optional for VM commands | Change |
| `deleteSnapshot` | `vmrun_delete_snapshot` | `name`, `delete_children?` | Optional for VM commands | Change |
| `revertToSnapshot` | `vmrun_revert_to_snapshot` | `name` | Optional for VM commands | Change |
| `listHostNetworks` | `vmrun_list_host_networks` | (none) | Optional for VM commands | Read |
| `listPortForwardings` | `vmrun_list_port_forwardings` | `vmnet` | Optional for VM commands | Read |
| `setPortForwarding` | `vmrun_set_port_forwarding` | `vmnet`, `protocol`, `host_port`, `guest_ip`, `guest_port`, `description?` | Optional for VM commands | Change |
| `deletePortForwarding` | `vmrun_delete_port_forwarding` | `vmnet`, `protocol`, `host_port` | Optional for VM commands | Change |
| `runProgramInGuest` | `vmrun_run_program_in_guest` | `no_wait?`, `active_window?`, `interactive?`, `program`, `arguments?` | Required | Change |
| `fileExistsInGuest` | `vmrun_file_exists_in_guest` | `guest_path` | Required | Read |
| `directoryExistsInGuest` | `vmrun_directory_exists_in_guest` | `guest_path` | Required | Read |
| `setSharedFolderState` | `vmrun_set_shared_folder_state` | `share_name`, `host_path`, `access` | Optional for VM commands | Change |
| `addSharedFolder` | `vmrun_add_shared_folder` | `share_name`, `host_path` | Optional for VM commands | Change |
| `removeSharedFolder` | `vmrun_remove_shared_folder` | `share_name` | Optional for VM commands | Change |
| `enableSharedFolders` | `vmrun_enable_shared_folders` | `runtime_only?` | Optional for VM commands | Change |
| `disableSharedFolders` | `vmrun_disable_shared_folders` | (none) | Optional for VM commands | Change |
| `listProcessesInGuest` | `vmrun_list_processes_in_guest` | (none) | Required | Read |
| `killProcessInGuest` | `vmrun_kill_process_in_guest` | `pid` | Required | Change |
| `runScriptInGuest` | `vmrun_run_script_in_guest` | `no_wait?`, `active_window?`, `interactive?`, `interpreter`, `script` | Required | Change |
| `deleteFileInGuest` | `vmrun_delete_file_in_guest` | `guest_path` | Required | Change |
| `createDirectoryInGuest` | `vmrun_create_directory_in_guest` | `guest_path` | Required | Change |
| `deleteDirectoryInGuest` | `vmrun_delete_directory_in_guest` | `guest_path` | Required | Change |
| `CreateTempfileInGuest` | `vmrun_create_tempfile_in_guest` | (none) | Required | Change |
| `listDirectoryInGuest` | `vmrun_list_directory_in_guest` | `guest_path` | Required | Read |
| `CopyFileFromHostToGuest` | `vmrun_copy_file_from_host_to_guest` | `host_path`, `guest_path` | Required | Change |
| `CopyFileFromGuestToHost` | `vmrun_copy_file_from_guest_to_host` | `guest_path`, `host_path` | Required | Change |
| `renameFileInGuest` | `vmrun_rename_file_in_guest` | `source_path`, `destination_path` | Required | Change |
| `typeKeystrokesInGuest` | `vmrun_type_keystrokes_in_guest` | `text` | Required | Change |
| `connectNamedDevice` | `vmrun_connect_named_device` | `device_name` | Optional for VM commands | Change |
| `disconnectNamedDevice` | `vmrun_disconnect_named_device` | `device_name` | Optional for VM commands | Change |
| `captureScreen` | `vmrun_capture_screen` | `host_path` | Optional for VM commands | Change |
| `writeVariable` | `vmrun_write_variable` | `scope`, `name`, `value` | Optional for VM commands | Change |
| `readVariable` | `vmrun_read_variable` | `scope`, `name` | Optional for VM commands | Read |
| `getGuestIPAddress` | `vmrun_get_guest_ip_address` | `wait?` | Optional for VM commands | Read |
| `list` | `vmrun_list` | (none) | Optional for VM commands | Read |
| `upgradevm` | `vmrun_upgradevm` | (none) | Optional for VM commands | Change |
| `installTools` | `vmrun_install_tools` | (none) | Optional for VM commands | Change |
| `checkToolsState` | `vmrun_check_tools_state` | (none) | Optional for VM commands | Read |
| `deleteVM` | `vmrun_delete_vm` | (none) | Optional for VM commands | Change |
| `clone` | `vmrun_clone` | `destination_vmx`, `clone_type`, `snapshot?`, `clone_name?` | Optional for VM commands | Change |
| `downloadPhotonVM` | `vmrun_download_photon_vm` | `destination_path` | Optional for VM commands | Change |

## REST operations (28)

Parameter names follow the tool schema; JSON body fields preserve VMware names such as `parentId`, `host_path`, and `guestIp`. Optional `vm_password_profile` selects the encrypted VM password. No tool accepts a raw password. All accept `timeout_seconds`.

| API operation | MCP tool | Method and route | Tool arguments |
| --- | --- | --- | --- |
| `getAllVMs` | `rest_get_all_vms` | `GET /api/vms` | (none) |
| `createVM` | `rest_create_vm` | `POST /api/vms` | `params`, `vm_password_profile?` |
| `getVM` | `rest_get_vm` | `GET /api/vms/{id}` | `id`, `vm_password_profile?` |
| `updateVM` | `rest_update_vm` | `PUT /api/vms/{id}` | `id`, `parameters`, `vm_password_profile?` |
| `deleteVM` | `rest_delete_vm` | `DELETE /api/vms/{id}` | `id`, `vm_password_profile?` |
| `getVMRestrictions` | `rest_get_vm_restrictions` | `GET /api/vms/{id}/restrictions` | `id`, `vm_password_profile?` |
| `registerVM` | `rest_register_vm` | `POST /api/vms/registration` | `parameters` |
| `getVMParams` | `rest_get_vm_params` | `GET /api/vms/{id}/params/{name}` | `id`, `name`, `vm_password_profile?` |
| `configVMParams` | `rest_config_vm_params` | `PUT /api/vms/{id}/configparams` | `id`, `parameters`, `vm_password_profile?` |
| `getPowerState` | `rest_get_power_state` | `GET /api/vms/{id}/power` | `id`, `vm_password_profile?` |
| `changePowerState` | `rest_change_power_state` | `PUT /api/vms/{id}/power` | `id`, `operation`, `vm_password_profile?` |
| `getAllSharedFolders` | `rest_get_all_shared_folders` | `GET /api/vms/{id}/sharedfolders` | `id`, `vm_password_profile?` |
| `createSharedFolder` | `rest_create_shared_folder` | `POST /api/vms/{id}/sharedfolders` | `id`, `parameters`, `vm_password_profile?` |
| `deleteSharedFolder` | `rest_delete_shared_folder` | `DELETE /api/vms/{id}/sharedfolders/{folder id}` | `id`, `folder_id`, `vm_password_profile?` |
| `updataSharedFolder` | `rest_update_shared_folder` | `PUT /api/vms/{id}/sharedfolders/{folder id}` | `id`, `folder_id`, `parameters`, `vm_password_profile?` |
| `getAllNICDevices` | `rest_get_all_nic_devices` | `GET /api/vms/{id}/nic` | `id`, `vm_password_profile?` |
| `createNICDevice` | `rest_create_nic_device` | `POST /api/vms/{id}/nic` | `id`, `parameters`, `vm_password_profile?` |
| `deleteNICDevice` | `rest_delete_nic_device` | `DELETE /api/vms/{id}/nic/{index}` | `id`, `index`, `vm_password_profile?` |
| `updateNICDevice` | `rest_update_nic_device` | `PUT /api/vms/{id}/nic/{index}` | `id`, `index`, `parameters`, `vm_password_profile?` |
| `getIPAddress` | `rest_get_ip_address` | `GET /api/vms/{id}/ip` | `id`, `vm_password_profile?` |
| `getNicInfo` | `rest_get_nic_info` | `GET /api/vms/{id}/nicips` | `id`, `vm_password_profile?` |
| `createNetwork` | `rest_create_network` | `POST /api/vmnets` | `parameters` |
| `getAllNetworks` | `rest_get_all_networks` | `GET /api/vmnet` | (none) |
| `getPortforwards` | `rest_get_portforwards` | `GET /api/vmnet/{vmnet}/portforward` | `vmnet` |
| `getMACToIPs` | `rest_get_mac_to_ips` | `GET /api/vmnet/{vmnet}/mactoip` | `vmnet` |
| `updateMacToIP` | `rest_update_mac_to_ip` | `PUT /api/vmnet/{vmnet}/mactoip/{mac}` | `vmnet`, `mac`, `parameters` |
| `updatePortforward` | `rest_update_portforward` | `PUT /api/vmnet/{vmnet}/portforward/{protocol}/{port}` | `vmnet`, `protocol`, `port`, `parameters` |
| `deletePortforward` | `rest_delete_portforward` | `DELETE /api/vmnet/{vmnet}/portforward/{protocol}/{port}` | `vmnet`, `protocol`, `port` |

The vendor operation ID `updataSharedFolder` is exposed with the corrected tool name `rest_update_shared_folder`.

## Direct native VNC/RFB console (6)

All console tools accept `vm_id`: an absolute VMX path, a unique inventory name, a configured console profile alias, or a REST VM ID when REST is configured. The VM must be running with native VNC explicitly bound to loopback and a local password profile. VMware Tools and guest login are unnecessary. Setup: [console guide](console.md).

| Tool | Arguments |
| --- | --- |
| `console_screenshot` | `vm_id` |
| `console_click` | `vm_id`, `x`, `y`, `button` |
| `console_key` | `vm_id`, `key` |
| `console_type` | `vm_id`, `text` |
| `console_scroll` | `vm_id`, `direction`, `amount` |
| `console_status` | `vm_id` |

## Convenience tools (9) and capabilities

`workstation_status`, `list_vms`, `get_vm_details`, `vm_power`, `list_snapshots`, `create_snapshot`, `revert_snapshot`, `delete_snapshot`, and `get_guest_ip` provide short workflows over vmrun. `workstation_capabilities` reports installed coverage and tool mappings. Total: **138 MCP tools**.
