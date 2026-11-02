import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { Workstation } from '../src/workstation.mjs';
import { Credentials } from '../src/credentials.mjs';
import { commands, commandSchema, executeCommand, snake } from '../src/vmrun-commands.mjs';
import { RestClient, restOperations, restSchema, restToolName } from '../src/rest.mjs';
import reference from '../src/catalogs/vmrun-help.json' with { type: 'json' };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vmware-all-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vmx = path.join(root, 'lab.vmx');
  const binary = path.join(root, process.platform === 'win32' ? 'vmrun.exe' : 'vmrun');
  const source = path.join(root, 'source file.txt');
  const output = path.join(root, 'output file.txt');
  const clone = path.join(root, 'clone.vmx');
  await Promise.all([fs.writeFile(vmx, ''), fs.writeFile(binary, '', { mode: 0o755 }), fs.writeFile(source, 'source')]);
  const env = { VMRUN_PATH: binary, VMWARE_GUEST_DEFAULT_USERNAME: 'guest', VMWARE_GUEST_DEFAULT_PASSWORD: 'test-secret-not-real', VMWARE_VM_DEFAULT_PASSWORD: 'test-encryption-not-real' };
  const calls = [];
  const backend = new Workstation({ env, run: async (file, args, options) => { calls.push({ file, args, options }); return { stdout: 'ok' }; } });
  const credentials = new Credentials(env);
  return { root, vmx, source, output, clone, env, calls, backend, credentials };
}

test('every installed CLI command is implemented once; all tool names are unique', () => {
  assert.equal(commands.length, 47);
  assert.deepEqual(commands.map(c => c.command).sort(), [...reference.commands].sort());
  assert.equal(restOperations.length, 28);
  const names = [...commands.map(c => `vmrun_${snake(c.command)}`), ...restOperations.map(restToolName)];
  assert.equal(new Set(names).size, 75);
});

