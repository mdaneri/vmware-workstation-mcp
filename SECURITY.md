# Security reporting

For a suspected vulnerability, use this repository's private vulnerability reporting page: https://github.com/mdaneri/vmware-workstation-mcp/security/advisories/new

Include the affected version, a minimal reproduction, expected and observed behavior, and relevant redacted diagnostics. Do not include real credentials, tokens, VM images, or private console screenshots. Keep vulnerability details out of public issues until coordinated disclosure.

The plugin executes local VMware operations as the host user on Windows or Linux. Configure credentials locally, keep native VNC bound to loopback, and authorize mutations only for the intended VM and action. Linux credential files must be owned regular files with mode 600; console verification requires readable native process/socket metadata. Console controls do not use host desktop capture or input injection. See the [console guide](vmware-workstation/console.md) for the implemented boundaries and limits.
