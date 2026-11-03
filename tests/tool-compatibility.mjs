import assert from 'node:assert/strict';

// Only create_vm grows optional fields. Every old property, required argument,
// default, annotation and description stays exactly as published.
export function assertCompatibleTool(actual, prior, message = prior.name) {
  if (prior.name !== 'create_vm') return assert.deepEqual(actual, prior, message);
  const copy = structuredClone(actual);
  for (const field of Object.keys(copy.inputSchema.properties)) if (!(field in prior.inputSchema.properties)) {
    assert.ok(!copy.inputSchema.required?.includes(field), `New create_vm field must be optional: ${field}`);
    delete copy.inputSchema.properties[field];
  }
  assert.deepEqual(copy, prior, message);
}
