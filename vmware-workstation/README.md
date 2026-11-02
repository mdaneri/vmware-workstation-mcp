# VMware Workstation

Local Windows MCP plugin, version 0.2.0. It implements **all 47 commands in the installed vmrun 1.17.0.25688693 help and all 28 operations in the installed Workstation REST schema**. The bundled MCP server exposes 93 tools: the original 87 tools plus six [direct native VNC/RFB console tools](console.md). All original tool names, input schemas, and annotations remain unchanged.

Requires VMware Workstation with vmrun, Node.js 22.12+, and a desktop host with local stdio MCP support. REST tools additionally need a running, authenticated vmrest service. Guest OS commands need VMware Tools running and a guest OS account; console tools need neither and work before the OS boots. The plugin runs as your Windows user and opens no HTTP listener. Native VNC listeners are configured on the VM itself and restricted to localhost.

See [the full command and endpoint reference](reference.md) for the exact operation-to-tool mapping and argument names. `workstation_capabilities` compares the implemented catalog with the locally installed CLI; newer Workstation releases may add operations that require a plugin update. The REST schema was imported from the installed `swagger.zip/json/swagger_WS.json`, SHA-256 `71c8094a4ab765151111ac4fd68a2bf8ace1061d470ef4ac2c5dc6f86aebb3f7`. The installed vmrest reports version 1.3.1 build 25688693.

## What you can do

| Area | Implemented capabilities |
| --- | --- |
| Inventory and configuration | Registered/running VMs, selected local hardware details, REST VM settings, restrictions, registration, arbitrary supported config parameters |
| Power | Start, soft/hard stop/reset/suspend, pause/unpause, REST power state and operations |
| Snapshots | List flat/tree, create, revert, delete one or delete with children |
| Guest execution | Programs, scripts, interactive/active-window/no-wait modes, processes, termination, variables, keystrokes |
| Files and directories | Both transfer directions, existence checks, list/create/delete directories, delete/rename files, create temp files |
| Host integration | Shared-folder add/remove/enable/disable/access changes; device connect/disconnect; screenshots |
| Native console | Direct RFB screenshots, clicks, keys/chords, typing, scrolling and status; independent simultaneous VM sessions |
| VM lifecycle | Full/linked clones, snapshot-based clones, deletion, hardware upgrade, Tools installation/status, Photon VM download |
| Networking | Host networks, network creation, NAT port forwarding, DHCP MAC/IP bindings, VM NIC create/update/delete, guest address and NIC/IP-stack information |

This covers the installed vmrun and Workstation API interfaces. Blank VM creation also uses VMware Virtual Disk Manager to create a sparse disk. Other disk-manager operations and separate interfaces such as ESXi/vCenter, OVF Tool, and vmcli are outside this scope.

## Connect in Codex

From the source repository root:

```powershell
codex plugin marketplace add .
codex plugin add vmware-workstation@vmware-local
```

Open a local chat with the plugin enabled and ask: "List my VMware Workstation VMs." Verify the plugin's tools appear before relying on it. The repository build does not install or upload the plugin. Its portable `mcp.json` launches `node ${PLUGIN_ROOT}/server/server.cjs`; runtime npm installation is unnecessary. Follow the host's local plugin install flow for another compatible client.

For manual MCP configuration, replace the example with the extracted absolute path:

```json
{
  "mcpServers": {
    "vmware-workstation": {
      "command": "node",
      "args": ["C:/path/to/vmware-workstation/server/server.cjs"]
    }
  }
}
```

An account upload does not give web/mobile chats access to local VMware processes.

## Configure credentials locally

The plugin automatically reads `%APPDATA%\VMwareWorkstationPlugin\credentials.json`. Override this using `VMWARE_CREDENTIALS_FILE`. Credentials never belong in chat/tool arguments. Create or update profiles with PowerShell 7, using the packaged script from this directory:

```powershell
pwsh -NoProfile -File ./scripts/Set-Credentials.ps1 -GuestProfile default
pwsh -NoProfile -File ./scripts/Set-Credentials.ps1 -Rest
pwsh -NoProfile -File ./scripts/Set-Credentials.ps1 -VMPasswordProfile encrypted_lab
```

