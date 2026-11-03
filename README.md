# VMware Workstation Plugin

An independent Windows and Linux MCP plugin for VMware Workstation with **148 tools** for VMDK lifecycle, VM management, OVF/OVA appliances, LAN segments, verified guest execution, file transfers, direct headless VNC/RFB console control, and optional serial consoles. It is not an official VMware or Broadcom product.

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

Version 0.14.0 adds six [multi-VM lab tools](vmware-workstation/labs.md): versioned recipes, dependency/readiness ordering, private ownership manifests, explicit safe recovery and tracked-resource teardown. Two/three-VM private-LAN and nested ESXi examples reuse templates/hardware/disk/LAN infrastructure. All mutations default to dry-run; actual deployment/start/stop/destroy require confirmation. Uncertain creation and changed ownership fail explicitly; unexpected files remain. All 142 previous tool definitions are unchanged. Native VMware lab deployment, guest connectivity and lifecycle validation remain unverified; the opt-in live harness is not part of default tests. See [issue #12](https://github.com/mdaneri/vmware-workstation-mcp/issues/12) and [tracker #6](https://github.com/mdaneri/vmware-workstation-mcp/issues/6).

Version 0.13.0 adds four [declarative VM template tools](vmware-workstation/templates.md): versioned portable JSON recipes, capability-aware validation, read-only deployment plans, sanitized blank-hardware export and explicit no-overwrite deployment. Bundled Linux, Windows Server and nested ESXi examples keep network/media bindings local. All 138 previous tool definitions are unchanged. Registration and power-on are opt-in; vTPM and forced PXE boot order fail explicitly. See [issue #11](https://github.com/mdaneri/vmware-workstation-mcp/issues/11) and [tracker #6](https://github.com/mdaneri/vmware-workstation-mcp/issues/6).

Version 0.12.1 adds the project website, support URL and developer name to the plugin listing, with matching portable homepage metadata and a new layered VM logo.

Version 0.12.0 adds [reusable asynchronous jobs](vmware-workstation/jobs.md): disk conversion/expansion, full offline clones and sequential VM power batches through `job_start`. Unrelated VMs run concurrently, resources share locks with existing tools, cancellation stops native process trees, and bounded private journals retain results across restart. Existing input schemas and annotations remain compatible; three job descriptions are updated. See [issue #10](https://github.com/mdaneri/vmware-workstation-mcp/issues/10) and [tracker #6](https://github.com/mdaneri/vmware-workstation-mcp/issues/6).

Version 0.11.0 adds [typed hardware configuration](vmware-workstation/hardware.md): optional multi-controller/disk/NIC creation, CPU topology, nested virtualization and firmware/Secure Boot patches. Three new tools inspect capabilities, read typed hardware and apply backed-up offline changes. Existing NIC identity and devices are preserved; vTPM/encryption writes return explicit unsupported errors. All 133 other tool definitions are unchanged; `create_vm` adds only optional fields. See [issue #8](https://github.com/mdaneri/vmware-workstation-mcp/issues/8) and [tracker #6](https://github.com/mdaneri/vmware-workstation-mcp/issues/6).

Version 0.10.0 adds five [ISO media and boot capability tools](vmware-workstation/iso.md): inspect optical drives, mount/eject existing media with offline VMX backups, and inspect boot capabilities. Unproven next-boot firmware and boot-order writes fail explicitly. All 129 previous tool definitions remain unchanged. See [issue #9](https://github.com/mdaneri/vmware-workstation-mcp/issues/9) and [tracker #6](https://github.com/mdaneri/vmware-workstation-mcp/issues/6).

Version 0.9.0 adds [verified guest execution](vmware-workstation/guest-exec.md): `guest_exec` uses an explicit local credential profile, literal program arguments or an explicit script interpreter, bounded stdout/stderr capture, and a unique completion record for guest exit status. Timeout, transport failure and cleanup remain separate. All 128 previous tool definitions remain unchanged. See [issue #13](https://github.com/mdaneri/vmware-workstation-mcp/issues/13) and [tracker #6](https://github.com/mdaneri/vmware-workstation-mcp/issues/6).

Version 0.8.0 adds five [readiness and diagnostics tools](vmware-workstation/readiness.md): separate bounded OS agent/IP/service waits, normalized recent errors and private selected-VM bundles with optional guest-only RFB evidence. All 123 previous tool definitions remain unchanged. See [issue #14](https://github.com/mdaneri/vmware-workstation-mcp/issues/14) and [tracker #6](https://github.com/mdaneri/vmware-workstation-mcp/issues/6).

Version 0.7.0 adds six [optional direct serial tools](vmware-workstation/serial.md): explicit offline setup, status, connect, bounded byte reads/writes, and disconnect with cancellation. Windows uses local named pipes and Linux uses private UNIX sockets, with native VMware worker verification. All 117 previous tool definitions remain unchanged. See [issue #15](https://github.com/mdaneri/vmware-workstation-mcp/issues/15) and [tracker #6](https://github.com/mdaneri/vmware-workstation-mcp/issues/6).

Version 0.6.0 adds nine [VMDK lifecycle tools](vmware-workstation/disks.md): runtime disk-manager discovery, inspect/create/expand/convert/compact/defragment, and explicit controller/slot attach/detach with VMX backups. All 108 existing tool definitions remain unchanged. In-place edits require explicit confirmation; snapshots, shared/backing chains and unsafe VM states are refused. Expansion does not resize guest filesystems. See [issue #7](https://github.com/mdaneri/vmware-workstation-mcp/issues/7) and [tracker #6](https://github.com/mdaneri/vmware-workstation-mcp/issues/6).

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

The plugin implements all **47 installed vmrun commands and 28 installed REST operations**, plus six multi-VM lab tools, four declarative template tools, blank VM creation, backed-up VMX editing, six direct VNC/RFB console tools, five LAN segment tools, ten OVF/job tools, reusable job submission, nine disk tools, six optional serial tools, five readiness/diagnostics tools, verified guest execution, five ISO/boot tools, three typed hardware tools, convenience tools, and coverage discovery: **148 tools**. All 142 previous tool definitions are checked against saved baselines; earlier `create_vm` additions remain optional. Setup, credentials, and runnable examples are in the [practical guide](vmware-workstation/README.md), the [console guide](vmware-workstation/console.md), and the [operation reference](vmware-workstation/reference.md).

Tests use a fake process runner, temporary VMX files, and a mock HTTP service. They do not change real VMs. The smoke script starts the actual bundled MCP process, discovers tools, and reads host status/inventory. If a running VM exists it reads selected hardware, snapshots, Tools state, and guest IP. It also reads host networks and checks the installed command coverage. It never powers VMs on/off or changes snapshots. `npm run smoke:rest` reads VM and network inventory from the real REST service after credentials are configured.

Packaging writes `dist/vmware-workstation-0.14.0.zip` and verifies its required entries and contents on both hosts. It includes one plugin and excludes source development dependencies, test VMs/credentials, and the repo marketplace.

## Validation

Serial tests use two independent local stream test doubles through the bundled MCP server, including native Windows pipe PID checks and native Linux UNIX socket/process checks. They cover byte fidelity, endpoint rejection, bounds, cancellation and offline backups. The opt-in disposable ISO test is provided but has not been run against a VMware guest. See [serial validation and limitations](vmware-workstation/serial.md#validation).

On 2026-11-02, the [live VMDK workflow](vmware-workstation/disks.md#validation) passed on Windows/Workstation 26.0.1: create/inspect/expand, local types 0–3 and streaming type 5 conversion, backed-up attach/detach, compact and defragment. Conversion preserved the source hash and detach preserved the backing hash. Only new disposable targets were mutated; the existing running VM set was unchanged. No guest partition/filesystem resize or native Linux VMware mutation is claimed.

On 2026-11-02, Workstation 26.0.1 build 25688693 was verified to expose native per-VM RFB 3.8 with VNC password authentication and a 127.0.0.1 listener. The opt-in live console test connected to new BIOS and UEFI VMs simultaneously, captured their firmware displays, and verified RFB keys changed both displays while a non-VMware app stayed foreground in all 142 observed samples. Click/type/scroll/status calls also completed. Test VMs were stopped, VNC disabled, and temporary credentials deleted. No host screenshot, mouse/keyboard injection, or window activation was used. An actual PXE server and OS installation ISO were not part of that run.

The automated suite adds RFB 3.3/3.7/3.8 authentication, framebuffer pixels, multi-VM isolation, key modifiers, resize handling, listener/credential rejection, and file permission preparation checks to the original VM/REST tests. `npm run validate` checks the 148 tool schemas, the original 87-tool, pre-OVF 98-tool and pre-disk 108-tool and pre-serial 117-tool and pre-readiness 123-tool and pre-guest-exec 128-tool and pre-ISO 129-tool and pre-hardware 134-tool and pre-jobs 137-tool and pre-template 138-tool and pre-lab 142-tool baselines, and platform credential-file protection. Graphical console input/capture uses RFB; the read-only focus observer exists only in the opt-in live test.

The automated suite covers all 47 CLI argument contracts, all 28 REST request contracts, direct RFB sessions, VM configuration, Linux credential permissions and native socket ownership. CI runs tests and package validation on Windows and Ubuntu without requiring VMware or accessing a real VM. Linux integration tests use the bundled MCP process, actual Linux subprocesses and authenticated RFB test doubles; a native Linux VMware hypervisor has not been live-validated.

Live validation also exercised blank VM creation with a real sparse disk, memory/CPU/display-name edits, and snapshot create/revert/delete on an isolated powered-off VM. The opt-in scripts save machine-specific evidence under ignored `test-vms/`; local credentials, VM files, and screenshots are not published in this repository.

The real REST service and authenticated guest execution/file transfers still require configured credentials and a guest with running VMware Tools. Their request/execution contracts were tested with mocks, not claimed as live end-to-end validation. The blank test VM has no installed OS. The new guest execution runner also has native Windows/Linux tests and an [opt-in disposable clone harness](vmware-workstation/guest-exec.md#validation); this feature has not been live-validated against VMware guests.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and testing and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

Original project code is available under the [MIT license](LICENSE). Bundled dependencies retain their own [third-party licenses](vmware-workstation/THIRD-PARTY-NOTICES.md). VMware executables, VM images, and installation media are not included; see [NOTICE.md](NOTICE.md).
