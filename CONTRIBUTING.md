# Contributing

Use Node.js 22.12 or newer and PowerShell 7 on Windows or Linux. In WSL use native Linux Node/npm and a separate Linux checkout. Install dependencies with `npm ci`, then run:

```powershell
npm test
npm run package
```

The package command builds all bundled entrypoints, refreshes the operation reference and dependency notices, validates portable manifests and all 123 MCP tool schemas, checks compatibility with all 117 previous tools, verifies platform credential-file protection, and creates the plugin ZIP. CI performs these checks on Windows and Ubuntu. Run `npm run build` before testing changes to bundled helpers or the Linux MCP integration test.

Commit source changes together with updated generated files under `vmware-workstation/`. The repository includes built entrypoints so Git-backed plugin installation does not require an npm install. CI checks that a fresh build reproduces the committed generated files.

The default automated tests use temporary files and local mock services; they do not require VMware or modify VMs. `npm run smoke` reads actual Workstation state. `npm run test:serial:live`, `npm run test:disk:live`, `npm run test:ovf:live`, `npm run test:console:live`, `scripts/live-vm.mjs`, and `scripts/live-snapshot-validation.mjs` are opt-in workflows that create or modify test VMs; run them only when you have authorization for that workload. The disk test creates a powered-off disposable VM and small disks with an isolated inventory and canonical target guards, tests the VMDK lifecycle and retains evidence under ignored `test-vms/`. It allows read-only scans of globally running VMs, verifies their running set is unchanged, and confines every explicit mutation target to its newly allocated directory. The OVF test creates a powered-off disposable VM and retains appliance round trips there; configure optional `VMWARE_OVFTOOL_PATH` as needed. Never enable live VM tests in hosted CI.

Keep credentials, machine-specific configuration, VMs, VM screenshots, and local evidence outside commits. Use placeholders or generated test-only credentials in fixtures. Preserve direct RFB console behavior without host desktop capture, host input injection, or window activation.

The serial live test requires `VMWARE_SERIAL_LIVE=1` and a user-selected `VMWARE_SERIAL_LIVE_ISO` already configured for ttyS0 output. It creates one new disposable VM, configures serial offline, boots headlessly, reads a bounded expected marker, then stops that VM. It sends no guest input and retains evidence without a transcript. Read [the serial guide](vmware-workstation/serial.md#validation) before an authorized native run. Automated serial tests use local pipe/socket doubles; Windows native tests compile a tiny fake vmrun with the installed .NET Framework C# compiler, and Linux tests use a shebang stub. Both run the bundled MCP process and real endpoint-owner verification.
