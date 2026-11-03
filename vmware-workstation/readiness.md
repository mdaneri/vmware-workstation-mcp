# Readiness and VM diagnostics

Version 0.8.0 adds five tools without changing the previous 123 tool definitions. All operations are headless. They never power on, restart Tools, run a guest script, change networking, remove locks or activate a host window.

## Wait for the criterion you need

After an authorized `vm_power` start (or an OVF job that explicitly requested power-on), call the appropriate wait with the exact VMX:

```json
{"tool":"vm_wait_for_boot","arguments":{"vmx":"C:\\VMs\\Lab\\machine.vmx","timeout_seconds":120}}
{"tool":"vm_wait_for_ip","arguments":{"vmx":"C:\\VMs\\Lab\\machine.vmx","timeout_seconds":60,"poll_interval_ms":1000}}
{"tool":"vm_wait_for_service","arguments":{"vmx":"C:\\VMs\\Lab\\machine.vmx","protocol":"https","port":443,"path":"/health","expected_status":200,"timeout_seconds":120}}
```

On Linux, use native paths such as `/srv/vms/lab/machine.vmx`. Optional `vm_password_profile` resolves encrypted-VM credentials locally; these tools do not require guest login credentials. Configure credentials with the existing setup helper, never in tool arguments or chat.

| Criterion | `ready: true` proves | Does not prove |
| --- | --- | --- |
| Boot | VMware Tools reports `running` in a running VM | A login prompt, all OS services, IP publication or application readiness |
| IP | vmrun publishes a syntactically valid IP for the running VM | That the address is reachable, current or assigned to the intended guest NIC |
| Service TCP | The Tools-reported guest IP accepts a connection on the explicit port | Protocol authentication, application health or a successful guest command |
| Service HTTP(S) | A GET returns the specified status | Response body correctness or authenticated application health |

Services accept no arbitrary host or URL. Probes target only the latest Tools-reported IP. Loopback, unspecified, multicast, link-local/metadata and IPv4-mapped IPv6 addresses are refused for service probes. IPv6 probes support global unicast and ULA addresses. No redirects, proxy environment, response bodies or headers are retained; HTTPS uses normal certificate verification. A private CA must be configured through Node's normal trust configuration. Choose a read-only health endpoint: even GET requests can have application side effects.

Waits have a total 1–600 second deadline (default 120), including queued vmrun time and service probes. Poll intervals are 100–10000 ms (default 1000). Native observations use at most five seconds per command, service probes at most three seconds, both clipped to the remaining deadline. Set the MCP client's request timeout a little higher than `timeout_seconds`; MCP cancellation stops pending observations/probes. No background readiness job remains after a wait returns, though a cancelled native process may take a short time to exit.

Results include `ready`, `result`, `timed_out`, `criterion`, `attempts`, `elapsed_ms`, `lifecycle`, and `state`, with separate `tools`, `address` and `service` observations when available. `result` is `ready`, `timed_out`, `not_ready` or `cancelled`; `state: unknown` explicitly means observation failed or evidence is ambiguous. Powered-off and suspended observations return `not_ready` immediately. Running-but-unready observations poll until the deadline. Observations are sequential snapshots and can disagree during boot or shutdown.

| State | Evidence / next step |
| --- | --- |
| `powered_off` | Inferred: absent from vmrun running list with no detected saved state/lock. Inspect before a mutation; this is not an atomic power guarantee. |
| `suspended` | Not listed as running, with an existing selected-VM saved-state reference. Resume only when authorized. |
| `booting` | Running, Tools not ready, and attributed log modified within five minutes contains firmware/power-on progress. This is an inference, not proof the OS will boot. |
| `tools_unavailable` | Running, Tools not reporting running, no attributed boot progress. Inspect Tools or use guest-only VNC. |
| `network_unavailable` | Tools running without IP, unsafe service IP, or an explicit network-unreachable probe error. Inspect NIC, DHCP and routing. |
| `application_unready` | Guest service connection/status failed or timed out. Check that service and the host-to-guest network path. |
| `running` | VM is running; interpret `ready` using the requested criterion. |
| `unknown` | Native utility failed, lock contention or saved-state evidence is ambiguous. No power state is fabricated. |