The script prompts for credentials, preserves other profiles, and restricts file access to your Windows account. The file contains plaintext JSON protected by Windows permissions. Its structure is shown below with placeholders only; the script is preferred to manually typing passwords into shell commands:

```json
{
  "rest": { "username": "api-user", "password": "<local password>" },
  "guest": {
    "default": { "username": "guest-user", "password": "<guest password>" },
    "windows_lab": { "username": "Administrator", "password": "<guest password>" }
  },
  "vm": {
    "encrypted_lab": { "password": "<VM encryption password>" }
  }
}
```

Select guest credentials using `guest_profile` (defaults to `default` for guest tools). Select an encrypted VM's password using optional `vm_password_profile`. Profiles can be reused across machines only when their accounts/passwords match. vmrun requires credentials in its process arguments; Windows process-inspection tools running with sufficient access may see them. The plugin redacts loaded credential passwords and Basic auth tokens from its tool output and errors. Guest application output and transferred files can contain other sensitive data and are not generally scrubbed.

Environment variables override file values: `VMWARE_REST_USERNAME`, `VMWARE_REST_PASSWORD`, `VMWARE_GUEST_<PROFILE>_USERNAME`, `VMWARE_GUEST_<PROFILE>_PASSWORD`, and `VMWARE_VM_<PROFILE>_PASSWORD`. Profile names contain letters, digits, and underscores and start with a letter; environment profile names are uppercase.

## Start the Workstation REST service

Configure VMware's own REST account interactively with the installed binary, then start the service in a terminal you control:

```powershell
& 'C:/Program Files/VMware/VMware Workstation/vmrest.exe' -C
& 'C:/Program Files/VMware/VMware Workstation/vmrest.exe' -p 8697
```

Set the same REST username/password in the plugin's local credentials file. The default endpoint is `http://127.0.0.1:8697`. `VMWARE_REST_URL` may specify another HTTP(S) origin, without path/query/credentials. Plain HTTP is accepted only for loopback; remote connections require HTTPS. TLS certificate validation stays enabled; use `NODE_EXTRA_CA_CERTS` when you need to trust a local CA. The plugin neither starts vmrest automatically nor replaces VMware's configured credentials.

REST VM IDs are separate from VMX paths: call `rest_get_all_vms` to obtain IDs, then use those IDs in REST tools. REST `createVM` clones an existing VM, as specified by VMware; it does not install a new guest OS from ISO. VMware controls the clone's destination placement. Some configuration changes require a stopped VM or elevated VMware permissions; the service's response is returned directly.

## Practical guest workflows

After configuring guest credentials, ask: "Run uname on my Linux lab and copy the output to my host." The corresponding tool arguments are shown below. Replace VMX and host paths with your actual paths; create the host transfer directory first.

Run a Linux guest script:

```json
{
  "tool": "vmrun_run_script_in_guest",
  "arguments": {
    "vmx": "C:/VMs/Linux/Linux.vmx",
    "guest_profile": "default",
    "interpreter": "/bin/sh",
    "script": "uname -a > /tmp/system-info.txt 2>&1"
  }
}
```

Copy the resulting file to Windows:

```json
{
  "tool": "vmrun_copy_file_from_guest_to_host",
  "arguments": {
    "vmx": "C:/VMs/Linux/Linux.vmx",
    "guest_path": "/tmp/system-info.txt",
    "host_path": "C:/VM-Transfers/system-info.txt"
  }
}
```

Use `vmrun_copy_file_from_host_to_guest` with `host_path` and `guest_path` to send a local file into the guest. Existing host files are protected unless `overwrite=true`; VMware may overwrite an existing guest destination. For Windows guests, use `vmrun_run_program_in_guest` with `program` such as `C:\Windows\System32\cmd.exe` and `arguments` such as `["/c", "ver > C:\Windows\Temp\version.txt 2>&1"]`, then copy that file back.

Guest execution returns vmrun's operation status. It does **not** capture guest stdout/stderr or establish the guest program's exit code. Redirect output in the guest and transfer the resulting file. Use `no_wait`, `interactive`, and `active_window` only when that behavior is needed.

To change VM memory via REST:

```json
{
  "tool": "rest_update_vm",
  "arguments": {
    "id": "<ID from rest_get_all_vms>",
    "parameters": { "processors": 4, "memory": 4096 }
  }
}
```

