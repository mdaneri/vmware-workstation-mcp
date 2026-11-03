# Contributing

Reusable background jobs use [the job guide](vmware-workstation/jobs.md).
Default tests cover native subprocess concurrency/cancellation, journal privacy,
restart recovery, shared locks and bundled MCP workflows without VMware.
`npm run test:jobs:live` requires separate disposable-workload authorization and
`VMWARE_JOBS_LIVE=1`; it creates only new powered-off targets and retains artifacts.

Typed hardware changes use [the hardware guide](vmware-workstation/hardware.md).
Default tests cover mocked Windows/Linux capability evidence, nested ESXi
layouts and bundled MCP contracts. `npm run test:hardware:live` requires
separate disposable-workload authorization and `VMWARE_HARDWARE_LIVE=1`;
it creates only a new powered-off VM and retains its files/evidence. It does
not prove guest boot, ESXi installation or nested hypervisor execution.

Use Node.js 22.12 or newer and PowerShell 7 on Windows or Linux. In WSL use native Linux Node/npm and a separate Linux checkout. Install dependencies with `npm ci`, then run:

```powershell
npm test
npm run package
```

The package command builds all bundled entrypoints, refreshes the operation reference and dependency notices, validates portable manifests and all 138 MCP tool schemas, checks compatibility with all 137 previous tool inputs and annotations, verifies platform credential-file protection, and creates the plugin ZIP. CI performs these checks on Windows and Ubuntu. Run `npm run build` before testing changes to bundled helpers or the Linux MCP integration test.

Commit source changes together with updated generated files under `vmware-workstation/`. The repository includes built entrypoints so Git-backed plugin installation does not require an npm install. CI checks that a fresh build reproduces the committed generated files.

The default automated tests use temporary files and local mock services; they do not require VMware or modify VMs. `npm run smoke` reads actual Workstation state. `npm run test:serial:live`, `npm run test:disk:live`, `npm run test:ovf:live`, `npm run test:console:live`, `scripts/live-vm.mjs`, and `scripts/live-snapshot-validation.mjs` are opt-in workflows that create or modify test VMs; run them only when you have authorization for that workload. The disk test creates a powered-off disposable VM and small disks with an isolated inventory and canonical target guards, tests the VMDK lifecycle and retains evidence under ignored `test-vms/`. It allows read-only scans of globally running VMs, verifies their running set is unchanged, and confines every explicit mutation target to its newly allocated directory. The OVF test creates a powered-off disposable VM and retains appliance round trips there; configure optional `VMWARE_OVFTOOL_PATH` as needed. Never enable live VM tests in hosted CI.

Keep credentials, machine-specific configuration, VMs, VM screenshots, and local evidence outside commits. Use placeholders or generated test-only credentials in fixtures. Preserve direct RFB console behavior without host desktop capture, host input injection, or window activation.

The opt-in `npm run test:readiness:live` creates new disposable live-ISO guests and validates Tools/IP/service criteria. Optional configured guest profiles, read-only REST inventory and two-VM LAN-segment checks record separate exercised/skipped results. It refuses WSL; native Linux hypervisor results require an actual native Linux VMware host. Read [readiness validation](vmware-workstation/readiness.md#validation) and the script prerequisites before authorizing a live run. Default regression tests do not execute this harness.

The serial live test requires `VMWARE_SERIAL_LIVE=1` and a user-selected `VMWARE_SERIAL_LIVE_ISO` already configured for ttyS0 output. It creates one new disposable VM, configures serial offline, boots headlessly, reads a bounded expected marker, then stops that VM. It sends no guest input and retains evidence without a transcript. Read [the serial guide](vmware-workstation/serial.md#validation) before an authorized native run. Automated serial tests use local pipe/socket doubles; Windows native tests compile a tiny fake vmrun with the installed .NET Framework C# compiler, and Linux tests use a shebang stub. Both run the bundled MCP process and real endpoint-owner verification.

The opt-in `npm run test:guest-exec:live` full-clones an explicitly selected offline template and runs fixed guest execution checks only in the NEW disposable clone. It requires separate workload authorization and never runs in hosted CI. Read [guest execution validation](vmware-workstation/guest-exec.md#validation) for prerequisites and cleanup limits. Default guest execution tests use mocked VMware transports and local native runner subprocesses without VMware.

The opt-in `npm run test:iso:live` mounts a user-selected ISO only on a newly created disposable VM, boots headlessly, verifies configured optical media, hard-stops that VM and safely ejects without modifying the ISO. It requires separate workload authorization plus explicit `VMWARE_ISO_LIVE=1` and `VMWARE_ISO_LIVE_HARD_STOP=1` flags. Read [ISO validation](vmware-workstation/iso.md#validation) before a native run. WSL is refused for live VMware tests; mocked Windows/Linux tests require no hypervisor.
