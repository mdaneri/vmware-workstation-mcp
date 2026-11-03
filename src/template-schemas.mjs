import { z } from 'zod';
import { controllerSchema, diskSchema } from './hardware-schemas.mjs';

export const templateId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const file = z.string().min(1).max(4096).regex(/^[^\x00-\x1f]+$/);
export const templateSchema = z.object({
  schema_version: z.literal('1.0'),
  id: templateId,
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9 ._()-]*$/),
  guest_os: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  hardware_version: z.number().int().min(14).max(22),
  cpu: z.object({ cpus: z.number().int().min(1).max(32), cores_per_socket: z.number().int().min(1).max(32), nested_virtualization: z.boolean() }).strict(),
  memory_mb: z.number().int().min(256).max(131072).multipleOf(4),
  firmware: z.enum(['bios', 'efi']),
  security: z.object({ secure_boot: z.boolean(), vtpm: z.boolean() }).strict(),
  controllers: z.array(controllerSchema).min(1).max(12),
  disks: z.array(diskSchema).min(1).max(64),
  nics: z.array(z.object({ index: z.number().int().min(0).max(9), model: z.enum(['e1000', 'e1000e', 'vmxnet3']), network: templateId, start_connected: z.boolean() }).strict()).max(10),
  boot: z.object({ mode: z.enum(['default', 'iso', 'pxe']), media: templateId.optional() }).strict(),
}).strict();
const binding = z.object({
  network: z.enum(['nat', 'bridged', 'hostonly', 'custom', 'lan_segment']),
  vmnet: z.string().regex(/^vmnet\d{1,3}$/).optional(),
  segment: z.string().min(1).max(256).regex(/^[^\x00-\x1f]+$/).optional(),
}).strict();
const context = {
  template: z.union([templateId, templateSchema]).describe('Bundled template ID or a complete portable version 1.0 JSON template.'),
  directory: file.describe('Absolute NEW VM directory under allowed VM and host roots; parent must exist.'),
  networks: z.record(templateId, binding).default({}).describe('Explicit local bindings for every logical network; not part of the portable template.'),
  media: z.record(templateId, file).default({}).describe('Logical ISO name to existing allowlisted absolute .iso path; never embedded in templates.'),
};
export const templateSchemas = {
  template_list: z.object({}).strict(),
  template_validate: z.object(context).strict(),
  template_export: z.object({ vmx: file, id: templateId, name: templateSchema.shape.name }).strict(),
  template_deploy: z.object({ ...context,
    dry_run: z.boolean().default(true),
    confirm: z.literal(true).optional().describe('Required for real deployment after authorization for the destination and requested registration/power actions.'),
    register: z.boolean().default(false), power_on: z.boolean().default(false),
    timeout_seconds: z.number().int().min(1).max(3600).default(600),
  }).strict(),
};