For a soft CLI shutdown use `vmrun_stop` with the selected `vmx` and `mode: "soft"`. For a full clone use `vmrun_clone` with `vmx`, a new `destination_vmx`, and `clone_type: "full"`. For a linked clone use `clone_type: "linked"` and optionally `snapshot` and `clone_name`.

## Create and modify a VM without a REST service

`create_vm` creates a new VMX and a growable SCSI VMDK in a new directory. It supports a guest OS identifier, RAM, CPUs, disk capacity, virtual hardware version, BIOS/EFI, network type/custom VMnet, and an optional boot ISO. Its parent directory must already exist. It never overwrites an existing directory, registers the VM, boots it, or installs an operating system.

```json
{
  "tool": "create_vm",
  "arguments": {
    "directory": "C:/VMs/new-linux-lab",
    "name": "Linux lab",
    "guest_os": "otherlinux-64",
    "memory_mb": 4096,
    "cpus": 2,
    "disk_gb": 40,
    "firmware": "efi",
    "network": "nat",
    "iso_path": "C:/ISOs/linux-installer.iso"
  }
}
```

Open the returned VMX in Workstation, or call `rest_register_vm` when REST is configured, then start it with `vmrun_start` to install the OS from the selected ISO. VMware guest OS identifiers and compatible virtual hardware versions are passed through; default hardware version 21 is compatible with Workstation 17 and this installed version.

Use `configure_vm` to edit an existing powered-off VM locally. The tool creates a uniquely named VMX backup, preserves comments and other settings, removes duplicate versions of changed keys, and saves the updated file. It rejects running, locked, detected suspended, and non-UTF-8 VMs. VMX values are strings; null removes a setting. Close/reopen the VM's Workstation tab if it cached the previous configuration.

```json
{
  "tool": "configure_vm",
  "arguments": {
    "vmx": "C:/VMs/new-linux-lab/machine.vmx",
    "settings": {
      "memsize": "8192",
      "numvcpus": "4",
      "ethernet0.connectionType": "hostonly"
    }
  }
}
```

VMX editing does not resize VMDKs or guest filesystems; use the corresponding VMware workflow for disk expansion. Arbitrary VMX settings still need to form a valid, compatible VMware configuration. The tool detects concurrent writes before replacement, but cannot exclude another VMware process starting at the same time.

## Scope and operation behavior

| Variable | Meaning |
| --- | --- |
| `VMRUN_PATH` | Absolute vmrun.exe path; default discovery checks Program Files and PATH |
| `VMWARE_VDISKMANAGER_PATH` | Optional absolute disk-manager path for blank VM creation; otherwise beside vmrun |
| `VMWARE_INVENTORY_PATH` | Override inventory.vmls location |
| `VMWARE_ALLOWED_ROOTS` | Semicolon-separated absolute directories for VMX targets and CLI clone/template destinations |
| `VMWARE_ALLOWED_HOST_ROOTS` | Semicolon-separated directories for file transfer, screenshot, and shared-folder host paths |
| `VMWARE_CREDENTIALS_FILE` | Optional absolute credentials JSON path |
| `VMWARE_REST_URL` | REST origin; default http://127.0.0.1:8697 |

Without configured roots, explicitly selected accessible paths are permitted. With roots configured, the plugin checks real paths to avoid directory-link escapes; REST VM IDs are resolved to VMX paths before VM operations. Inventory still lists paths outside allowed roots. REST clone destination placement is controlled by VMware. Root checks scope direct path operations; they are not an OS sandbox and do not restrict what an authorized guest program, shared folder, or arbitrary VM configuration can do.

Each low-level tool accepts `timeout_seconds` from 1 to 3600 (default 120); output is limited to 1 MiB. CLI invocations are serialized within this process, and REST workflows are serialized separately. Other VMware processes can act concurrently. A failed/timed-out mutation can have taken effect; inspect state before retrying. Soft shutdown never falls back to hard automatically. Destructive changes require the user's authorization for the exact target and action.

Inventory combines Workstation's inventory file and `vmrun list`, not a disk scan. A non-running VM may be powered off, suspended, or unavailable. Power-command success does not prove service readiness. The convenience snapshot revert/delete tools reject duplicate snapshot names; low-level CLI tools retain VMware's snapshot naming/path semantics, so inspect the tree to choose the exact target.
