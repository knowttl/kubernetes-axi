import assert from 'node:assert/strict';
import { execFile, fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { decode } from '@toon-format/toon';
import { mutationFixture } from './b3.ts';
import type { HostTransport } from '../src/transport.js';

const directory = mkdtempSync(join(tmpdir(), 'kubernetes-axi-transport-'));
const origin = 'https://cluster.invalid:6443';
const config = join(directory, 'config.json');
const native = join(directory, 'native.json');
const socketPath = join(directory, 'relay.sock');
const profile = { origin, auth: 'token', certificateAuthority: 'synthetic-ca', token: { env: 'SYNTHETIC_TOKEN' } };
writeFileSync(config, JSON.stringify({ version: 1, profiles: { selected: profile } }), { mode: 0o600 });
const nativeConfig = { apiVersion: 'v1', kind: 'Config', clusters: [{ name: 'selected', cluster: { server: origin + '/prefix', 'certificate-authority-data': Buffer.from('synthetic-ca').toString('base64') } }],
  users: [{ name: 'selected', user: { token: 'synthetic-token' } }], contexts: [{ name: 'selected', context: { cluster: 'selected', user: 'selected' } }], 'current-context': 'selected' };
writeFileSync(native, JSON.stringify(nativeConfig), { mode: 0o600 });
const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('KUBERNETES_AXI_'))),
  KUBERNETES_AXI_CONFIG: config, SYNTHETIC_TOKEN: 'synthetic-token', KUBERNETES_AXI_READ_ONLY: 'false', TMPDIR: directory };