// Golden argument contracts transcribed from the installed vmrun usage, independently
// of the command builder. All 47 operations reach the fake runner, never a real VM.
test('all 47 CLI operations produce the documented argv contract', async t => {
  const f = await fixture(t);
  const target = await fs.realpath(f.vmx);
  const source = await fs.realpath(f.source);
  const root = await fs.realpath(f.root);
  const output = path.join(root, path.basename(f.output));
  const clone = path.join(root, path.basename(f.clone));
  const cases = [
    ['start', { mode: 'gui' }, [target, 'gui']],
    ...['stop', 'reset', 'suspend'].map(name => [name, {}, [target, 'soft']]),
    ...['pause', 'unpause', 'disableSharedFolders', 'upgradevm', 'installTools', 'checkToolsState', 'deleteVM'].map(name => [name, {}, [target]]),
    ['listSnapshots', { show_tree: true }, [target, 'showTree']],
    ['snapshot', { name: 'baseline' }, [target, 'baseline']],
    ['deleteSnapshot', { name: 'baseline', delete_children: true }, [target, 'baseline', 'andDeleteChildren']],
    ['revertToSnapshot', { name: 'baseline' }, [target, 'baseline']],
    ['listHostNetworks', {}, []],
    ['listPortForwardings', { vmnet: 'vmnet8' }, ['vmnet8']],
    ['setPortForwarding', { vmnet: 'vmnet8', protocol: 'tcp', host_port: 2222, guest_ip: '192.0.2.2', guest_port: 22, description: 'SSH lab' }, ['vmnet8', 'tcp', '2222', '192.0.2.2', '22', 'SSH lab']],
    ['deletePortForwarding', { vmnet: 'vmnet8', protocol: 'udp', host_port: 5353 }, ['vmnet8', 'udp', '5353']],
    ['runProgramInGuest', { no_wait: true, active_window: true, interactive: true, program: '/usr/bin/printf', arguments: ['%s', 'hello & $(world)'] }, [target, '-noWait', '-activeWindow', '-interactive', '/usr/bin/printf', '%s', 'hello & $(world)']],
    ...['fileExistsInGuest', 'directoryExistsInGuest', 'deleteFileInGuest', 'createDirectoryInGuest', 'deleteDirectoryInGuest', 'listDirectoryInGuest'].map(name => [name, { guest_path: '/tmp/a b' }, [target, '/tmp/a b']]),
    ['setSharedFolderState', { share_name: 'data', host_path: f.root, access: 'readonly' }, [target, 'data', root, 'readonly']],
    ['addSharedFolder', { share_name: 'data', host_path: f.root }, [target, 'data', root]],
    ['removeSharedFolder', { share_name: 'data' }, [target, 'data']],
    ['enableSharedFolders', { runtime_only: true }, [target, 'runtime']],
    ['listProcessesInGuest', {}, [target]],
    ['killProcessInGuest', { pid: 123 }, [target, '123']],
    ['runScriptInGuest', { interpreter: '/bin/sh', script: 'echo one\necho two' }, [target, '/bin/sh', 'echo one\necho two']],
    ['CreateTempfileInGuest', {}, [target]],
    ['CopyFileFromHostToGuest', { host_path: f.source, guest_path: '/tmp/in.txt' }, [target, source, '/tmp/in.txt']],
    ['CopyFileFromGuestToHost', { guest_path: '/tmp/out.txt', host_path: f.output }, [target, '/tmp/out.txt', output]],
    ['renameFileInGuest', { source_path: '/tmp/old', destination_path: '/tmp/new' }, [target, '/tmp/old', '/tmp/new']],
    ['typeKeystrokesInGuest', { text: 'hello\n' }, [target, 'hello\n']],
    ...['connectNamedDevice', 'disconnectNamedDevice'].map(name => [name, { device_name: 'ethernet0' }, [target, 'ethernet0']]),
    ['captureScreen', { host_path: f.output }, [target, output]],
    ['writeVariable', { scope: 'guestVar', name: 'key', value: 'value' }, [target, 'guestVar', 'key', 'value']],
    ['readVariable', { scope: 'runtimeConfig', name: 'key' }, [target, 'runtimeConfig', 'key']],
    ['getGuestIPAddress', { wait: true }, [target, '-wait']],
    ['list', {}, []],
    ['clone', { destination_vmx: f.clone, clone_type: 'linked', snapshot: 'before upgrade', clone_name: 'My Clone' }, [target, clone, 'linked', '-snapshot=before upgrade', '-cloneName=My Clone']],
    ['downloadPhotonVM', { destination_path: path.join(f.root, 'photon') }, [path.join(root, 'photon')]],
  ];
  assert.deepEqual(cases.map(c => c[0]).sort(), commands.map(c => c.command).sort());
  for (const [name, input, expected] of cases) {
    const command = commands.find(c => c.command === name);
    await executeCommand(f.backend, f.credentials, command, { ...(command.vmx ? { vmx: f.vmx } : {}), ...input });
    const call = f.calls.at(-1);
    const auth = command.guestAuth ? ['-gu', 'guest', '-gp', 'test-secret-not-real'] : [];
    assert.deepEqual(call.args, ['-T', 'ws', ...auth, name, ...expected], name);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.timeout, 120000);
  }
});

test('encrypted VM auth is placed before operation and credentials never enter outputs', async t => {
  const f = await fixture(t);
  const command = commands.find(c => c.command === 'runProgramInGuest');
  await executeCommand(f.backend, f.credentials, command, { vmx: f.vmx, vm_password_profile: 'default', program: '/bin/true' });
  assert.deepEqual(f.calls[0].args.slice(0, 8), ['-T', 'ws', '-vp', 'test-encryption-not-real', '-gu', 'guest', '-gp', 'test-secret-not-real']);
  assert.equal(f.credentials.redact('test-secret-not-real / test-encryption-not-real'), '[REDACTED] / [REDACTED]');
  assert.throws(() => commandSchema(command).parse({ vmx: f.vmx, program: '/bin/true', password: 'no-raw-passwords' }));
});

