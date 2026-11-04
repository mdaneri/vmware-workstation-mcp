# Missing tools and catalog diagnostics

The installed package, a running MCP server, its raw `tools/list`, and the
assistant-visible tool catalog are separate observations. A plugin refresh or
version in `plugin.json` alone does not establish which process a chat uses or
which tools the client exposes. Version 0.16.0 registers **153 tools**.

## Check the active chat

Call the read-only `plugin_catalog` tool with `{}`. It returns the running
server's version, a per-process `instance_id`, `tool_count`, sorted `tool_names`,
and `tool_names_sha256`. The hash covers the UTF-8 JSON array of sorted,
unprefixed names; it is not a schema or executable hash. Neither VMware nor
credentials are accessed. This tool cannot see the client catalog itself.

To compare the complete names visible to the assistant, strip only the VMware
namespace prefix and pass them as `observed_tools`:

```json
{
  "tool": "plugin_catalog",
  "arguments": {
    "observed_tools": ["get_guest_ip", "list_vms", "plugin_catalog"]
  }
}
```

That example deliberately supplies only three names. The result lists
`missing_from_observed` and `unknown_to_server`, plus `matches` and
`alphabetical_prefix_only`. Omit `observed_tools` when no complete chat inventory
is available; an empty array means an explicitly observed empty inventory.
Duplicates are ignored. A matching name inventory does not establish matching
schemas or successful VMware operations.

## Use an operation whose direct tool is missing

Version 0.16.0 adds `plugin_query` and `plugin_mutate` alongside discovery. All
three names sort before the observed cutoff. The 150 original operation names
remain registered. The bridges accept only those registered operations, validate
their original strict schemas and call the same handlers in the same server.
They accept no executable, CLI command, arbitrary tool or unrestricted script
operation. Existing guest execution remains an explicit original operation with
its existing credential and confirmation requirements.

First discover the exact schema and annotations:

```json
{ "tool": "plugin_catalog", "arguments": { "tool": "vmrun_get_guest_ip_address" } }
```

The returned `selected_tool` contains `inputSchema`, `annotations`, and `bridge`.
Use that route with the original arguments:

```json
{
  "tool": "plugin_query",
  "arguments": {
    "tool": "vmrun_get_guest_ip_address",
    "arguments": { "vmx": "<owned-vmx>", "wait": true, "timeout_seconds": 60 }
  }
}
```

This makes the original bounded native IP query callable even when its direct
name is absent. The same discovery/query flow covers `vm_get_recent_errors`,
`vm_hardware_capabilities`, readiness, serial reads, templates and every other
original read-only operation. Each operation retains its own target, deadline,
credential and session requirements. Query success is not proof of guest readiness.

Changes use `plugin_mutate` with an additional outer `confirm: true` only after
authorization for the exact target/effects. All original confirmation fields
remain inside `arguments`; neither confirmation replaces the other. For example,
after authorization for a typed offline hardware patch:

```json
{
  "tool": "plugin_mutate",
  "arguments": {
    "tool": "vm_hardware_set",
    "confirm": true,
    "arguments": { "vmx": "<owned-vmx>", "confirm": true, "memory_mb": 4096 }
  }
}
```

Discover the original schema first and use its fields; the example does not
authorize a live VM edit. The read-only bridge rejects all mutations. The change
bridge retains offline checks, allowlists, credential profiles, shared resource
locks and original capability refusals. Both preserve MCP errors/images and
cancellation context and never retry a failed operation automatically.

Client tool policies apply separately to these three new tools. Do not use a
bridge to evade an intentionally disabled operation. Administrators restricting
individual operation names should also restrict the corresponding bridge; a
bridge is an explicitly broader entry point to its advertised operation set.
Its annotations are conservative: queries are read-only but may observe network
services or consume serial data; changes are destructive, non-idempotent and
require authorization. This fixes operation access through a small discoverable
surface; it does not claim to repair the client's missing direct names.

## Check an installed package independently

If `plugin_catalog` is also missing, run the packaged diagnostic with Node.js:

```powershell
node "<plugin-root>/server/inspect-catalog.cjs"
```

On Linux the command is the same with a native local path. The diagnostic can
also inspect an older package by accepting its root as one argument:

```powershell
node "<new-plugin-root>/server/inspect-catalog.cjs" "<installed-plugin-root>"
```

It opens a **fresh independent stdio connection** to that root's bundled server,
initializes MCP and lists every page. It prints installed and server versions,
the bundle SHA-256, tool count and names. It calls no VMware tools, reads no
credentials, and performs no VM, service or power operations. This checks that
package's registration; it does not inspect the desktop's existing connection.
No `npm install` is required for the packaged diagnostic.

## Interpret and reconnect

| Observation | Next step |
| --- | --- |
| Raw listing is incomplete or server initialization fails | Check the selected package root, Node.js, bundle and installation. Preserve the reported versions/hash and missing names. |
| Active `plugin_catalog` version differs from the installed package | The chat uses a different version. Reconnect/restart, then compare again. A changed `instance_id` proves another process, not a complete client catalog. |
| Raw listing is complete but the chat exposes fewer names | Check client tool policies and retain both inventories for a client exposure report. This alone does not distinguish filtering, caching and client truncation. |
| A fresh local chat is complete while the existing chat is partial | Record both observations; the existing connection/catalog lifecycle needs investigation. |
| Both catalogs match but an IP call fails | Investigate the selected guest's Tools/IP publication separately; catalog completeness does not establish guest readiness. |

