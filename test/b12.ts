import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, get, request } from 'node:https';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { decode } from '@toon-format/toon';

const [artiumArg, packArg, digest, installed] = process.argv.slice(2);
assert(artiumArg && packArg && digest && installed, 'Expected Artium checkout, evidence pack, package digest and standalone installation');
const artium = resolve(artiumArg);
const pack = resolve(packArg);
const host = (path: string) => import(pathToFileURL(join(artium, path)).href);
const root = await mkdtemp(join(tmpdir(), 'kubernetes-axi-hosted-'));
const calls = join(root, 'calls');
const selected = 'synthetic-selected-token+/=';
const competing = 'synthetic-developer-token+/=';
const cases: { task: string; case: string; operation: string; variant: string; outcome: string }[] = [];
const requests: { path: string; identity: string }[] = [];
const auditLines: string[] = [];
const events = new EventEmitter();
let block = false;

// These are Artium's real server, store, runner and credential adapter modules.
const [{ createApp }, { Runner }, { Audit }, { openStore, createCredentialStore },
  { EnvironmentKeyProvider }, { EmbeddedSecretSource }, { SharedIdentityResolver },
  { createKubernetesAdapter }, { seedToolUser }, { createTestCertificates }] = await Promise.all([
  host('dist/src/server/app.js'), host('dist/src/server/runner/runner.js'),
  host('dist/src/server/audit/audit.js'), host('dist/src/server/store/db.js'),
  host('dist/src/server/store/key-provider.js'), host('dist/src/server/store/secret-source.js'),
  host('dist/src/server/policy/identity-resolver.js'), host('dist/src/server/adapters/kubernetes.js'),
  host('dist/test/fixtures/tokens.js'), host('test/fake-service/certificates.mjs'),
]);
const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') });
const db = openStore(join(root, 'data', 'artium.db'), provider);
const fixture = async (name: string) => JSON.parse(await readFile(join(pack, 'fixtures', name), 'utf8')).body;
const version = await fixture('P-001.json');
const pods = await fixture('P-006.json');
const namespace = pods.items[0].metadata.namespace as string;
const podPath = `/api/v1/namespaces/${namespace}/pods`;
const secretPath = `/api/v1/namespaces/${namespace}/secrets`;
const discovery: Record<string, object> = {
  '/api': { kind: 'APIVersions', apiVersion: 'v1', versions: ['v1'], serverAddressByClientCIDRs: [] },
  '/apis': { kind: 'APIGroupList', apiVersion: 'v1', groups: [] },
  '/api/v1': { kind: 'APIResourceList', apiVersion: 'v1', groupVersion: 'v1', resources: [
    { name: 'pods', singularName: 'pod', namespaced: true, kind: 'Pod', verbs: ['get', 'list'] },
  ] },
};
createTestCertificates(root, ['localhost']);
for (const args of [
  ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'client.key', '-out', 'client.csr', '-subj', '/CN=synthetic-client'],
  ['x509', '-req', '-in', 'client.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'client.crt', '-days', '1'],
]) execFileSync('openssl', args, { cwd: root, stdio: 'pipe', timeout: 10_000 });
const ca = await readFile(join(root, 'ca.crt'), 'utf8');
const privateKey = await readFile(join(root, 'client.key'), 'utf8');
const api = createServer({ key: await readFile(join(root, 'server.key')), cert: await readFile(join(root, 'server.crt')),
  ca, requestCert: true, rejectUnauthorized: false }, (request, response) => {
  const path = new URL(request.url!, 'https://localhost').pathname;
  const socket = request.socket as TLSSocket;
  const identity = socket.authorized && socket.getPeerCertificate().subject.CN === 'synthetic-client'
    ? 'certificate' : (request.headers.authorization ?? '').replace(/^Bearer /, '');
  requests.push({ path, identity });
  if (identity !== selected && identity !== 'certificate') { response.writeHead(401).end(); return; }
  if (block && path === podPath) { events.emit('held'); return; }
  if (request.method !== 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ kind: 'Status', apiVersion: 'v1', status: 'Success' }));
    return;
  }
  const body = path === '/version' ? version : path === podPath ? pods
    : path === secretPath ? { kind: 'SecretList', apiVersion: 'v1', metadata: {}, items: [] } : discovery[path];
  response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? {}));
});
api.listen(0, '127.0.0.1');
await once(api, 'listening');
const address = api.address();
assert(address && typeof address !== 'string');
const origin = `https://localhost:${address.port}`;
const store = createCredentialStore(db, provider);
const runner = await Runner.create(calls);
const adapter = createKubernetesAdapter(new EmbeddedSecretSource(store), join(root, 'writes.log'));
const prepareAdapter = adapter.prepare.bind(adapter);
adapter.prepare = async (...args: Parameters<typeof prepareAdapter>) => {
  const prepared = await prepareAdapter(...args);
  return { ...prepared, environment: { ...prepared.environment, KUBERNETES_AXI_READ_ONLY: 'false' } };
};
const app = createApp({ db, runner, credentialStore: store,
  audit: new Audit(db, Date.now, (line: string) => {
    auditLines.push(line);
    if (JSON.parse(line).event === 'run-terminal') events.emit('terminal');
  }), resolver: new SharedIdentityResolver(store), environment: {},
  adapters: [adapter] });

