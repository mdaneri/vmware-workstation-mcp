import { z } from 'zod';

const file = z.string().min(1).max(4096).refine(v => !/[\x00-\x1f]/.test(v));
const confirm = z.literal(true).describe('Set only after authorization for this exact offline hardware change.');
export const controllerSchema = z.object({
  type: z.enum(['lsilogic', 'pvscsi', 'sata', 'nvme']),
  index: z.number().int().min(0).max(3),
}).strict();
export const diskSchema = z.object({
  controller: z.enum(['scsi', 'sata', 'nvme']), controller_index: z.number().int().min(0).max(3),
  unit: z.number().int().min(0).max(29), capacity_mb: z.number().int().min(1).max(8388608),
}).strict();
export const nicSchema = z.object({
  index: z.number().int().min(0).max(9),
  model: z.enum(['e1000', 'e1000e', 'vmxnet3']).optional(),
  network: z.enum(['nat', 'bridged', 'hostonly', 'custom', 'lan_segment']).optional(),
  vmnet: z.string().regex(/^vmnet\d{1,3}$/).optional(),
  segment: z.string().min(1).max(256).optional(),
  mac: z.string().regex(/^00:50:56:[0-3][0-9a-f]:[0-9a-f]{2}:[0-9a-f]{2}$/i).optional().describe('Explicit VMware manual MAC in 00:50:56:00-3f:xx:xx. Omit to preserve identity or generate on a new adapter.'),
  start_connected: z.boolean().optional(),
}).strict();
export const typedCreateFields = {
  controllers: z.array(controllerSchema).min(1).max(12).optional(),
  disks: z.array(diskSchema).min(1).max(64).optional().describe('New independent sparse disks; replaces disk_gb when supplied. Explicit controller and slot required.'),
  nics: z.array(nicSchema).max(10).optional().describe('Explicit adapter indices; replaces network/vmnet defaults when supplied. Empty means no NICs.'),
  cores_per_socket: z.number().int().min(1).max(32).optional(),
  nested_virtualization: z.boolean().optional(),
  secure_boot: z.boolean().optional(),
  vtpm: z.boolean().optional().describe('vTPM mutation is unsupported without a verified headless encryption backend.'),
};
export const hardwareSchemas = {
  vm_hardware_capabilities: z.object({}).strict(),
  vm_hardware_get: z.object({ vmx: file }).strict(),
  vm_hardware_set: z.object({
    vmx: file, confirm,
    cpus: z.number().int().min(1).max(32).optional(),
    cores_per_socket: typedCreateFields.cores_per_socket,
    memory_mb: z.number().int().min(256).max(131072).multipleOf(4).optional(),
    nested_virtualization: typedCreateFields.nested_virtualization,
    firmware: z.enum(['bios', 'efi']).optional(),
    secure_boot: typedCreateFields.secure_boot, vtpm: typedCreateFields.vtpm,
    controllers: typedCreateFields.controllers,
    nics: typedCreateFields.nics.describe('Patch only the selected NICs; omitted adapters and identity fields are preserved. No removal.'),
  }).strict().refine(a => Object.keys(a).some(k => !['vmx', 'confirm'].includes(k)), 'Provide at least one hardware change.'),
};

export const usesTypedCreation = a => Object.keys(typedCreateFields).some(k => a[k] !== undefined);