test('missing credentials stop guest execution before spawning', async t => {
  const f = await fixture(t);
  await assert.rejects(executeCommand(f.backend, new Credentials({}), commands.find(c => c.command === 'listProcessesInGuest'), { vmx: f.vmx }), /not configured/);
  assert.equal(f.calls.length, 0);
});

test('host file overwrite and allowed host roots checks apply to transfers', async t => {
  const f = await fixture(t);
  const command = commands.find(c => c.command === 'CopyFileFromGuestToHost');
  await assert.rejects(executeCommand(f.backend, f.credentials, command, { vmx: f.vmx, guest_path: '/tmp/a', host_path: f.source }), /overwrite/);
  const allowed = path.join(f.root, 'allowed'); await fs.mkdir(allowed);
  f.env.VMWARE_ALLOWED_HOST_ROOTS = allowed;
  await assert.rejects(executeCommand(f.backend, f.credentials, command, { vmx: f.vmx, guest_path: '/tmp/a', host_path: f.output }), /outside/);
  assert.equal(f.calls.length, 0);
});

test('credential file profiles and JSON/URL/form redaction', async t => {
  const f = await fixture(t);
  const filename = path.join(f.root, 'credentials.json');
  const password = 'pass word/+"&';
  await fs.writeFile(filename, JSON.stringify({ guest: { linux: { username: 'tester', password } }, rest: { username: 'api', password }, vm: { encrypted: { password } } }), { mode: 0o600 });
  const credentials = new Credentials({ VMWARE_CREDENTIALS_FILE: filename });
  assert.equal((await credentials.guest('linux')).password, password);
  assert.equal(await credentials.vm('encrypted'), password);
  const auth = await credentials.rest();
  for (const secret of [password, encodeURIComponent(password), JSON.stringify(password).slice(1, -1), new URLSearchParams({ secret: password }).toString().slice(7), auth.authorization.slice(6)]) assert.equal(credentials.redact(secret), '[REDACTED]');
  await assert.rejects(credentials.guest('../invalid'), /profile/);
});

async function mockRest(t, f) {
  const requests = [];
  const service = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  service.listen(0, '127.0.0.1'); await once(service, 'listening');
  t.after(() => new Promise(resolve => { service.close(resolve); service.closeAllConnections(); }));
  const env = { VMWARE_REST_URL: `http://127.0.0.1:${service.address().port}`, VMWARE_REST_USERNAME: 'api', VMWARE_REST_PASSWORD: 'rest-test-secret' };
  const credentials = new Credentials(env);
  return { client: new RestClient({ env, credentials, backend: f.backend }), requests, env, credentials };
}

