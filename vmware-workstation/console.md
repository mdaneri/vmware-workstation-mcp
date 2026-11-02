# Direct native VM console

Version 0.2.0 adds direct, headless VNC/RFB access to VMware Workstation's per-VM display. The console is the hypervisor framebuffer: BIOS/UEFI, PXE and installer screens use the same path as the installed OS. No guest IP address, VMware Tools, guest account, host screenshots, host mouse/keyboard injection, or window activation is used.

Windows listener inspection and the packaged setup helpers require PowerShell 7 (`pwsh`) on PATH. Version 0.3.0 adds [Linux setup](linux.md), native executable discovery, user-only file permissions and `/proc` listener inspection. The Node runtime minimum is 22.12. After installing/reinstalling the local package through the existing marketplace flow, open a fresh local chat or reload the plugin. Edit the source package rather than the installed cache.

## Installed-version verification

On 2026-11-02, Workstation **26.0.1 build 25688693** accepted per-VM `RemoteDisplay.vnc.*` settings, negotiated **RFB 3.8 with VNC password authentication**, and listened on **127.0.0.1**. Live MCP tests connected to BIOS and UEFI VMs simultaneously and verified firmware screens changed after RFB keys while a non-VMware Windows app stayed foreground. A read-only foreground observer recorded 142 samples, all showing ChatGPT. Both test VMs were stopped and VNC disabled afterward. No installation ISO was supplied: actual PXE/network boot or a full OS installation was not exercised in that run.

## One-time setup for each VM

Fully power off the selected VM first. Use a unique VNC port per VM. The examples below are run from the extracted plugin directory, and `C:/VMs/Lab/machine.vmx` must be replaced with the actual path.

1. Store a dedicated native VNC password using the existing local credential mechanism:

```powershell
pwsh -NoProfile -File ./scripts/Set-Credentials.ps1 -ConsoleProfile lab -VMX 'C:/VMs/Lab/machine.vmx'
```

The script prompts without echoing the password. VMware's classic VNC authentication uses only eight bytes, so this setup accepts **1–8 ASCII characters** and rejects longer passwords instead of silently truncating them. Use a dedicated random eight-character password, never a system/account password. The profile is saved alongside guest/REST credentials in the user-only `%APPDATA%/VMwareWorkstationPlugin/credentials.json`, or `VMWARE_CREDENTIALS_FILE` when specified. Do not paste it into chat or MCP arguments.

2. Configure native VNC offline using that profile:

```powershell
pwsh -NoProfile -File ./scripts/Configure-Console.ps1 -VMX 'C:/VMs/Lab/machine.vmx' -Port 5901 -Profile lab
```

This reuses the existing VMX validation, stopped/locked/suspended checks, backup, and error handling. It sets `RemoteDisplay.vnc.enabled = "TRUE"`, `RemoteDisplay.vnc.ip = "127.0.0.1"`, and the selected port, and reads the password locally. VMware requires VNC authentication material in the VMX as well. The setup protects the VMX and backup with the same current-user-only Windows ACL policy as the credential store, **before** writing sensitive contents. Subsequent VMX edits through the plugin preserve this protection for VNC secrets. Native VMware files/backups contain VNC authentication material; do not share them.

3. Start the VM headlessly using the existing `vmrun_start` tool with its exact VMX path and `mode: "nogui"`, then call `console_status` with `vm_id: "lab"`.

VNC is a separate console credential, unrelated to the guest account or encrypted-VM password. The same password must be configured on both sides; changes take effect on the native listener after a complete VM power cycle. Setup never starts/stops the VM for you. It refuses running/suspended/locked VMs. If port configuration fails, no firewall rule or external listener is created by the plugin.

## VM identification and credentials

`vm_id` accepts an absolute VMX path, a unique Workstation inventory name, a console profile alias (such as `lab`), or an existing REST VM ID when REST is configured. VMX paths still go through `VMWARE_ALLOWED_ROOTS` checks. Names must be unambiguous. An unregistered VM can always be addressed by its VMX path or a configured alias.

Console profiles use the existing credential JSON structure, extended with:

```json
{
  "console": {
    "lab": {
      "vmx": "C:/VMs/Lab/machine.vmx",
      "password": "<configured locally>"
    }
  }
}
```

An environment variable `VMWARE_CONSOLE_LAB_PASSWORD` overrides the profile's password; `VMWARE_CONSOLE_DEFAULT_PASSWORD` can serve a VM with no mapped profile. Profile names use the existing letters/digits/underscore rules. Ports and bind addresses come from the VMX, not arbitrary tool-supplied endpoints. Credentials, authentication responses and Basic tokens are never returned by these tools.

