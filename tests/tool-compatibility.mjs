import assert from 'node:assert/strict';

// Expected changes from the handler audit. Historical fixtures retain the original descriptors.
export const annotationCorrections = {
  // Resuming or starting a lab updates its existing recovery manifest.
  lab_deploy: { destructiveHint: true },
  lab_start: { destructiveHint: true },
  // The current backend rejects configuration without writing any settings.
  vm_boot_configure: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  // Reading consumes bytes. Disconnecting discards bytes and cancels pending I/O.
  serial_read: { readOnlyHint: false, destructiveHint: true },
  serial_disconnect: { destructiveHint: true },
  // Job admission can evict history, and status/log calls prune expired records.
  ovf_inspect: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  ovf_validate: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  ovf_import: { destructiveHint: true },
  job_status: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  job_list: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  job_logs: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  // These native operations and REST POSTs add resources or resume execution.
  vmrun_start: { destructiveHint: false },
  vmrun_unpause: { destructiveHint: false },
  vmrun_snapshot: { destructiveHint: false },
  vmrun_add_shared_folder: { destructiveHint: false },
  vmrun_create_directory_in_guest: { destructiveHint: false },
  vmrun_create_tempfile_in_guest: { destructiveHint: false },
  rest_create_vm: { destructiveHint: false },
  rest_register_vm: { destructiveHint: false },
  rest_create_shared_folder: { destructiveHint: false },
  rest_create_nic_device: { destructiveHint: false },
  rest_create_network: { destructiveHint: false },
};
const updatedDescriptions = new Set([
  'job_status', 'job_list', 'job_cancel', 'job_logs', 'serial_read', 'ovf_inspect', 'ovf_validate', 'ovf_import',
]);

// Compare the entire old contract after applying the reviewed annotation and routing changes.
export function assertCompatibleTool(actual, prior, message = prior.name) {
  const expected = structuredClone(prior);
  const { name } = prior;
  if (annotationCorrections[name]) Object.assign(expected.annotations, annotationCorrections[name]);
  if (updatedDescriptions.has(name) || name === 'get_guest_ip') expected.description = actual.description;
  if (name === 'plugin_query' || name === 'plugin_mutate') {
    const selector = expected.inputSchema.properties.tool;
    const readOnly = name === 'plugin_query';
    const names = new Set(selector.enum);
    for (const [tool, hints] of Object.entries(annotationCorrections)) {
      if (typeof hints.readOnlyHint !== 'boolean') continue;
      if (hints.readOnlyHint === readOnly) names.add(tool);
      else names.delete(tool);
    }
    selector.enum = [...names].sort();
  }
  if (!['create_vm', 'get_guest_ip'].includes(name)) return assert.deepEqual(actual, expected, message);
  const copy = structuredClone(actual);
  for (const field of Object.keys(copy.inputSchema.properties)) if (!(field in expected.inputSchema.properties)) {
    if (name === 'get_guest_ip') assert.ok(['wait', 'timeout_seconds'].includes(field), `Unexpected get_guest_ip addition: ${field}`);
    assert.ok(!copy.inputSchema.required?.includes(field), `New ${name} field must be optional: ${field}`);
    delete copy.inputSchema.properties[field];
  }
  assert.deepEqual(copy, expected, message);
}
