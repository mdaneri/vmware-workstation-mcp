# Multi-VM labs

Version 0.14.0 adds six tools: `lab_validate`, `lab_deploy`, `lab_status`,
`lab_start`, `lab_stop` and `lab_destroy`. They reuse the [template engine](templates.md),
typed hardware, disk checks, LAN catalog, readiness observations and shared
resource reservations. They create blank independent VMs; install guest operating
systems separately. All lifecycle mutations default to `dry_run:true`.

## Define and plan a private two-VM lab

Load [labs/two-vm.json](labs/two-vm.json) as the `lab` object. Versioned JSON
Schema is [labs/schema-v1.json](labs/schema-v1.json). Each VM declares a bundled
template ID or complete portable template, logical network/media mappings,
dependencies and readiness. Names and mappings are explicit; no host files
are discovered or read implicitly.

```json
{
  "lab": {
    "schema_version": "1.0",
    "id": "private-demo",
    "networks": { "private": { "kind": "private_lan" } },
    "vms": [
      { "id": "gateway", "template": "linux", "networks": { "primary": "private" } },
      { "id": "client", "template": "linux", "networks": { "primary": "private" }, "depends_on": ["gateway"] }
    ]
  },
  "directory": "C:\\VMs\\private-demo"
}
```

Pass this object to `lab_validate` or `lab_deploy`. On Linux use an absolute
native path such as `/home/alice/vms/private-demo`. The parent must already exist
under configured VM and host roots. A real lab root must be NEW. Planning checks
all template capabilities, graph cycles, mappings, individual and aggregate disk
space without creating a directory or LAN segment. CPU/memory totals are reported
requirements, not admission reservations against host RAM or CPU availability.
Plans show VMX and disk paths; `planned:private` is a placeholder for the segment
ID allocated on deployment. Plans reserve nothing and preflight repeats.

Create after authorization with the same arguments plus:

```json
{ "dry_run": false, "confirm": true, "start": false }
```

Keep Workstation/Player GUI and other configuration writers closed while creating
or removing private LANs. A private segment gets a unique lab/owner-scoped name;
existing segments are never adopted as lab-owned. Private LANs do not supply
DHCP, routing or guest IP configuration. The example's gateway name does not
configure a router. External VMnets/segments are local bindings, never owned:

```json
{
  "networks": {
    "management": { "network": "custom", "vmnet": "vmnet2" }
  },
  "media": { "installer": "/srv/iso/linux.iso" }
}
```

Declare `management` as `{ "kind":"binding" }` in `lab.networks`, map a VM's
template network name to `management`, and map an ISO template's logical media
name to `installer`. Supply exactly the required bindings. Existing NAT,
bridged, host-only, custom VMnet and catalogued LAN segment bindings use the
template validation rules. No VMnet is created, edited or deleted.

The [three-VM nested ESXi example](labs/nested-esxi.json) composes Linux gateway,
nested ESXi and Linux client recipes with a local management binding and private
LAN. It configures nested hardware only; ESXi installation, nested guest execution,
guest routing, forced boot order, vTPM and encryption are not supplied by labs.

## Start, observe and stop

`lab_start`, `lab_stop` and `lab_destroy` accept `directory`, `dry_run` and
`confirm`. Preview first, then use `dry_run:false, confirm:true` for the
authorized effects. `lab_deploy.start:true` also opts into startup.

Startup follows dependency order and checks each VM's readiness before proceeding.
The default `readiness.kind:"none"` means observed running power only. To gate
dependents on an installed guest's service, change its declaration before deploy:

```json
{
  "kind": "service", "port": 443, "protocol": "https", "path": "/health",
  "expected_status": 200, "timeout_seconds": 60, "attempts": 2
}
```

`boot` requires running VMware Tools; `ip` requires a valid Tools-reported IP;
`service` probes only that guest IP using TCP or HTTP(S). These reuse the
[readiness tools](readiness.md), including TLS validation and no HTTP redirects.
There are at most 16 VMs, 1–3 readiness attempts per VM, and 1–600 seconds per
attempt. Retries repeat observations, never power commands. A failed criterion
leaves already started VMs running and does not start dependents. Already running
VMs are rechecked on retry. No OS/application readiness follows from a power-on
command or IP alone.