## Tools and examples

| Tool | Arguments | Result |
| --- | --- | --- |
| `console_screenshot` | `vm_id` | Fresh PNG as an MCP image block, plus framebuffer dimensions/time |
| `console_click` | `vm_id`, `x`, `y`, `button` | RFB press/release; button is left, middle or right |
| `console_key` | `vm_id`, `key` | RFB key/chord press/release, including modifier cleanup |
| `console_type` | `vm_id`, `text` | RFB keyboard events; max 4096 characters, no clipboard |
| `console_scroll` | `vm_id`, `direction`, `amount` | RFB wheel ticks; up/down/left/right, 1–100 ticks |
| `console_status` | `vm_id` | Authenticated connection/configuration status, or a redacted setup reason |

For example, ask: "Show the console of lab, enter its firmware setup, and show the result." The model can call:

```json
{"name":"console_screenshot","arguments":{"vm_id":"lab"}}
{"name":"console_key","arguments":{"vm_id":"lab","key":"F2"}}
{"name":"console_screenshot","arguments":{"vm_id":"lab"}}
```

Other key names include Enter, Escape, Tab, Space, BackSpace, Home, End, PageUp/PageDown, ArrowUp/Down/Left/Right, and F1–F12. Chords include `Ctrl+Alt+Delete`, `Shift+F10`, and `Ctrl+Plus`. Typing preserves text as RFB key events; uppercase ASCII and US punctuation include Shift, and newline/Tab/BackSpace are keys. Unicode is transmitted as X11 Unicode keysyms, but VMware's VNC keymap and the guest keyboard layout determine which characters render; full Unicode text entry is not guaranteed during firmware or installation. No host clipboard is read or modified.

Clicks use **VM framebuffer coordinates**, validated against the current dimensions. After an OS/installer resolution change, request another screenshot before selecting coordinates. Scrolling uses the last console pointer position or screen center. Input tool success means events were sent; take another screenshot to verify guest behavior. Inputs are never automatically replayed after a disconnect.

## Connection and security behavior

Connections are lazy and password-authenticated: no VNC `None` authentication fallback. VMX bind settings and native listener metadata must show loopback-only binding. The listener must belong to a VMware VM worker. Linux requires readable `/proc` executable/socket metadata and an exact VMX argv token. When Windows exposes its command line, it must name the VMX; otherwise the running VM inventory and per-VM port must uniquely identify the target, followed by password authentication. External/wildcard listeners, port/VM mismatches, unreadable/ambiguous running inventory, and authentication failures are refused. A misconfigured native listener must be fixed while the VM is off; console tools never create a firewall exception or silently rebind a running listener.

Each VM has an independent TCP/RFB session and framebuffer. Operations serialize within a VM so chords/clicks do not interleave, while different VMs can run concurrently. Defaults: eight sessions, five-minute idle expiry, ten-second handshake/frame timeouts, 16 megapixel frame limit, and 10 MiB PNG output limit. Stale/disconnected sessions are re-created on the next call. Read calls may reconnect, but failed inputs are never replayed. Sockets close when the MCP process ends.

Classic VNC does not encrypt the console stream. This implementation deliberately confines it to localhost and requires authentication; do not expose it by firewall forwarding or by changing the listener to 0.0.0.0. Windows administrators or another process already running as your account can access local secrets/console data. These controls are not an OS security boundary against an already-compromised host.

## Integration tests

`npm test` includes real RFB TCP client/server tests (3.3, 3.7, 3.8), authenticated multi-VM screenshot/input, fresh frames, resolution changes, modifiers, invalid coordinates, denied wildcard/cross-VM ports, authentication refusal, connection limits, and legacy behavior.

`npm run test:console:live` is opt-in: it creates **two new isolated VMs** with small sparse disks under ignored `test-vms/`, configures user-protected temporary credentials, starts them with `nogui`, and exercises the six MCP tools against real VMware BIOS/UEFI consoles. It requires a non-VMware app in the foreground and fails if VMware becomes foreground. The observer only reads `GetForegroundWindow`/process IDs; it never captures a host screen, injects input, or activates a window. It saves VM-only PNGs and `evidence.json`, stops its test VMs, disables their VNC listeners, and deletes the temporary credential file. It does not modify existing user VMs. Run only with authorization for this live test workload.