Boot waits do not query IP publication: once Tools reports `running`, they return readiness with `address: null` (not observed). Use an IP wait for IP publication. Do not treat an IP failure as proof that Tools is stopped. An IP/service wait can succeed while the later Tools observation is `installed` or `unknown`. Failed service checks cannot always distinguish a firewall from an application that is stopped.

## Inspect recent errors

```json
{"tool":"vm_get_recent_errors","arguments":{"vmx":"/srv/vms/lab/machine.vmx","max_bytes":32768,"max_entries":50}}
```

Only the selected VM directory's current `vmware.log` is considered. Its first 64 KiB must contain `Config file:` identity lines matching the canonical selected VMX, or logs report unavailable/unverified. Rotated logs, shared/unattributed logs, symbolic links, hard-linked logs and other host files are excluded. The tail is bounded to 1–256 KiB and output to 1–200 events. An incomplete first tail line is dropped; truncation is explicit.

Excerpts are normalized allowlisted phrases rather than verbatim lines. This deliberately removes arbitrary credentials, tokens, guest output, paths and unrelated host data even when they appear on error lines. Categories provide actions for `lock_contention`, `disk_error`, `nic_misconfiguration`, `boot_failure` and `capability_unavailable`. Unrecognized error/warning lines yield `observation_unavailable`; absence of recognized events does not prove a healthy VM. No raw guest output is collected or saved.

## Save a private bundle

Set approved existing roots in the server environment. Windows separates multiple roots with `;`, Linux with `:`:

```powershell
$env:VMWARE_DIAGNOSTICS_ROOTS = 'C:\VM-Diagnostics'
```

```bash
export VMWARE_DIAGNOSTICS_ROOTS=/srv/vm-diagnostics
```

Restart the MCP process after changing its environment. `VMWARE_ALLOWED_HOST_ROOTS` is the fallback when diagnostic roots are absent, and continues to restrict host writes when both settings exist. VMX selection honors `VMWARE_ALLOWED_ROOTS`. The destination's parent must exist; its final directory must be new and inside an approved canonical root. Existing directories/files are never overwritten.

```json
{"tool":"vm_collect_diagnostics","arguments":{"vmx":"/srv/vms/lab/machine.vmx","destination_directory":"/srv/vm-diagnostics/lab-boot-001","max_log_bytes":32768}}
```

`diagnostics.json` contains numeric CPU/memory/hardware values, firmware, adapter connection flags, disk-slot presence, lifecycle/Tools/IP, bounded normalized log events and snapshot count/ordinal entries. Snapshot names, full VMX, arbitrary keys, guest output, disk paths, host inventory and raw native errors are excluded. Known credential values receive the existing credential redactor as an additional layer. Missing observations remain explicit. Files use user-only ACLs on Windows or mode 600 in a mode 700 directory on Linux. On a write/permission failure a partial directory may remain; inspect it and use a new destination on retry.

For guest framebuffer evidence, explicitly set `include_console: true`. It reuses `console_screenshot` through native per-VM RFB and writes `guest-console.png` if configured. It never changes VNC setup or falls back to host capture. **Image pixels are not redacted and may contain guest secrets; review them before sharing.** Console failures are reported without blocking the JSON bundle. Text diagnostics are the default.

`workstation_capabilities` also reports utility discovery/help evidence and firmware/boot configuration features. Finding an executable or reading its help does not prove native hypervisor, disk, OVF, firmware or guest support. Live support remains `unknown` until a workload is actually exercised.

## Validation

Default tests use temporary VMX/log fixtures, mock native commands, bundled MCP stdio and local TCP/HTTP services on Windows and Ubuntu. They cover distinct readiness criteria, deadlines (including native command queue contention), cancellation, normalized/redacted logs, bundle bounds/roots, optional RFB evidence and all 123 prior tool definitions. These are mock/transport tests; WSL is not native Linux VMware validation.

The opt-in `npm run test:readiness:live` creates, boots and stops only new disposable VMs. It requires explicit authorization and a local live ISO with VMware Tools, DHCP and the selected service already enabled. Optional guest-login, REST and two-VM LAN-segment checks require additional environment settings described in the script. Evidence stays under ignored `test-vms/`, records which checks were exercised or skipped, and labels the actual host platform. Never run live tests in hosted CI. No new native Windows/Linux VMware, authenticated guest, REST or LAN connectivity result is claimed merely because those scripts exist.
