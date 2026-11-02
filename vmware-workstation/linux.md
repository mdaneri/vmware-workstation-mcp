# Linux host setup

Version 0.3.0 supports Linux and Windows hosts. Use native Linux Node.js **22.12+**, VMware Workstation for Linux, and **PowerShell 7 (`pwsh`)** for the existing setup helpers and package validation. Run the server as the VM owner. There is no X11/Wayland or host desktop capture/input dependency.

## Paths and connection

The plugin finds `vmrun` on PATH or in `/usr/bin`, `/usr/local/bin`, and `/usr/lib/vmware/bin`. VM creation finds `vmware-vdiskmanager` beside vmrun, on PATH, or in those same directories. Optional overrides, adjusted to your actual installation:

```bash
export VMRUN_PATH=/usr/bin/vmrun
export VMWARE_VDISKMANAGER_PATH=/usr/bin/vmware-vdiskmanager
export VMWARE_ALLOWED_ROOTS="$HOME/vmware:$HOME/lab-vms"
export VMWARE_ALLOWED_HOST_ROOTS="$HOME/vm-transfers"
```

Allowed roots must exist and use **colons on Linux**, semicolons on Windows. Host paths are absolute and case-sensitive. Guest paths always follow the guest OS. Inventory defaults to `~/.vmware/inventory.vmls` ([VMware inventory location](https://knowledge.broadcom.com/external/article?legacyId=57224)); `VMWARE_INVENTORY_PATH` overrides it. VMware launcher symlinks retain their original invocation names.

Manual MCP configuration, with your extracted absolute path:

```json
{
  "mcpServers": {
    "vmware-workstation": {
      "command": "node",
      "args": ["/home/user/plugins/vmware-workstation/server/server.cjs"]
    }
  }
}
```

Pass environment settings to the MCP process; desktop applications may not inherit shell startup files. Tool names and argument schemas are unchanged. `workstation_capabilities` compares the catalog with the installed CLI: vendor versions/platforms may expose different commands. A registered tool does not prove the local build supports it.

## Credentials and guest operations

Linux credentials default to `${XDG_CONFIG_HOME:-$HOME/.config}/vmware-workstation-mcp/credentials.json`; relative `XDG_CONFIG_HOME` values are ignored. `VMWARE_CREDENTIALS_FILE` overrides the filename. Files must be regular, owned by your account, **mode 600**, with no symlink or extra hard links. Newly created configuration directories have mode 700. The JSON structure and environment overrides match Windows.

Run from the extracted plugin directory:

```powershell
pwsh -NoProfile -File ./scripts/Set-Credentials.ps1 -GuestProfile default
pwsh -NoProfile -File ./scripts/Set-Credentials.ps1 -Rest
pwsh -NoProfile -File ./scripts/Set-Credentials.ps1 -VMPasswordProfile encrypted_lab
```

The helpers prompt locally, preserve other profiles, and protect files before writing secrets. Linux passes locally prompted secrets to the bundled writer over stdin, never argv. A Node-only interactive alternative is `node server/set-credentials.cjs --kind guest --profile default`. Manually migrated files need correct ownership and `chmod 600 /absolute/path/credentials.json` before use.

Guest execution and file transfers use the existing tools and profiles. A Linux guest uses paths such as `/usr/bin/printf` and `/tmp/output.txt`; a Windows guest still uses Windows guest paths. VMware Tools and guest credentials are required. See the [practical guide](README.md) for runnable workflows. vmrun itself receives guest/encryption credentials in process arguments on both hosts; privileged process inspection can see them.

Configure/start the installed Linux REST service interactively with `vmrest -C`, then `vmrest -p 8697`, and save matching REST credentials locally. The default is `http://127.0.0.1:8697`; remote REST requires HTTPS.

## Direct consoles

Fully power off the selected VM and choose a unique port:

```powershell
pwsh -NoProfile -File ./scripts/Set-Credentials.ps1 -ConsoleProfile lab -VMX /home/user/vmware/Lab/machine.vmx
pwsh -NoProfile -File ./scripts/Configure-Console.ps1 -VMX /home/user/vmware/Lab/machine.vmx -Port 5901 -Profile lab
```

VM validation, stopped/locked/suspended checks and backups are shared with Windows. Linux VMX replacements/backups containing VNC secrets receive mode 600 before secrets are written. Ordinary edits retain existing VMX permissions. Start with `vmrun_start`, `mode: "nogui"`, then call `console_status` or `console_screenshot` with `vm_id: "lab"`. See the [console guide](console.md).

Linux verification reads `/proc/net/tcp`, `/proc/net/tcp6` and the socket owner's `/proc/<pid>/fd`, `exe`, and NUL-separated `cmdline`. It requires loopback-only listeners, a `vmware-vmx` executable and the exact VMX argv token for every owner at the selected address. Unreadable or unrelated owners are refused. Run as the VM owner in the same PID/network namespace; restricted `/proc` mounts or containers may prevent verification. No privilege escalation, host desktop fallback, or external-port fallback occurs.

## WSL and validation limits

WSL2 can run the Linux runtime, PowerShell helpers, tests and package build. Use native Linux Node/npm and a separate Linux checkout to keep platform-specific `node_modules` independent of Windows:

```bash
npm ci
npm run build
npm test
npm run package
```

Linux integration tests launch the bundled MCP server and real child processes, execute guest-command/temporary-file transfers through a vmrun test double, and exercise all six console tools against two authenticated RFB worker test doubles. Production `/proc` inspection runs unmodified. Worker executables are private copies of Node named `vmware-vmx`, explicitly **not VMware hypervisors**. Tests need no display server or host focus/input access. CI tests Windows and Ubuntu without real VMs.

WSL tests do not establish that Workstation can run VMs inside WSL. This port targets VMware on the **same native Linux host** as the MCP server. It does not bridge Linux paths/process metadata to Windows Workstation, and a Windows `.exe` in `VMRUN_PATH` is unsupported. Use the Windows server for Windows-hosted VMs.

Real BIOS/UEFI console validation was previously performed on Windows Workstation 26.0.1. A native Linux VMware installation is still needed to validate real Linux VM creation, firmware consoles, guest operations and REST end to end.