Check `enabled_tools`/`disabled_tools` for both direct MCP configuration and
plugin-specific MCP policy in the user/project configuration. Do not remove
intentional policy restrictions. Official [MCP configuration guidance](https://developers.openai.com/codex/mcp)
documents these filters and plugin policy overrides.

Reconnect the plugin using the client controls. If the mismatch remains,
restart the desktop app and check a fresh local chat with this plugin enabled.
Compare the expected tool names and the running version again; do not treat
refresh completion alone as proof. Never replay creation, power, console input,
or another mutation to check a connection. Do not use raw vmrun, guest execution,
GUI automation or unrestricted command tools to bypass missing typed tools.

## Bounded IP lookup

Since 0.16.0, the convenience tool also accepts the native bounded wait:

```json
{
  "tool": "get_guest_ip",
  "arguments": { "vmx": "<owned-vmx>", "wait": true, "timeout_seconds": 60 }
}
```

The default remains a single non-waiting lookup with a 120-second bound. The
timeout accepts integers 1–3600 and includes queueing and the later Tools
cross-check, which has at most five seconds within the remaining deadline.
Cancellation or an expired deadline prevents that cross-check from launching.
Allow the MCP client a timeout longer than this bound. This makes one native
`getGuestIPAddress` call with `-wait`; it never powers a VM or retries a mutation.
The original `vmrun_get_guest_ip_address` remains registered with its existing
schema. If the chat still has the old `get_guest_ip` schema, reconnect before
using the new arguments. Lookup errors include the running catalog identity.

## Issue #36 evidence and wider impact

On 2026-11-04, an independent MCP connection to the installed **0.15.0** bundle
returned **150 unique tools in one response**, with no `nextCursor`. Its SHA-256
was `048c41f5246768229591b239654768570900a9e5daf4e9b8633d234838e60d98`,
matching the artifact reported in [issue #36](https://github.com/mdaneri/vmware-workstation-mcp/issues/36).
The active development chat exposed **74 names**, exactly the first 74 sorted
server names, ending at `rest_update_nic_device`.

The remaining **76** names affect the whole catalog:

| Area | Missing count | Names or scope |
| --- | ---: | --- |
| vmrun | 47 | Every `vmrun_*` tool, including IP/Tools queries, guest files, clones, power and host networking |
| Serial | 6 | All `serial_*` tools |
| Readiness and diagnostics | 5 | `vm_wait_for_boot`, `vm_wait_for_ip`, `vm_wait_for_service`, `vm_get_recent_errors`, `vm_collect_diagnostics` |
| Templates | 4 | All `template_*` tools |
| Typed hardware | 3 | All `vm_hardware_*` tools |
| REST | 3 | `rest_update_portforward`, `rest_update_shared_folder`, `rest_update_vm` |
| Boot | 2 | `vm_boot_status`, `vm_boot_configure` |
| Security inspection | 2 | `vm_security_capabilities`, `vm_security_status` |
| Workstation discovery | 2 | `workstation_status`, `workstation_capabilities` |
| Convenience operations | 2 | `vm_power`, `revert_snapshot` |

Console, disk, LAN, lab, job and OVF names were fully exposed. ISO list/mount/eject
were exposed, while boot helpers were missing. Snapshot list/create/delete were
exposed while revert was missing. These are name-exposure observations, not
live functionality tests. The server advertised no MCP resource or prompt
catalogs. No VMware tool was invoked during this audit.

An independent fresh Codex 0.149.1 app-server connection also returned all 150
installed 0.15.0 tools through `mcpServerStatus/list`, including every missing
family. This narrows the observed discrepancy to exposure after MCP registration
and Codex catalog acquisition; it does not prove the precise client cutoff cause.

The supported CLI marketplace registration/install flow was then exercised in an
isolated Codex profile with 0.16.0. Fresh app-server initialization and
`config/mcpServer/reload` followed by `mcpServerStatus/list` both returned all
153 tools, including the three discovery/bridge names. Bundled MCP tests called
the original bounded native IP query through `plugin_query` using a fake native
runner, and checked strict arguments, failure propagation and secret redaction.
No model turn or live VMware operation was needed for these checks. This is
Codex installation/reload and MCP call evidence, not a claim that the existing
desktop chat's direct-name catalog has expanded.

The installed package had no MCP allowlist and the inspected user configuration
had no VMware tool filter. Other client/managed policy and the exact truncation
cause remain unproven. Automated tests verify complete raw catalogs on new
connections, unchanged prior contracts except the optional IP fields/prose,
read-only diagnostics, and calls through both validated bridges with a simulated
74-name assistant cutoff. Direct-name desktop exposure after refresh remains a
client limitation; the new routes make the original operations accessible when
discovery and the appropriate bridge are exposed.