test('all 28 REST operations have correct HTTP paths, methods, media types and bodies', async t => {
  const f = await fixture(t);
  const { client, requests } = await mockRest(t, f);
  const id = 'vm-id';
  const cases = [
    ['getAllVMs', {}, 'GET', '/api/vms'],
    ['createVM', { params: { name: 'new lab', parentId: id } }, 'POST', '/api/vms', { name: 'new lab', parentId: id }],
    ['getVM', { id }, 'GET', '/api/vms/vm-id'],
    ['updateVM', { id, parameters: { processors: 4, memory: 4096 } }, 'PUT', '/api/vms/vm-id', { processors: 4, memory: 4096 }],
    ['deleteVM', { id }, 'DELETE', '/api/vms/vm-id'],
    ['getVMRestrictions', { id }, 'GET', '/api/vms/vm-id/restrictions'],
    ['registerVM', { parameters: { name: 'lab', path: f.vmx } }, 'POST', '/api/vms/registration', { name: 'lab', path: await fs.realpath(f.vmx) }],
    ['getVMParams', { id, name: 'guestinfo.test' }, 'GET', '/api/vms/vm-id/params/guestinfo.test'],
    ['configVMParams', { id, parameters: { name: 'guestinfo.test', value: 'yes' } }, 'PUT', '/api/vms/vm-id/configparams', { name: 'guestinfo.test', value: 'yes' }],
    ['getPowerState', { id }, 'GET', '/api/vms/vm-id/power'],
    ['changePowerState', { id, operation: 'on' }, 'PUT', '/api/vms/vm-id/power', 'on'],
    ['getAllSharedFolders', { id }, 'GET', '/api/vms/vm-id/sharedfolders'],
    ['createSharedFolder', { id, parameters: { folder_id: 'data', host_path: f.root, flags: 4 } }, 'POST', '/api/vms/vm-id/sharedfolders', { folder_id: 'data', host_path: await fs.realpath(f.root), flags: 4 }],
    ['deleteSharedFolder', { id, folder_id: 'data folder' }, 'DELETE', '/api/vms/vm-id/sharedfolders/data%20folder'],
    ['updataSharedFolder', { id, folder_id: 'data', parameters: { host_path: f.root, flags: 4 } }, 'PUT', '/api/vms/vm-id/sharedfolders/data', { host_path: await fs.realpath(f.root), flags: 4 }],
    ['getAllNICDevices', { id }, 'GET', '/api/vms/vm-id/nic'],
    ['createNICDevice', { id, parameters: { type: 'nat', vmnet: 'vmnet8' } }, 'POST', '/api/vms/vm-id/nic', { type: 'nat', vmnet: 'vmnet8' }],
    ['deleteNICDevice', { id, index: '1' }, 'DELETE', '/api/vms/vm-id/nic/1'],
    ['updateNICDevice', { id, index: '1', parameters: { type: 'custom', vmnet: 'vmnet2' } }, 'PUT', '/api/vms/vm-id/nic/1', { type: 'custom', vmnet: 'vmnet2' }],
    ['getIPAddress', { id }, 'GET', '/api/vms/vm-id/ip'],
    ['getNicInfo', { id }, 'GET', '/api/vms/vm-id/nicips'],
    ['createNetwork', { parameters: { name: 'vmnet9', type: 'hostOnly' } }, 'POST', '/api/vmnets', { name: 'vmnet9', type: 'hostOnly' }],
    ['getAllNetworks', {}, 'GET', '/api/vmnet'],
    ['getPortforwards', { vmnet: 'vmnet8' }, 'GET', '/api/vmnet/vmnet8/portforward'],
    ['getMACToIPs', { vmnet: 'vmnet8' }, 'GET', '/api/vmnet/vmnet8/mactoip'],
    ['updateMacToIP', { vmnet: 'vmnet8', mac: '00:11:22:33:44:55', parameters: { IP: '192.0.2.2' } }, 'PUT', '/api/vmnet/vmnet8/mactoip/00%3A11%3A22%3A33%3A44%3A55', { IP: '192.0.2.2' }],
    ['updatePortforward', { vmnet: 'vmnet8', protocol: 'tcp', port: 2222, parameters: { guestIp: '192.0.2.2', guestPort: 22, desc: 'SSH' } }, 'PUT', '/api/vmnet/vmnet8/portforward/tcp/2222', { guestIp: '192.0.2.2', guestPort: 22, desc: 'SSH' }],
    ['deletePortforward', { vmnet: 'vmnet8', protocol: 'tcp', port: 2222 }, 'DELETE', '/api/vmnet/vmnet8/portforward/tcp/2222'],
  ];
  assert.deepEqual(cases.map(c => c[0]).sort(), restOperations.map(o => o.id).sort());
  for (const [name, input, method, url, body] of cases) {
    const operation = restOperations.find(o => o.id === name);
    const result = await client.execute(operation, input);
    assert.deepEqual(result.data, { ok: true });
    const request = requests.at(-1);
    assert.equal(request.method, method, name); assert.equal(request.url, url, name);
    assert.equal(request.body, body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), name);
    assert.equal(request.headers.authorization, `Basic ${Buffer.from('api:rest-test-secret').toString('base64')}`);
    assert.equal(request.headers.accept, 'application/vnd.vmware.vmw.rest-v1+json');
    if (body !== undefined) assert.equal(request.headers['content-type'], request.headers.accept);
  }
});

