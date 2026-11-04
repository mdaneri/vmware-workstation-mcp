# Use VMware Workstation with Claude

This independent community plugin runs VMware Workstation locally as your user through stdio. It opens no new network listener and does not include VMware binaries, VMs, credentials, or installation media. Windows and native Linux are supported; macOS cannot host VMware Workstation. Claude Desktop on Linux is beta, and native Linux VMware/client validation is not claimed.

## Claude Code

Install Node.js 22.12+ and native VMware Workstation first. Then run:

```powershell
claude plugin marketplace add mdaneri/vmware-workstation-mcp
claude plugin install vmware-workstation@vmware-local
claude plugin list
```

The repository includes the built server, so no clone, `npm ci`, or build is required. Restart Claude Code or start a fresh session with the plugin enabled. Ask: **List my registered and running VMware Workstation VMs. Do not change anything.** No REST or guest credentials are needed for inventory.

For development, validate the repository and install its marketplace from your checkout:

```powershell
claude plugin validate --strict .
claude plugin validate --strict ./vmware-workstation
claude plugin marketplace add .
claude plugin install vmware-workstation@vmware-local
```

Use `claude plugin marketplace update vmware-local` followed by `claude plugin update vmware-workstation@vmware-local`, then restart the client. Remove the plugin with `claude plugin uninstall vmware-workstation@vmware-local`. Remove its marketplace with `claude plugin marketplace remove vmware-local` when no longer needed. Client commands may be restricted by organization policy.

The Claude registration uses `${CLAUDE_PLUGIN_ROOT}/server/server.cjs`. Its skill, documentation and executable stay inside the plugin root and work when the client caches it in a path containing spaces. It does not depend on the working directory of your project. Claude Code inherits configured environment variables from its launching process; see [all configuration variables](README.md#scope-and-operation-behavior).

## Claude Desktop

1. Install [Claude Desktop from Anthropic](https://claude.com/download) and native VMware Workstation.
2. Download `vmware-workstation-0.17.0.mcpb` from the corresponding [GitHub Release](https://github.com/mdaneri/vmware-workstation-mcp/releases). Compare its SHA-256 with the release's `SHA256SUMS.txt` file if desired.
3. Open Settings > Desktop app > Extensions > Manage (or Settings > Extensions in older versions), then Advanced settings > **Install Extension…**. Select the MCPB and follow the prompts.
4. Leave all optional settings blank for ordinary current-user inventory. Enable the extension, start a fresh chat, and use the inventory prompt above.

Claude Desktop supplies the Node runtime for Node extensions; this extension requires Node 22.12 or newer. You do not need npm dependencies or edits to `claude_desktop_config.json`. A desktop runtime below the declared minimum must be updated before use. PowerShell 7 is still required on Windows for credential/console setup helpers and operations that protect sensitive files. Linux needs a native VMware installation; WSL is not a replacement hypervisor host.

The extension settings offer optional file pickers for the private credentials file, vmrun, virtual disk manager, OVF Tool, vmcli, VMware worker, inventory and preferences. Allowed VM directories and allowed host directories are text fields: separate absolute roots with `;` on Windows or `:` on Linux. Paths containing spaces require no extra quotes. The REST field accepts an HTTP(S) origin without credentials, paths, query or fragment; plain HTTP is limited to loopback. Blank settings preserve inherited values and the server's existing defaults. Explicit nonblank settings override the corresponding inherited variable. Invalid settings fail startup without printing their values.

Passwords stay in the [existing per-user credentials JSON and profiles](README.md#configure-credentials-locally); do not paste them into chat or extension settings. Default Windows location: `%APPDATA%\VMwareWorkstationPlugin\credentials.json`. Default Linux location: `$XDG_CONFIG_HOME/vmware-workstation-mcp/credentials.json`, or `~/.config/vmware-workstation-mcp/credentials.json`. Use the bundled `server/set-credentials.cjs` or credential setup scripts described in the configuration guide to create/protect it. A desktop app may not inherit your shell environment, so use the extension settings for path overrides.

REST operations additionally require the separately configured vmrest service and local REST credentials. Guest operations need guest credentials and VMware Tools. [VNC console operations](console.md) require explicit per-VM setup with authenticated loopback listeners; installing the extension does not configure or enable a VM console.

To update, download the newer versioned MCPB and install it through the same flow, then reconnect/start a fresh chat and verify its reported version. To disable or uninstall, use the extension's controls in Settings. Uninstalling a client package does not delete your VMs, private credential profiles, or durable job records. It does not stop jobs running in another client.

## Discovery and side-by-side use

All clients use the same bundled server and 156 tools. Ask Claude to call `plugin_catalog` and report its version and tool count. If a client exposes only part of the catalog, use `a_vmware_catalog` (registered early) or `plugin_catalog` with the exact documented tool name, then `a_vmware_query`/`plugin_query` for read-only operations or `a_vmware_mutate`/`plugin_mutate` for authorized changes. Existing argument validation and confirmation remain mandatory. Never route around intentional client restrictions. See [catalog diagnostics](catalog.md).

Raw MCP discovery and assistant-visible tools are separate measurements; a complete server catalog does not prove every tool appears in a model's tool list. Report the actual visible names when diagnosing truncation.

Codex, Claude Code and Claude Desktop have independent installation caches, settings and server processes. They can use the same intentionally selected local credentials file, but updating one client does not update another. Reservations and locks are process-local: do not perform concurrent changes to the same VM/disk from different clients. Use a single client for a mutation workflow.

## Troubleshooting and validation

If startup fails, check the extension logs, Node runtime requirement, native VMware installation and optional paths. For inventory failures, confirm the inventory belongs to the same local user. Check configured roots before path operations; roots do not filter inventory and are not an OS sandbox. Missing REST/guest/VNC prerequisites should affect those operations rather than basic inventory. Organization policies may prohibit local extensions; do not bypass them.

From an installed package directory, `node server/inspect-catalog.cjs` starts a fresh stdio connection and checks the complete raw catalog without calling VMware. It does not verify the live client connection. See the [validation record](https://github.com/mdaneri/vmware-workstation-mcp/blob/main/docs/claude-validation.md) in the source repository for actual native client results and remaining acceptance checks.

References: [Claude Code marketplace](https://code.claude.com/docs/en/plugin-marketplaces), [plugin manifests](https://code.claude.com/docs/en/plugins-reference), [MCPB specification](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md), [Desktop extension installation](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).
