// Offline setup entrypoint: credentials are read locally, never passed via argv/stdout.
import { parseArgs } from 'node:util';
import { Workstation } from './workstation.mjs';
import { Credentials } from './credentials.mjs';
import { VMFiles } from './vm-files.mjs';
import { localFileProtector } from './local-file-security.mjs';

async function main() {
const backend = new Workstation();
const credentials = new Credentials();
try {
  const { values } = parseArgs({ options: { vmx: { type: 'string' }, port: { type: 'string' }, profile: { type: 'string', default: 'default' } } });
  const vmx = await backend.vmx(values.vmx);
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port || '') || port < 1024 || port > 65535) throw new Error('Provide --port between 1024 and 65535, unique to this VM.');
  const auth = await credentials.console(vmx, values.profile);
  const protectFile = localFileProtector(backend);
  const result = await new VMFiles(backend).configure({ vmx, settings: { 'RemoteDisplay.vnc.enabled': 'TRUE', 'RemoteDisplay.vnc.ip': '127.0.0.1', 'RemoteDisplay.vnc.port': String(port), 'RemoteDisplay.vnc.password': auth.password, 'RemoteDisplay.vnc.key': null } }, { protectFile });
  console.log(JSON.stringify({ ...result, port, host: '127.0.0.1', profile: auth.profile, note: 'Native VNC configured offline; VMX and backup restricted to the current user. Power the VM on with vmrun_start mode=nogui. The VNC password is also stored in the VMX as required by VMware; do not share it.' }));
} catch (error) { console.error(credentials.redact(error.message)); process.exitCode = 1; }
}
main();
