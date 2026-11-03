import { z } from 'zod';
import { templateId, templateSchema, templateSchemas } from './template-schemas.mjs';

const file = z.string().min(1).max(4096).regex(/^[^\x00-\x1f]+$/);
const readiness = z.object({
  kind: z.enum(['none', 'boot', 'ip', 'service']).default('none'),
  timeout_seconds: z.number().int().min(1).max(600).default(120),
  attempts: z.number().int().min(1).max(3).default(1),
  port: z.number().int().min(1).max(65535).optional(),
  protocol: z.enum(['tcp', 'http', 'https']).default('tcp'),
  path: z.string().max(1024).regex(/^\/(?!\/)[^\x00-\x20#]*$/).default('/'),
  expected_status: z.number().int().min(200).max(599).default(200),
}).strict();
export const labSchema = z.object({
  schema_version: z.literal('1.0'), id: templateId,
  networks: z.record(templateId, z.object({ kind: z.enum(['binding', 'private_lan']) }).strict()),
  vms: z.array(z.object({
    id: templateId, template: z.union([templateId, templateSchema]),
    networks: z.record(templateId, templateId).default({}),
    media: z.record(templateId, templateId).default({}),
    depends_on: z.array(templateId).max(15).default([]),
    readiness: readiness.default({ kind: 'none' }),
  }).strict()).min(1).max(16),
}).strict();
const context = {
  lab: labSchema, directory: file.describe('NEW lab directory, or the same owned directory with resume=true. Parent must exist.'),
  networks: templateSchemas.template_validate.shape.networks,
  media: templateSchemas.template_validate.shape.media,
};
const action = { directory: file, dry_run: z.boolean().default(true), confirm: z.literal(true).optional() };
export const labSchemas = {
  lab_validate: z.object(context).strict(),
  lab_deploy: z.object({ ...context, dry_run: z.boolean().default(true), confirm: z.literal(true).optional(), resume: z.boolean().default(false), start: z.boolean().default(false), timeout_seconds: z.number().int().min(1).max(3600).default(600) }).strict(),
  lab_status: z.object({ directory: file }).strict(),
  lab_start: z.object(action).strict(),
  lab_stop: z.object({ ...action, mode: z.enum(['soft', 'hard']).default('soft') }).strict(),
  lab_destroy: z.object(action).strict(),
};
