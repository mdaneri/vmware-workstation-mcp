import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [mode, ...args] = process.argv.slice(2);
if (mode === 'tree') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'leaf', args[0]], { stdio: 'ignore' });
  await fs.writeFile(args[0] + '.pid', String(child.pid));
  process.stdout.write('tree-ready\n'); setInterval(() => {}, 1000);
} else if (mode === 'leaf') {
  await fs.writeFile(args[0], 'alive'); setInterval(() => {}, 1000);
} else if (mode === 'hold') {
  if (args[0]) await fs.writeFile(args[0], 'partial output');
  process.stdout.write('working\n'); setInterval(() => {}, 1000);
} else if (mode === 'progress') {
  process.stdout.write('PROGRESS\n+ 12\n');
  setTimeout(() => { process.stdout.write('+ 47\nRESULT\n+ SUCCESS\n'); }, 100);
} else if (mode === 'flood') {
  process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000);
} else if (mode === 'backend') {
  const [kind, ...native] = args;
  const command = kind === 'vmrun' ? native[2] : native[0];
  if (process.env.JOB_TEST_DELAY && !['list', 'listSnapshots'].includes(command)) await new Promise(resolve => setTimeout(resolve, Number(process.env.JOB_TEST_DELAY)));
  if (process.env.JOB_CALLS) await fs.appendFile(process.env.JOB_CALLS, JSON.stringify({ kind, args: native }) + '\n');
  if (command === 'list') console.log('Total running VMs: 0');
  else if (command === 'listSnapshots') console.log('Total snapshots: 0');
  else if (kind === 'disk') {
    const output = native.at(-1);
    let descriptor = await fs.readFile(command === '-r' ? native[1] : output, 'utf8');
    if (command === '-x') descriptor = descriptor.replace(/RW \d+ /, `RW ${Number(native[1].replace('MB', '')) * 2048} `);
    if (command === '-r') descriptor = descriptor.replace(/SPARSE "[^"]+"/, `SPARSE "${path.basename(output)}"`);
    await fs.writeFile(output, descriptor);
  } else if (command === 'clone') {
    await fs.copyFile(native[3], native[4]);
    await fs.copyFile(path.join(path.dirname(native[3]), 'disk.vmdk'), path.join(path.dirname(native[4]), 'disk.vmdk'));
  } else if (!['stop', 'reset', 'pause', 'unpause', 'suspend'].includes(command)) throw new Error('Unexpected fake backend command: ' + command);
}
