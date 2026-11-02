import { parseArgs } from 'node:util';
import { createInterface as createQuestions } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { Workstation } from './workstation.mjs';
import { saveCredential } from './credential-setup.mjs';
import { localFileProtector } from './local-file-security.mjs';

function passwordPrompt(label) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const previousRaw = input.isRaw;
    let text = '';
    emitKeypressEvents(input);
    const finish = error => {
      input.off('keypress', onKey); input.setRawMode(previousRaw); input.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(text);
    };
    const onKey = (chunk, key = {}) => {
      if ((key.ctrl && ['c', 'd'].includes(key.name))) return finish(new Error('Credential setup cancelled.'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') {
        if (text) { text = [...text].slice(0, -1).join(''); process.stdout.write('\b \b'); }
      } else if (chunk && !/[\x00-\x1f\x7f]/.test(chunk) && !key.ctrl && !key.meta) {
        text += chunk; process.stdout.write('*'.repeat([...chunk].length));
      }
    };
    input.on('keypress', onKey); input.setRawMode(true); input.resume();
    process.stdout.write(label);
  });
}

async function main() {
  const { values } = parseArgs({ options: { kind: { type: 'string' }, profile: { type: 'string', default: 'default' }, vmx: { type: 'string' }, help: { type: 'boolean' }, stdin: { type: 'boolean' }, protect: { type: 'string' } } });
  if (values.protect) { await localFileProtector(new Workstation())(values.protect); return; }
  // The PowerShell helper passes its locally prompted secrets over stdin, never argv.
  if (values.stdin) {
    let payload = '';
    for await (const chunk of process.stdin) {
      payload += chunk;
      if (Buffer.byteLength(payload) > 65536) throw new Error('Credential input exceeds 64 KiB.');
    }
    const records = JSON.parse(payload);
    if (!Array.isArray(records) || !records.length || records.length > 4) throw new Error('Invalid credential setup input.');
    for (const record of records) {
      const result = await saveCredential({ ...record, env: process.env, backend: new Workstation() });
      console.log(`Saved ${result.kind} credentials to ${result.filename}${result.profile ? ` (profile ${result.profile})` : ''}.`);
    }
    return;
  }
  if (values.help) { console.log('node server/set-credentials.cjs --kind rest|guest|vm|console [--profile default] [--vmx /absolute/VM.vmx]\nPasswords are prompted locally without echo. VMWARE_CREDENTIALS_FILE overrides the default path.'); return; }
  if (!['rest', 'guest', 'vm', 'console'].includes(values.kind)) throw new Error('Provide --kind rest, guest, vm, or console.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Credential setup requires an interactive terminal. Passwords cannot be passed as arguments.');
  let username;
  if (['rest', 'guest'].includes(values.kind)) {
    const questions = createQuestions({ input: process.stdin, output: process.stdout });
    try { username = await questions.question('Username: '); } finally { questions.close(); }
  }
  const password = await passwordPrompt('Password: ');
  if (await passwordPrompt('Confirm password: ') !== password) throw new Error('Passwords do not match.');
  const result = await saveCredential({ ...values, password, username, backend: new Workstation() });
  console.log(`Saved ${result.kind} credentials to ${result.filename}${result.profile ? ` (profile ${result.profile})` : ''}.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
