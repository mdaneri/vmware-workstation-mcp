# VMware Workstation Plugin

An independent Windows and Linux MCP plugin for VMware Workstation with **108 tools** for VM management, OVF/OVA appliances, LAN segments, guest operations, file transfers, and direct headless VNC/RFB console control. It is not an official VMware or Broadcom product.

The plugin package lives in `vmware-workstation/`. Start with the [configuration guide](vmware-workstation/README.md), [native console setup](vmware-workstation/console.md), or [complete tool reference](vmware-workstation/reference.md).

## Use in Codex

Register this GitHub marketplace and install the plugin:

```powershell
codex plugin marketplace add mdaneri/vmware-workstation-mcp
codex plugin add vmware-workstation@vmware-local
```

For local development, clone the repository and register that directory instead:

```powershell
codex plugin marketplace add .
codex plugin add vmware-workstation@vmware-local
```

Restart the desktop app after installation and open a fresh local chat with VMware Workstation enabled. Ask: "List my VMware Workstation VMs." Native console operations require the one-time [per-VM console setup](vmware-workstation/console.md). The build itself does not install, enable, upload, or publish the plugin. These commands use the [local/Git marketplace flow](https://developers.openai.com/plugins/build/plugins).

Requires Windows or Linux, Node.js 22.12 or newer on PATH, and a separately installed native VMware Workstation. PowerShell 7 is used by the setup/validation helpers and Windows listener checks. Linux listener checks use `/proc` directly. See [Linux setup and WSL testing](vmware-workstation/linux.md) for native executable paths, XDG credentials and permissions. REST tools require vmrest and local credentials; guest OS operations require VMware Tools and guest credentials. Native console tools require neither a guest OS nor VMware Tools. A web/mobile-only chat cannot launch this local stdio process.

## Develop

Version 0.5.0 adds six [OVF/OVA tools and four background job tools](vmware-workstation/ovf.md), including an absolute `VMWARE_OVFTOOL_PATH` override. Exports/imports run as cancellable jobs and preserve no-overwrite defaults. Phase 1 of [roadmap #1](https://github.com/mdaneri/vmware-workstation-mcp/issues/1) is implemented; later roadmap phases remain open.

Version 0.4.0 added five [LAN segment tools](vmware-workstation/README.md#lan-segments) to create/list/remove segments and attach/detach existing VM adapters. Changes are backed up; removal refuses known VM references. Close the Workstation GUI before changes and power off VMs before editing adapters. LAN mutation tests use temporary fixtures; guest connectivity has not been live-validated.

```powershell
npm ci
npm run build
npm test
npm run smoke
npm run validate
npm run package
```

`src/workstation.mjs` wraps vmrun with separate executable arguments and no shell. `src/server.mjs` registers the MCP tools using the official MCP SDK. `src/console.mjs` manages direct RFB sessions; `rfb2` has no runtime dependencies, and `pngjs` encodes only VM framebuffer pixels. `npm run build` bundles runtime dependencies into the plugin so installation requires Node but no npm download. Rebuild after changing source.

The plugin implements all **47 installed vmrun commands and 28 installed REST operations**, plus blank VM creation, backed-up VMX editing, six direct VNC/RFB console tools, five LAN segment tools, ten OVF/job tools, convenience tools, and coverage discovery: **108 tools**. All 98 pre-OVF tool schemas/annotations are checked against a saved baseline. Setup, credentials, and runnable examples are in the [practical guide](vmware-workstation/README.md), the [console guide](vmware-workstation/console.md), and the [operation reference](vmware-workstation/reference.md).

Tests use a fake process runner, temporary VMX files, and a mock HTTP service. They do not change real VMs. The smoke script starts the actual bundled MCP process, discovers tools, and reads host status/inventory. If a running VM exists it reads selected hardware, snapshots, Tools state, and guest IP. It also reads host networks and checks the installed command coverage. It never powers VMs on/off or changes snapshots. `npm run smoke:rest` reads VM and network inventory from the real REST service after credentials are configured.

Packaging writes `dist/vmware-workstation-0.5.0.zip` and verifies its required entries and contents on both hosts. It includes one plugin and excludes source development dependencies, test VMs/credentials, and the repo marketplace.

## Validation

On 2026-11-02, Workstation 26.0.1 build 25688693 was verified to expose native per-VM RFB 3.8 with VNC password authentication and a 127.0.0.1 listener. The opt-in live console test connected to new BIOS and UEFI VMs simultaneously, captured their firmware displays, and verified RFB keys changed both displays while a non-VMware app stayed foreground in all 142 observed samples. Click/type/scroll/status calls also completed. Test VMs were stopped, VNC disabled, and temporary credentials deleted. No host screenshot, mouse/keyboard injection, or window activation was used. An actual PXE server and OS installation ISO were not part of that run.

The automated suite adds RFB 3.3/3.7/3.8 authentication, framebuffer pixels, multi-VM isolation, key modifiers, resize handling, listener/credential rejection, and file permission preparation checks to the original VM/REST tests. `npm run validate` checks the 108 tool schemas, both the original 87-tool and pre-OVF 98-tool baselines, and platform credential-file protection. All new console input/capture uses RFB; the read-only focus observer exists only in the opt-in live test.

The automated suite covers all 47 CLI argument contracts, all 28 REST request contracts, direct RFB sessions, VM configuration, Linux credential permissions and native socket ownership. CI runs tests and package validation on Windows and Ubuntu without requiring VMware or accessing a real VM. Linux integration tests use the bundled MCP process, actual Linux subprocesses and authenticated RFB test doubles; a native Linux VMware hypervisor has not been live-validated.

Live validation also exercised blank VM creation with a real sparse disk, memory/CPU/display-name edits, and snapshot create/revert/delete on an isolated powered-off VM. The opt-in scripts save machine-specific evidence under ignored `test-vms/`; local credentials, VM files, and screenshots are not published in this repository.

The real REST service and authenticated guest execution/file transfers still require configured credentials and a guest with running VMware Tools. Their request/execution contracts were tested with mocks, not claimed as live end-to-end validation. The blank test VM has no installed OS.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and testing and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

Original project code is available under the [MIT license](LICENSE). Bundled dependencies retain their own [third-party licenses](vmware-workstation/THIRD-PARTY-NOTICES.md). VMware executables, VM images, and installation media are not included; see [NOTICE.md](NOTICE.md).