const calls: { method: string; path: string; host: string; authorization: string; proxyAuthorization: string | undefined }[] = [];
let refusal = false;
let redirect = false;
let holding = false;
const relay = createServer((incoming, response) => {
  calls.push({ method: incoming.method!, path: incoming.url!, host: incoming.headers.host!, authorization: incoming.headers.authorization!, proxyAuthorization: incoming.headers['proxy-authorization'] });
  if (holding) return;
  if (refusal) { response.writeHead(502).end(); return; }
  if (redirect) { response.writeHead(302, { location: origin + '/bypass' }).end(); return; }
  incoming.url = incoming.url!.replace(/^\/prefix/, '');
  const path = incoming.url.split('?')[0];
  if (path === '/version') { response.end(JSON.stringify({ major: '1', minor: '32', gitVersion: 'v1.32.2' })); return; }
  if (path === '/api') { response.end(JSON.stringify({ kind: 'APIVersions', apiVersion: 'v1', versions: ['v1'] })); return; }
  if (path === '/apis') { response.end(JSON.stringify({ kind: 'APIGroupList', apiVersion: 'v1', groups: [] })); return; }
  if (!mutationFixture(incoming, response)) response.writeHead(404).end(JSON.stringify({ kind: 'Status', apiVersion: 'v1', reason: 'NotFound', code: 404 }));
});
await new Promise<void>(resolve => relay.listen(socketPath, resolve));
const execute = promisify(execFile);
let declaration: Omit<HostTransport, 'socketPath'> = {};
const launcher = (socket: string): string => `import { main } from ${JSON.stringify(new URL('../dist/cli.js', import.meta.url).href)}; await main(process.argv.slice(1), {transport:${JSON.stringify({ socketPath: socket, ...declaration })}});`;
const run = async (args: string[], socket = socketPath): Promise<{ code: number; stdout: string; stderr: string }> => {
  try { return { code: 0, ...await execute(process.execPath, ['--input-type=module', '-e', launcher(socket), '--', ...args], { env: { ...environment, ...(args.includes('--native-config') ? { KUBERNETES_AXI_CONFIG: undefined } : {}) }, timeout: 20000 }) }; }
  catch (error) { const failed = error as { code: number; stdout: string; stderr: string }; return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr }; }
};
const output = async (args: string[], socket?: string): Promise<any> => {
  const result = await run(args, socket);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return decode(result.stdout);
};
try {
  let routeCases = 0;
  for (const [name, args, expected] of [
    ['version', ['version'], '/version'],
    ['compact kubectl', ['get', 'configmaps', '-n', 'synthetic-b3'], '/api/v1/namespaces/synthetic-b3/configmaps'],
    ['native kubectl', ['native', '--', 'get', '--raw=/api/v1'], '/api/v1'],
    ['native raw separate', ['native', '--', 'get', '--raw', '/api/v1'], '/api/v1'],
    ['workflow review', ['auth', 'can-i', 'get', 'configmaps'], '/apis/authorization.k8s.io/v1/selfsubjectaccessreviews'],
    ['workflow dry-run', ['server-dry-run', '--', 'create', 'configmap', 'absent', '-n', 'synthetic-b3', '--from-literal=value=dry'], '/api/v1/namespaces/synthetic-b3/configmaps'],
  ] as const) {
    for (const identity of ['token', 'certificate', 'native-token', 'native-certificate', 'exec'] as const)
    for (const clientCertificate of [false, true]) for (const serverName of [false, true])
    for (const override of [false, true]) {
      if (override && !identity.startsWith('native') && identity !== 'exec') continue;
      declaration = { endpoint: origin, capabilities: { clientCertificate, serverName }, serverName: 'override.invalid' };
      const certificateProfile = { origin, auth: 'certificate', certificateAuthority: 'synthetic-ca', clientCertificate: 'synthetic-certificate', privateKey: { env: 'SYNTHETIC_TOKEN' } };
      writeFileSync(config, JSON.stringify({ version: 1, profiles: { selected: identity === 'certificate' ? certificateProfile : profile } }));
      const selectedNative = identity.startsWith('native') || identity === 'exec';
      const user = identity === 'native-certificate' ? { 'client-certificate-data': 'Y2VydA==', 'client-key-data': 'a2V5' } : identity === 'exec'
        ? { exec: { apiVersion: 'client.authentication.k8s.io/v1', command: '/never-execute', interactiveMode: 'Never' } } : { token: 'synthetic-token' };
      writeFileSync(native, JSON.stringify({ ...nativeConfig, clusters: [{ name: 'selected', cluster: { ...nativeConfig.clusters[0]!.cluster, ...(override ? { 'tls-server-name': 'override.invalid' } : {}) } }], users: [{ name: 'selected', user }] }));
      calls.length = 0;
      const result = await run([...(selectedNative ? ['--native-config', native, '--trust-exec'] : []), ...args]);
      routeCases++;
      const label = [name, identity, clientCertificate, serverName, override].join(':');
      const allowed = identity !== 'exec' && identity !== 'native-certificate' && (identity !== 'certificate' || clientCertificate) && (!override || serverName);
      if (!allowed) {
        const code = (decode(result.stdout) as any).error.code;
        assert.equal(code, identity === 'exec' && name === 'workflow dry-run' ? 'AUTH_HELPER_MUTATION_UNAVAILABLE' : 'HOST_TRANSPORT_UNAVAILABLE', label + result.stdout);
        assert.equal(calls.length, 0, label);
        continue;
      }
      assert.equal(result.code, 0, label + ': ' + result.stdout + result.stderr);
      assert(calls.some(call => call.path.split('?')[0] === (selectedNative ? '/prefix' : '') + expected), label + ': ' + JSON.stringify(calls));
      assert(calls.every(call => call.host === 'cluster.invalid:6443' && call.authorization === (identity === 'certificate' ? undefined : 'Bearer synthetic-token') && call.proxyAuthorization === undefined), label);
    }
  }
  declaration = {};
  writeFileSync(config, JSON.stringify({ version: 1, profiles: { selected: profile } }));
  writeFileSync(native, JSON.stringify({ ...nativeConfig, clusters: [{ name: 'selected', cluster: { ...nativeConfig.clusters[0]!.cluster, 'tls-server-name': 'override.invalid' } }] }));
  for (const invalid of [
    { capabilities: { serverName: true }, serverName: 'override.invalid' },
    { endpoint: 'https://different.invalid:6443', capabilities: { serverName: true }, serverName: 'override.invalid' },
    { endpoint: origin, capabilities: { serverName: true }, serverName: 'wrong.invalid' },
  ]) {
    declaration = invalid;
    calls.length = 0;
    assert.equal((decode((await run(['--native-config', native, 'version'])).stdout) as any).error.code, 'HOST_TRANSPORT_UNAVAILABLE');
    assert.equal(calls.length, 0);
  }
  declaration = {};
  const prepared = await output(['prepare', '--', 'create', 'configmap', 'absent', '-n', 'synthetic-b3', '--from-literal=value=relayed']);
  const preview = await output(['preview', prepared.request]);
  const stored = readFileSync(join(directory, 'requests', prepared.request, 'request.json'), 'utf8');
  assert(!stored.includes(socketPath));
  const alias = join(directory, 'second.sock');
  await new Promise<void>(resolve => relay.close(() => resolve()));
  await new Promise<void>(resolve => relay.listen(alias, resolve));
  const confirmed = await output(['confirm', prepared.request, '--digest', preview.digest], alias);
  assert.equal(confirmed.state, 'complete');
  assert(calls.some(call => call.method === 'POST' && call.path.startsWith('/api/v1/namespaces/synthetic-b3/configmaps')));
  const read = await output(['get', 'configmaps', '-n', 'synthetic-b3'], alias);
  assert.equal(read.configmaps[0].name, 'absent');
  const second = await output(['prepare', '--', 'delete', 'configmap', 'absent', '-n', 'synthetic-b3', '--wait=false'], alias);
  const secondPreview = await output(['preview', second.request], alias);
  writeFileSync(config, JSON.stringify({ version: 1, profiles: { selected: { ...profile, origin: 'https://different.invalid:6443' } } }));
  calls.length = 0;
  assert.equal((decode((await run(['confirm', second.request, '--digest', secondPreview.digest], alias)).stdout) as any).error.code, 'PREVIEW_MISMATCH');
  assert.equal(calls.length, 0);
  writeFileSync(config, JSON.stringify({ version: 1, profiles: { selected: profile } }));
  for (const args of [
    ['prepare', '--', 'exec', 'selected', '--', 'true'], ['prepare', '--', 'attach', 'selected'],
    ['--native-config', native, 'get', 'pods'],
  ]) {
    writeFileSync(native, JSON.stringify({ ...nativeConfig, users: [{ name: 'selected', user: { 'client-certificate-data': 'Y2VydA==', 'client-key-data': 'a2V5' } }] }));
    calls.length = 0;
    assert.equal((decode((await run(args, alias)).stdout) as any).error.code, 'HOST_TRANSPORT_UNAVAILABLE');
    assert.equal(calls.length, 0);
  }
  for (const [cluster, user] of [
    [{ ...nativeConfig.clusters[0]!.cluster, 'tls-server-name': 'override.invalid' }, nativeConfig.users[0]!.user],
    [nativeConfig.clusters[0]!.cluster, { exec: { apiVersion: 'client.authentication.k8s.io/v1', command: '/never-execute', interactiveMode: 'Never' } }],
  ]) {
    writeFileSync(native, JSON.stringify({ ...nativeConfig, clusters: [{ name: 'selected', cluster }], users: [{ name: 'selected', user }] }));
    assert.equal((decode((await run(['--native-config', native, '--trust-exec', 'get', 'pods'], alias)).stdout) as any).error.code, 'HOST_TRANSPORT_UNAVAILABLE');
  }
  calls.length = 0;
  for (const args of [['prepare', '--', 'exec', 'selected', '--', 'true'], ['prepare', '--', 'attach', 'selected'], ['prepare', '--', 'port-forward', 'selected', '8080:80']]) {
    const worker = fork(new URL('../dist/hosted-session.js', import.meta.url), [], { env: environment, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const closed = once(worker, 'close');
    const failed = once(worker, 'message');
    worker.send({ action: 'start', args, transport: { socketPath: alias, endpoint: origin, capabilities: { clientCertificate: true, serverName: true }, serverName: 'override.invalid' } });
    assert.equal((await failed)[0].code, 'HOST_TRANSPORT_UNAVAILABLE');
    await closed;
  }
  assert.equal(calls.length, 0);
  refusal = true;
  calls.length = 0;
  assert.notEqual((await run(['version'], alias)).code, 0);
  assert(calls.some(call => call.path.split('?')[0] === '/version'));
  refusal = false; redirect = true;
  calls.length = 0;
  assert.notEqual((await run(['version'], alias)).code, 0);
  assert(calls.some(call => call.path.split('?')[0] === '/version'));
  assert(calls.every(call => call.path.split('?')[0] === '/version'));
  redirect = false;
  assert.notEqual((await run(['version'], join(directory, 'missing.sock'))).code, 0);
  holding = true;
  const reached = once(relay, 'request');
  const observeListener = `import { Server } from 'node:http'; const listen = Server.prototype.listen; Server.prototype.listen = function (...args) { this.once('listening', () => process.send({ port: this.address().port })); return listen.apply(this, args); };`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', observeListener + launcher(alias), '--', 'version'], { env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = '';
  child.stdout!.on('data', chunk => { logs += chunk.toString(); });
  child.stderr!.on('data', chunk => { logs += chunk.toString(); });
  const exited = once(child, 'close', { signal: AbortSignal.timeout(15000) });
  const listening = once(child, 'message', { signal: AbortSignal.timeout(15000) });
  const [incoming] = await reached;
  const [{ port }] = await listening as [{ port: number }];
  const workdir = readdirSync(directory).find(name => name.startsWith('kubernetes-axi-'))!;
  const kubeconfigPath = join(directory, workdir, 'config.json');
  assert.equal(statSync(kubeconfigPath).mode & 0o777, 0o600);
  const kubeconfig = JSON.parse(readFileSync(kubeconfigPath, 'utf8'));
  const proxy = new URL(kubeconfig.clusters[0].cluster['proxy-url']);
  const credential = proxy.password;
  assert(credential);
  assert.equal(Number(proxy.port), port);
  const authorization = `Basic ${Buffer.from(`${proxy.username}:${credential}`).toString('base64')}`;
  const secretForms = [credential, authorization.slice(6)];
  if (process.platform === 'linux') {
    const children = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
    assert(children.length > 0);
    for (const pid of [String(child.pid), ...children]) {
      for (const file of ['cmdline', 'environ']) {
        const value = readFileSync(`/proc/${pid}/${file}`, 'utf8');
        for (const secret of secretForms) assert(!value.includes(secret));
      }
    }
  }
  calls.length = 0;
  holding = false;
  for (const proxyAuthorization of [undefined, 'Basic wrong']) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const call = request({ host: '127.0.0.1', port, path: 'http://cluster.invalid:6443/version', headers: proxyAuthorization ? { 'proxy-authorization': proxyAuthorization } : {} }, response => { response.resume(); resolve(response.statusCode); });
      call.on('error', reject);
      call.end();
    });
    assert.equal(status, 403);
  }
  assert.equal(calls.length, 0);
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port, path: 'http://cluster.invalid:6443/version', headers: { 'proxy-authorization': authorization } }, response => { response.resume(); resolve(response.statusCode); });
    call.on('error', reject);
    call.end();
  });
  assert.equal(status, 200);
  assert.deepEqual(calls.map(call => [call.path, call.authorization, call.proxyAuthorization]), [['/version', 'Bearer synthetic-token', undefined]]);
  const disconnected = once(incoming.socket, 'close', { signal: AbortSignal.timeout(15000) });
  child.kill('SIGTERM');
  await exited;
  await disconnected;
  for (const secret of secretForms) assert(!logs.includes(secret));
  console.log(`Host transport passed: ${routeCases} route cases, original identity, relay rotation, refusals and fail-closed reads`);
} finally {
  relay.closeAllConnections();
  await new Promise<void>(resolve => relay.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
}
await import('./transport-tls.ts');
