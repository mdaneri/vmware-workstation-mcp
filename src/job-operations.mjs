import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { diskSchemas } from './disks.mjs';
import { parseAssignments } from './workstation.mjs';

const file = z.string().min(1).max(4096).refine(value => !/[\x00-\x1f]/.test(value));
const seconds = z.number().int().min(1).max(3600).default(600);
const clone = z.object({ vmx: file, destination_vmx: file.describe('New .vmx in a NEW directory; full offline clones only.'),
  name: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/).optional(), timeout_seconds: seconds }).strict();
const power = z.object({ vmx: file, action: z.enum(['start', 'stop', 'reset', 'suspend', 'pause', 'unpause']), mode: z.enum(['soft', 'hard']).default('soft'), timeout_seconds: seconds }).strict();
const step = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('disk_convert'), arguments: diskSchemas.disk_convert }).strict(),
  z.object({ operation: z.literal('disk_expand'), arguments: diskSchemas.disk_expand }).strict(),
  z.object({ operation: z.literal('clone'), arguments: clone }).strict(),
  z.object({ operation: z.literal('vm_power'), arguments: power }).strict(),
]);
export const jobStartSchema = z.object({
  steps: z.array(step).min(1).max(16).describe('Explicit sequential steps; stops on first failure/cancellation. Submit separate jobs for concurrency.'),
  confirm: z.literal(true).describe('Only after authorization for every listed operation, VM, disk and power mode.'),
  timeout_seconds: z.number().int().min(1).max(86400).default(3600),
}).strict();

export class JobOperations {
  constructor({ backend, jobs, disks, ovf } = {}) { Object.assign(this, { backend, jobs, disks, ovf }); }
  async start(input) {
    const a = jobStartSchema.parse(input), resources = [], artifacts = [], steps = [];
    // Canonicalize allowlisted paths before admission. Native capability, VM
    // state and disk-reference checks run inside the job, under reservations.
    for (const step of a.steps) {
      const args = { ...step.arguments };
      if (step.operation.startsWith('disk_')) {
        args.disk = await this.disks.diskPath(args.disk);
        resources.push(path.dirname(args.disk)); artifacts.push(args.disk);
        args.vmx_paths = await Promise.all(args.vmx_paths.map(vmx => this.backend.vmx(vmx)));
        resources.push(...args.vmx_paths);
        if (args.destination) {
          const output = await this.disks.output(args.destination);
          args.destination = output.disk; resources.push(output.directory); artifacts.push(output.directory);
        }
      } else {
        args.vmx = await this.backend.vmx(args.vmx); resources.push(path.dirname(args.vmx)); artifacts.push(args.vmx);
        if (step.operation === 'clone') {
          args.destination_vmx = await this.backend.hostPath(args.destination_vmx, 'new-vmx');
          const directory = path.dirname(args.destination_vmx);
          await this.backend.hostPath(path.dirname(directory), 'directory');
          if (await fs.lstat(directory).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw new Error('Clone destination requires a NEW parent directory.');
          resources.push(directory); artifacts.push(directory);
        }
      }
      steps.push({ operation: step.operation, arguments: args });
    }
    return this.jobs.start({ operation: steps.length === 1 ? steps[0].operation : 'batch', resources, artifacts, timeout: a.timeout_seconds * 1000,
      task: context => this.backend.execution.run(context, async () => {
        const results = [];
        for (const [index, step] of steps.entries()) {
          context.signal.throwIfAborted();
          context.log(`Step ${index + 1}/${steps.length}: ${step.operation} started.\n`);
          let result;
          if (step.operation.startsWith('disk_')) result = await this.disks.perform(step.operation.slice(5), step.arguments);
          else if (step.operation === 'clone') result = await this.clone(step.arguments, context);
          else result = await this.power(step.arguments);
          results.push({ step: index + 1, operation: step.operation, result });
          await context.checkpoint({ completed_steps: results });
          context.log(`Step ${index + 1}/${steps.length}: verified completion.\n`);
        }
        return { completed_steps: results, note: 'Native results verified per step; no guest readiness or automatic rollback is implied.' };
      }) });
  }
  async clone(a, context) {
    const source = await this.ovf.vmSource(a.vmx);
    // Budget against virtual capacities rather than sparse allocated sizes.
    const config = parseAssignments(await fs.readFile(a.vmx, 'utf8'));
    let bytes = source.size;
    for (const [key, value] of Object.entries(config)) if (/^(scsi|sata|ide|nvme)\d+:\d+\.filename$/i.test(key) && /\.vmdk$/i.test(value)) {
      bytes += (await this.disks.inspect({ disk: path.resolve(path.dirname(a.vmx), value) })).capacity_bytes;
    }
    const directory = path.dirname(a.destination_vmx);
    await this.disks.freeSpace(path.dirname(directory), bytes);
    context.signal.throwIfAborted(); await fs.mkdir(directory);
    await this.backend.run(['clone', a.vmx, a.destination_vmx, 'full', ...(a.name ? [`-cloneName=${a.name}`] : [])], { mutation: true, timeout: a.timeout_seconds * 1000 });
    context.signal.throwIfAborted();
    const destination = await this.backend.vmx(a.destination_vmx);
    await this.ovf.vmSource(destination);
    return { source: a.vmx, destination, clone_type: 'full', powered_on: false, output_verified: true };
  }
  async power(a) {
    const output = await this.backend.run([a.action, a.vmx, ...(a.action === 'start' ? ['nogui'] : ['stop', 'reset', 'suspend'].includes(a.action) ? [a.mode] : [])], { mutation: true, timeout: a.timeout_seconds * 1000 });
    const running = (await this.backend.details(a.vmx)).running;
    if (a.action === 'start' && !running || ['stop', 'suspend'].includes(a.action) && running) throw new Error('Power command completed but observed VM state did not match; inspect before retrying.');
    return { vmx: a.vmx, action: a.action, commandSucceeded: true, running, output,
      verification: ['start', 'stop', 'suspend'].includes(a.action) ? 'subsequent running inventory' : 'native command exit only; pause/reset state is not observable through running inventory' };
  }
}