async function check(caseId: string, operation: string, variant: string, action: () => Promise<void>) {
  await action();
  cases.push({ task: 'B1.2', case: caseId, operation, variant, outcome: 'pass' });
}

async function privateFile(path: string, content: string) {
  await writeFile(path, content, { mode: 0o600 });
}

try {
  // Pin both the artifact and installed runtime before exercising admission.
  const tarball = join(artium, 'tools/fixtures/knowttl-kubernetes-axi-0.1.0.tgz');
  assert.equal(createHash('sha256').update(await readFile(tarball)).digest('hex'), digest, 'Artium must pin this exact package');
  for (const entry of await readdir(installed, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const hosted = join(artium, 'tools/node_modules/@knowttl/kubernetes-axi', relative(installed, path));
    assert.deepEqual(await readFile(hosted), await readFile(path), `Installed package differs: ${relative(installed, path)}`);
  }
  const inventory = JSON.parse(await readFile(join(artium, 'tools/inventories/kubernetes-axi.json'), 'utf8'));
  for (const source of inventory.sources as { path: string; sha256: string }[]) {
    assert.equal(createHash('sha256').update(await readFile(join(artium, 'tools/node_modules/@knowttl/kubernetes-axi', source.path))).digest('hex'), source.sha256);
  }
  await seedToolUser(db);
  db.exec("DELETE FROM role_tools; INSERT INTO role_tools VALUES ('synthetic-role', 'kubernetes-axi'); UPDATE tools SET enabled = 1 WHERE name = 'kubernetes-axi'");
  store.replaceCredential('kubernetes-axi', { origin, auth: 'token', namespace,
    certificateAuthority: ca, token: selected }, 0, 'synthetic-development-user', Date.now());
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const developer = join(root, 'developer');
  await mkdir(join(developer, '.kube'), { recursive: true, mode: 0o700 });
  const kubeconfig = JSON.stringify({ apiVersion: 'v1', kind: 'Config', clusters: [{ name: 'developer', cluster: {
    server: origin, 'certificate-authority-data': Buffer.from(ca).toString('base64'),
  } }], users: [{ name: 'developer', user: { token: competing } }], contexts: [{ name: 'developer',
    context: { cluster: 'developer', user: 'developer', namespace } }], 'current-context': 'developer' });
  const poison = join(developer, '.kube/config');
  await privateFile(poison, kubeconfig);
  await privateFile(join(developer, 'config.json'), JSON.stringify({ version: 1, profiles: { developer: {
    origin, auth: 'token', certificateAuthority: ca, token: { env: 'DEVELOPER_TOKEN' },
  } }, defaultProfile: 'developer' }));
  // Poison the actual server environment as well as the remote client's home.
  process.env.HOME = developer;
  process.env.KUBECONFIG = poison;
  process.env.KUBERNETES_AXI_CONFIG = join(developer, 'config.json');
  process.env.KUBERNETES_AXI_TOKEN = competing;
  process.env.DEVELOPER_TOKEN = competing;
  const environment = { PATH: process.env.PATH!, HOME: developer, XDG_CONFIG_HOME: join(root, 'client'),
    KUBECONFIG: poison, KUBERNETES_AXI_CONFIG: join(developer, 'config.json'), DEVELOPER_TOKEN: competing,
    ARTIUM_AXI_URL: url, ARTIUM_AXI_TEST_HTTP: '1' };
  const client = join(artium, 'dist/cli/artium-axi.mjs');
  async function cli(args: string[]) {
    const child = spawn(process.execPath, [client, ...args], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on('data', (bytes: Buffer) => out.push(bytes));
    child.stderr.on('data', (bytes: Buffer) => err.push(bytes));
    child.stdin.end(args[0] === 'login' ? 'CANARY-local-password' : undefined);
    const [code] = await once(child, 'close');
    const stdout = Buffer.concat(out).toString(), stderr = Buffer.concat(err).toString();
    assert(!stdout.includes(selected) && !stderr.includes(selected), 'Public streams must not contain the injected token');
    assert(!stdout.includes(competing) && !stderr.includes(competing), 'Public streams must not contain the developer token');
    return { code, stdout, stderr };
  }
  assert.equal((await cli(['login', '--username', 'synthetic-user', '--password-stdin'])).code, 0);
  const upstream = (token: string, path: string) => new Promise<number | undefined>((resolveStatus, reject) => {
    get(origin + path, { ca, headers: { authorization: `Bearer ${token}` } }, response => {
      response.resume(); response.on('end', () => resolveStatus(response.statusCode));
    }).on('error', reject);
  });
  await check('CC-008', 'OP-006', 'fake rejects competing developer identity', async () => {
    assert.equal(await upstream(competing, podPath), 401);
    assert.equal(await upstream(selected, secretPath), 200, 'Injected upstream identity deliberately has broader access');
  });
  for (const replay of [
    { caseId: 'AC-001', operation: 'OP-001', args: ['version'], expected: { gitVersion: version.gitVersion } },
    { caseId: 'AC-006', operation: 'OP-006', args: ['get', 'pods', '--namespace', namespace], expected: {
      pods: pods.items.map((pod: { metadata: { name: string; namespace: string }; status: { phase: string } }) => ({
        name: pod.metadata.name, namespace: pod.metadata.namespace, phase: pod.status.phase,
      })), continue: pods.metadata.continue, resourceVersion: pods.metadata.resourceVersion,
      remainingItemCount: pods.metadata.remainingItemCount,
    } },
  ]) {
    await check(replay.caseId, replay.operation, 'retained response through real Artium CLI', async () => {
      requests.length = 0;
      const result = await cli(['kubernetes-axi', ...replay.args]);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const output = decode(result.stdout) as Record<string, unknown>;
      for (const [key, value] of Object.entries(replay.expected)) assert.deepEqual(output[key], value);
      assert.equal(output.source, 'file:artium');
      assert(requests.length > 0);
      assert(requests.every(request => request.identity === selected));
      assert.deepEqual(await readdir(calls), []);
    });
  }
  await check('AC-RBAC-001', 'OP-006', 'ungranted caller denied by host before forwarding', async () => {
    db.exec('DELETE FROM role_tools');
    requests.length = 0;
    const result = await cli(['kubernetes-axi', 'get', 'pods', '--namespace', namespace]);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /TOOL_NOT_GRANTED/);
    assert.deepEqual(requests, []);
    assert.deepEqual(db.prepare("SELECT outcome FROM audit WHERE event = 'denial' ORDER BY id DESC LIMIT 1").get(), { outcome: 'TOOL_NOT_GRANTED' });
    db.exec("INSERT INTO role_tools VALUES ('synthetic-role', 'kubernetes-axi')");
  });
  await check('AC-RBAC-001', 'OP-024', 'broad synthetic upstream identity accepts writes independently of host grants', async () => {
    const status = await new Promise<number | undefined>((resolveStatus, reject) => {
      const call = request(origin + '/apis/apps/v1/namespaces/synthetic/deployments/selected/scale', {
        ca, method: 'PATCH', headers: { authorization: `Bearer ${selected}`, 'content-type': 'application/merge-patch+json' },
      }, response => { response.resume(); response.on('end', () => resolveStatus(response.statusCode)); });
      call.on('error', reject); call.end('{"spec":{"replicas":2}}');
    });
    assert.equal(status, 200);
  });
  for (const args of [
    ['native', '--', 'scale', 'deployment/selected', '--replicas=2'],
    ['native', '--', 'exec', 'selected', '--', 'synthetic-command'],
    ['native', '--', 'create', 'token', 'selected'],
  ]) await check('AC-RBAC-001', 'OP-024', `host policy denies ${args.join(' ')} with package writes enabled`, async () => {
    requests.length = 0;
    const result = await cli(['kubernetes-axi', ...args]);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /FLAG_BLOCKED/);
    assert.doesNotMatch(result.stdout, /Unknown command/);
    assert.deepEqual(requests, []);
    assert.deepEqual(await readdir(calls), []);
  });
  for (const flag of ['config', 'profile', 'native-config', 'trust-exec', 'kubeconfig', 'server', 'context', 'user', 'token', 'as', 'as-group', 'as-uid',
    'certificate-authority', 'client-certificate', 'client-key', 'insecure-skip-tls-verify']) {
    for (const override of [[`--${flag}`, 'synthetic-override'], [`--${flag}=synthetic-override`]]) {
      await check('CC-010', 'OP-006', override.join(' '), async () => {
        requests.length = 0;
        const result = await cli(['kubernetes-axi', 'get', 'pods', ...override]);
        assert.notEqual(result.code, 0);
        assert.match(result.stdout, /FLAG_BLOCKED/);
        assert.deepEqual(requests, []);
        assert.deepEqual(await readdir(calls), []);
      });
    }
  }
  for (const auth of ['token', 'certificate']) {
    if (auth === 'certificate') store.replaceCredential('kubernetes-axi', { origin, auth, namespace,
      certificateAuthority: ca, clientCertificate: await readFile(join(root, 'client.crt'), 'utf8'),
      privateKey }, 1, 'synthetic-development-user', Date.now());
    await check('CC-014', 'OP-006', `${auth} cancellation removes private profile, keys and kubeconfig`, async () => {
    block = true;
    const signal = AbortSignal.timeout(20_000);
    const reached = once(events, 'held', { signal });
    const finished = once(events, 'terminal', { signal });
    const child = spawn(process.execPath, [client, 'kubernetes-axi', 'get', 'pods', '--namespace', namespace], {
      env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    child.stdout.on('data', (bytes: Buffer) => output.push(bytes));
    child.stderr.on('data', (bytes: Buffer) => output.push(bytes));
    const closed = once(child, 'close', { signal });
    try {
      await reached;
      const files = await readdir(calls, { recursive: true });
      assert(files.some(file => file.endsWith('kubernetes-axi/config.json')), 'Host profile must exist during the call');
      assert(files.some(file => /tmp\/kubernetes-axi-[^/]+\/config.json$/.test(file)), 'Native kubeconfig must be beneath call TMPDIR');
      if (auth === 'certificate') {
        const native = files.find(file => /tmp\/kubernetes-axi-[^/]+\/config.json$/.test(file))!;
        const config = JSON.parse(await readFile(join(calls, native), 'utf8'));
        assert.equal(Buffer.from(config.users[0].user['client-key-data'], 'base64').toString(), privateKey);
      }
      child.kill('SIGTERM');
      await closed;
      await finished;
      const streams = Buffer.concat(output).toString();
      for (const secret of [selected, competing, privateKey, Buffer.from(privateKey).toString('base64')]) {
        assert(!streams.includes(secret), 'Cancellation must not expose credentials in public streams');
      }
      assert.deepEqual(db.prepare("SELECT outcome FROM audit WHERE event = 'run-terminal' ORDER BY id DESC LIMIT 1").get(), { outcome: 'CANCELLED' });
      assert.deepEqual(await readdir(calls), [], 'Cancellation must remove all host profiles, keys, caches and native kubeconfigs');
    } finally { child.kill('SIGKILL'); block = false; }
    });
  }
  assert.equal(await readFile(poison, 'utf8'), kubeconfig, 'Developer kubeconfig remains untouched');
  const journal = auditLines.join('');
  assert(!journal.includes(selected) && !journal.includes(competing));
  assert(!journal.includes(privateKey) && !journal.includes(Buffer.from(privateKey).toString('base64')));
  assert.equal(await readFile(join(root, 'writes.log'), 'utf8').catch(() => ''), '');
  console.log(JSON.stringify({ outcome: 'pass', cases, publicPath: 'real Artium CLI -> local server -> installed package -> pinned kubectl -> TLS fake',
    policyScope: 'Pod-read-only host admission denies native scale, execution and token issuance before forwarding, independently of package write enablement and broader synthetic upstream permissions', packageSha256: digest }));
} finally {
  await app.close();
  api.closeAllConnections();
  await new Promise<void>(resolveClose => api.close(() => resolveClose()));
  db.close();
  await chmod(root, 0o700);
  await rm(root, { recursive: true, force: true });
}