`lab_status` takes `{ "directory":"C:\\VMs\\private-demo" }`. It returns
the persisted manifest plus fresh ownership/power observations. Stored readiness
describes an earlier completed step; current readiness is not inferred.

Stop runs in reverse dependency order, requires explicit confirmation and defaults
to soft shutdown. `mode:"hard"` must be explicitly authorized because it can
lose guest data. There is no automatic hard fallback. A successful native stop
command without observed power-off reports failure; inspect state before retry.

## Manifest and recovery

The lab root retains private `lab-manifest.json` and `.lab-owner` files. Atomic,
synced manifest writes record the recipe, bindings, ownership identity, creation
intent, completed VM/disk files, created segment IDs and failure summaries. It
contains local paths and should stay private. It never stores guest credentials,
raw native error text, command output or guest service responses.
Original media bindings remain part of the recipe used for resume matching;
separate `media_paths` records hold the canonical paths actually deployed. ISO
aliases and equivalent path spellings therefore work throughout the lifecycle.
Retargeting an alias does not change an existing lab's selected installer, and
removing installer media does not prevent verifying or tearing down its VM files.

For `LAB_PARTIAL_FAILURE`, inspect `lab_status`. Set `resume:true` on `lab_deploy`
with the SAME recipe and bindings after inspecting the retained state. Completed
VMs are verified and skipped. An untouched destination can be retried; any partial
VM directory or ambiguous segment creation intent is refused, never adopted,
overwritten, automatically replayed or rolled back. Inspect such resources and
recover them manually, or choose a NEW lab root. Editing the recipe is not a
supported recovery operation. No automatic cross-session job replay occurs.

Calls are synchronous; use a sufficiently long MCP client timeout. Cancellation is
checked between stages and during readiness waits; existing native template/power
operations retain their bounded operation timeouts and may finish before the next
cancellation check. The manifest records partial/unknown outcomes. Shared resource
locks coordinate operations in this server only, not separate servers or external
Workstation processes. Do not run two writers against one manifest/catalog.

## Safe teardown

Destroy never stops VMs implicitly. Explicitly stop the lab, inspect its status,
preview destruction, then authorize `lab_destroy` with `dry_run:false, confirm:true`.
Teardown checks ownership identities, canonical paths, links/hard links, full
power-off, saved state/locks, snapshots, unexpected VM/disk files, registered lab
VMs and references to owned disks from other known VMs. Failures retain resources.
Unregister lab VMs separately if an external workflow registered them.
Before the first deletion, teardown also reuses the disk manager's conservative
independence, dependent-chain and shared-extent preflight for every remaining
tracked VMDK, including references from unregistered lab VMs. An inventoried
linked/descendant disk with an uncertain backing chain blocks teardown even if
its VMX does not name an owned parent directly. Unsupported or unreadable disk
descriptors and extents are retained; no chain independence is guessed.

Only recorded creation files are unlinked; no recursive directory removal or
`deleteVM` is used. Unexpected user/runtime files are retained, including logs and
NVRAM. Empty member directories and the root/manifest remain for recovery and
inspection. `retained_files` lists remaining top-level entries. ISO sources,
external VMnets/segments and unrelated files are never deletion targets. Network
removal uses the existing reference checks against registered/running VMs. Other
unregistered VMs cannot be discovered globally; do not share lab disks or private
segments outside the lab. Inaccessible known VMs or unavailable inventory block
teardown. Interrupted deletion can be retried from its recorded intent without
recreating resources; no claimed rollback or backup.

## Validation

Automated Windows/Ubuntu tests exercise headless two/three-VM private-LAN and
nested template workflows with native process test doubles, complete MCP tool
contracts, graph/mapping/schema errors, bounded readiness, authorization,
concurrency/cancellation, manifest reload/recovery and refusal/preservation cases.
All 142 previous tool definitions remain unchanged. These are not live hypervisor,
guest connectivity or nested ESXi execution results.

`npm run test:labs:live` requires separately authorized disposable workload scope
and `VMWARE_LABS_LIVE=1`. It creates a new powered-off private two-VM lab and a
three-VM nested hardware lab using small blank disks; validates NIC/segment links,
resumption and manifests; retains evidence and artifacts without starting,
stopping, registering or destroying VMs. It refuses WSL and never runs in CI.
Native VMware lab deployment, dependency/service startup, stop/destroy and guest
connectivity remain unverified until separately exercised and recorded.
