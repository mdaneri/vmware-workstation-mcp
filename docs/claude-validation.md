# Claude distribution validation

## Results on 2026-11-04

The v0.17.0 implementation is based on upstream v0.16.1 (`27cfe0d`). It retains the same 156 tool definitions, annotations and registration order, including the early catalog/bridge aliases. All versions come from the root `package.json`.

| Check | Result |
| --- | --- |
| Windows automated regression suite | 295 tests: 286 passed, 9 platform skips, 0 failures |
| Original portable manifests, prior tool contracts and credential-file protection | Passed |
| Claude Code 2.1.318 strict marketplace/plugin validation | Passed |
| MCPB 2.1.2 manifest schema, staged asset validation and packing | Passed; its PNG validator emits a generic size recommendation even for the included 512×512 icon |
| ZIP/MCPB exact archive allowlists and identical shared server bytes | Passed |
| Extracted ZIP and MCPB startup from paths with spaces and unrelated working directories, with no development dependencies | Both passed |
| Extracted full tool descriptors/order, catalog identity, read-only bridge behavior and diagnostic helper | Both passed; 156 tools and version 0.17.0 |
| Optional Desktop settings | Blank/inherited/explicit precedence, Windows/Linux root lists, invalid settings and redacted startup rejection passed |
| Native Claude Code local marketplace installation | Passed; installed/enabled version 0.17.0 |
| Native Claude Code catalog and inventory in a fresh session | Passed; catalog returned 0.17.0/156 tools and inventory returned 34 entries |
| Assistant-visible Claude Code tool count | Assistant reported 156 before calling the catalog; this is its report, separate from raw discovery |
| Native Claude Desktop extension installation/managed runtime | Pending; user requested CLI-only native validation |
| Native Linux VMware/Claude installation | Not exercised locally; automated portability checks run in Ubuntu CI |

The native CLI session used default permission mode, disabled built-in tools, permitted only the VMware catalog/inventory names, and denied unapproved permission prompts. Its local transcript contains successful `plugin_catalog` and `list_vms` results with no mutation tool calls. Tool names SHA-256: `414f04e224b0df54e742f38e3f45852fde249c9c36cfc91b90ff84b100473921`. Machine-specific VM names, paths, credentials and transcripts are not published.

## Reproduce the automated checks

```powershell
npm ci
npm run build
npm test
npm run package
npm run test:packages
git diff --exit-code -- vmware-workstation packaging
```

Windows/Ubuntu CI builds and validates both distributions. Manifest/tool registration tests do not require VMware or change real VMs. Exact archive allowlists exclude VMs, credentials, environment files, development dependencies and local test evidence. Each packaged shared server must match the canonical built server byte-for-byte. `npm audit --omit=dev` reports no runtime advisories; the official MCPB development tool currently brings upstream legacy-Zod and temporary-file dependency advisories. Those build dependencies are not shipped in either artifact.

## Native acceptance still required before claiming complete issue closure

- After the change is merged/published, install the default GitHub marketplace using the two commands in the [Claude guide](../vmware-workstation/claude-installation.md), then check the installed and running versions. A local-directory install does not prove the default published repository contains the change.
- In Claude Desktop, use **Install Extension…** with the release MCPB, leave optional settings blank, and verify startup using the managed runtime, `plugin_catalog` version/tool count and read-only VM inventory. Repeat with an explicit local path override. This step remains pending and is not implied by automated stdio tests.
- Record native Linux results separately when a supported Linux Desktop/VMware host is available. Linux Desktop is beta; platform compatibility declarations are not evidence of native hypervisor validation.
- Actual merge, release publication and directory submission require their own authorization. The release workflow only attaches artifacts after a matching versioned release is published.