test('REST rejects raw passwords, invalid body types and path traversal before network access', () => {
  const get = restOperations.find(o => o.id === 'getVM');
  for (const id of ['..', '../vms', 'a\\b']) assert.throws(() => restSchema(get).parse({ id }));
  assert.throws(() => restSchema(get).parse({ id: 'vm', vmPassword: 'raw' }));
  assert.throws(() => restSchema(restOperations.find(o => o.id === 'updateVM')).parse({ id: 'vm', parameters: { processors: 'four' } }));
  assert.throws(() => restSchema(restOperations.find(o => o.id === 'changePowerState')).parse({ id: 'vm', operation: 'reset' }));
});

test('REST restricts origins, preserves TLS verification, and does not follow redirects', async t => {
  for (const url of ['http://example.com:8697', 'https://user:pass@example.com', 'https://example.com/api', 'ftp://127.0.0.1', 'http://localhost/#fragment']) assert.throws(() => new RestClient({ env: { VMWARE_REST_URL: url } }).baseURL());
  assert.equal(new RestClient({ env: { VMWARE_REST_URL: 'https://example.com:8698' } }).baseURL(), 'https://example.com:8698');
  const credentials = new Credentials({ VMWARE_REST_USERNAME: 'api', VMWARE_REST_PASSWORD: 'test-secret' });
  let options;
  const client = new RestClient({ env: {}, credentials, fetcher: async (_, input) => { options = input; return new Response(null, { status: 204 }); } });
  await client.request('GET', '/api/vms');
  assert.equal(options.redirect, 'error');
  assert.ok(!('dispatcher' in options));
});

test('REST encrypted VM password comes from profile and query is encoded', async t => {
  const f = await fixture(t);
  const setup = await mockRest(t, f);
  setup.env.VMWARE_VM_DEFAULT_PASSWORD = 'secret space&=';
  await setup.client.execute(restOperations.find(o => o.id === 'getVM'), { id: 'vm', vm_password_profile: 'default' });
  assert.equal(setup.requests[0].url, '/api/vms/vm?vmPassword=secret+space%26%3D');
});

test('REST error responses redact credentials and mark mutation outcomes uncertain', async () => {
  const env = { VMWARE_REST_USERNAME: 'api', VMWARE_REST_PASSWORD: 'never-leak-me' };
  const client = new RestClient({ env, credentials: new Credentials(env), fetcher: async () => new Response('failed never-leak-me', { status: 500 }) });
  await assert.rejects(client.request('DELETE', '/api/vms/id'), error => error.message.includes('may have taken effect') && !error.message.includes('never-leak-me'));
});

test('REST allowed-root enforcement resolves VM IDs before sending mutations', async t => {
  const f = await fixture(t);
  const allowed = path.join(f.root, 'allowed'); await fs.mkdir(allowed);
  const env = { VMWARE_ALLOWED_ROOTS: allowed, VMWARE_REST_USERNAME: 'api', VMWARE_REST_PASSWORD: 'test-secret' };
  f.env.VMWARE_ALLOWED_ROOTS = allowed;
  const methods = [];
  const client = new RestClient({ env, backend: f.backend, credentials: new Credentials(env), fetcher: async (_, options) => { methods.push(options.method); return Response.json([{ id: 'vm', path: f.vmx }]); } });
  await assert.rejects(client.execute(restOperations.find(o => o.id === 'deleteVM'), { id: 'vm' }), /outside/);
  assert.deepEqual(methods, ['GET']);
});

test('REST rejects oversized responses instead of buffering them without limit', async () => {
  const env = { VMWARE_REST_USERNAME: 'api', VMWARE_REST_PASSWORD: 'test-secret' };
  const client = new RestClient({ env, credentials: new Credentials(env), fetcher: async () => new Response('x'.repeat(1024 * 1024 + 1)) });
  await assert.rejects(client.request('GET', '/api/vms'), /exceeded/);
});
