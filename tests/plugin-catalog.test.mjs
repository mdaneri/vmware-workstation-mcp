import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { PluginCatalog } from '../src/plugin-catalog.mjs';

test('bridges reuse original handler context, strict defaults and confirmation without retries', async () => {
  const catalog = new PluginCatalog();
  const calls = [];
  const entry = readOnly => ({ description: 'fixture', annotations: { readOnlyHint: readOnly },
    schema: z.object({ value: z.number().int().default(3), ...(!readOnly ? { confirm: z.literal(true) } : {}) }).strict(),
    invoke: async (args, extra) => { calls.push({ args, extra }); return { content: [{ type: 'text', text: 'fixture result' }] }; },
  });
  catalog.add('read_fixture', entry(true)); catalog.add('write_fixture', entry(false));
  const extra = { signal: new AbortController().signal, requestId: 'same-request' };
  await catalog.invoke(true, { tool: 'read_fixture' }, extra);
  assert.deepEqual(calls[0].args, { value: 3 }); assert.equal(calls[0].extra, extra);
  await catalog.invoke(false, { tool: 'write_fixture', confirm: true, arguments: { confirm: true } }, extra);
  assert.deepEqual(calls[1].args, { value: 3, confirm: true }); assert.equal(calls[1].extra, extra);
  await assert.rejects(catalog.invoke(true, { tool: 'write_fixture', arguments: { confirm: true } }, extra));
  await assert.rejects(catalog.invoke(false, { tool: 'write_fixture', arguments: { confirm: true } }, extra));
  await assert.rejects(catalog.invoke(false, { tool: 'write_fixture', confirm: true, arguments: {} }, extra));
  await assert.rejects(catalog.invoke(true, { tool: 'read_fixture', arguments: { password: 'fixture-secret' } }, extra));
  assert.equal(calls.length, 2);
  const controller = new AbortController(); controller.abort(new Error('cancelled fixture'));
  await assert.rejects(catalog.invoke(true, { tool: 'read_fixture' }, { signal: controller.signal }), /cancelled fixture/);
  assert.equal(calls.length, 2);
  catalog.add('failing_fixture', { ...entry(false), invoke: async () => { calls.push('failed'); throw new Error('uncertain outcome'); } });
  await assert.rejects(catalog.invoke(false, { tool: 'failing_fixture', confirm: true, arguments: { confirm: true } }, extra), /uncertain outcome/);
  assert.equal(calls.filter(value => value === 'failed').length, 1);
});
