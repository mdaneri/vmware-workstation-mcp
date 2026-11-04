import assert from 'node:assert/strict';

// create_vm and get_guest_ip grow optional fields. Every old property, required argument,
// default and annotation stays as published; get_guest_ip also updates prose.
export function assertCompatibleTool(actual, prior, message = prior.name) {
  // Job storage and process-tree behavior changed in 0.12; only their prose
  // changes. Keep every existing schema, annotation and tool name identical.
  if (['job_status', 'job_list', 'job_cancel'].includes(prior.name)) return assert.deepEqual({ ...actual, description: prior.description }, prior, message);
  if (!['create_vm', 'get_guest_ip'].includes(prior.name)) return assert.deepEqual(actual, prior, message);
  const copy = structuredClone(actual);
  if (prior.name === 'get_guest_ip') copy.description = prior.description;
  for (const field of Object.keys(copy.inputSchema.properties)) if (!(field in prior.inputSchema.properties)) {
    if (prior.name === 'get_guest_ip') assert.ok(['wait', 'timeout_seconds'].includes(field), `Unexpected get_guest_ip addition: ${field}`);
    assert.ok(!copy.inputSchema.required?.includes(field), `New ${prior.name} field must be optional: ${field}`);
    delete copy.inputSchema.properties[field];
  }
  assert.deepEqual(copy, prior, message);
}
