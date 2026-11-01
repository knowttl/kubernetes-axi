import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync, symlinkSync, readdirSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { decode } from '@toon-format/toon';
import { mutationFixture, checkMutations } from './b3.ts';
import { remoteFixture, checkRemote, executionToken } from './remote.ts';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const pack = process.argv.includes('--pack') ? resolve(process.argv[process.argv.indexOf('--pack') + 1]!) : join(root, 'evidence');
// Running the whole harness in an empty network namespace denies outbound calls
// for Node, npm and every real kubectl child, including any attempted DNS lookup.
assert.equal(process.platform, 'linux', 'B2 native test evidence currently requires Linux network namespaces; other hosts remain pending');
assert.equal(readFileSync('/proc/net/route', 'utf8').trim().split('\n').length, 1, 'Run under unshare --user --map-root-user --net with only loopback enabled');
const directory = mkdtempSync(join(tmpdir(), 'kubernetes-axi-b2-'));
const hashes = JSON.parse(readFileSync(join(root, 'evidence/fixture-hashes.json'), 'utf8')) as Record<string, string>;
for (const [file, hash] of Object.entries(hashes)) assert.equal(createHash('sha256').update(readFileSync(join(pack, file))).digest('hex'), hash, file);
interface Envelope { status: number; headers: Record<string, string>; body: any }
const fixtures = Object.fromEntries(Object.keys(hashes).map(file => [file.split('/').at(-1)!.replace('.json', ''), JSON.parse(readFileSync(join(pack, file), 'utf8')) as Envelope]));
const fixture = (id: string): Envelope => structuredClone(fixtures[id]!);
const openssl = (...args: string[]): void => { execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' }); };
openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=synthetic-ca');
openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1');
openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '1', '-copy_extensions', 'copy');
chmodSync(join(directory, 'ca.crt'), 0o644);

const apiGroup = (name: string, version: string) => ({ name, versions: [{ groupVersion: `${name}/${version}`, version }], preferredVersion: { groupVersion: `${name}/${version}`, version } });
const resource = (name: string, kind: string, namespaced: boolean, shortNames: string[] = []) => ({ name, singularName: kind.toLowerCase(), kind, namespaced, shortNames, verbs: ['get', 'list'] });
const discovery = (groupVersion: string, resources: object[]) => ({ kind: 'APIResourceList', apiVersion: 'v1', groupVersion, resources });
const core = discovery('v1', [resource('pods', 'Pod', true, ['po']), resource('namespaces', 'Namespace', false, ['ns']), resource('nodes', 'Node', false, ['no']), resource('events', 'Event', true, ['ev'])]);
const groups = fixture('P-003').body;
groups.groups.push(apiGroup('metrics.k8s.io', 'v1beta1'), apiGroup('synthetic.example', 'v1'));
groups.groups.at(-1).versions.push({ groupVersion: 'synthetic.example/v1beta1', version: 'v1beta1' });
groups.groups.push(apiGroup('networking.k8s.io', 'v1'));
const requests: string[] = [];
const identities: string[] = [];
const helperTokens = ['synthetic-helper-first&+/=', 'synthetic-helper-renewed&+/='];
let variant = '';
let cancelRequest: (() => void) | undefined;
let override: { path: string; envelope: Envelope | 'malformed' | 'timeout' | 'oversize' } | undefined;
const nativePrefix = '/k8s/clusters/c1';
const rootDecoy = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'prefixed', namespace: 'synthetic-b3', uid: 'root-decoy', resourceVersion: '1' }, data: { value: 'root-decoy' } };
const server = createServer({ key: readFileSync(join(directory, 'server.key')), cert: readFileSync(join(directory, 'server.crt')) }, (request, response) => {
  requests.push(request.url!);
  if (request.url!.startsWith(nativePrefix + '/')) request.url = request.url!.slice(nativePrefix.length);
  const url = new URL(request.url!, 'https://127.0.0.1');
  const path = url.pathname;
  if (variant === 'cancel') { cancelRequest?.(); return; }
  const send = (envelope: Envelope): void => {
    response.writeHead(envelope.status, { 'Content-Type': 'application/json', ...envelope.headers });
    response.end(typeof envelope.body === 'string' ? envelope.body : JSON.stringify(envelope.body));
  };
  const json = (body: any): void => send({ status: 200, headers: { 'Content-Type': 'application/json' }, body });
  const page = (id: string): void => {
    const envelope = fixture(id);
    if (url.searchParams.has('continue')) envelope.body = { ...envelope.body, metadata: { resourceVersion: envelope.body.metadata.resourceVersion }, items: [] };
    send(envelope);
  };
  identities.push(request.headers.authorization ?? '');
  if (remoteFixture(request, response)) return;
  if (!['synthetic-selected-token', executionToken, ...helperTokens].some(token => request.headers.authorization === `Bearer ${token}`)) return send({ status: 401, headers: {}, body: { kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'Unauthorized', message: 'Unauthorized', code: 401 } });
  if (variant === 'native-prefix' && !requests.at(-1)!.startsWith(nativePrefix + '/') && path.startsWith('/api/v1/namespaces/synthetic-b3/configmaps')) {
    if (request.method !== 'GET') rootDecoy.data.value = 'wrong-cluster-write';
    return json(rootDecoy);
  }
  if (override?.path === path) {
    if (override.envelope === 'timeout') return; // Server remains open until the client's real deadline cancels it.
    if (override.envelope === 'malformed') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{broken'); return; }
    if (override.envelope === 'oversize') { response.writeHead(200); response.end('x'.repeat(5 * 1024 * 1024)); return; }
    return send(override.envelope);
  }
  if (mutationFixture(request, response, variant === 'native-prefix' && request.method === 'PATCH')) return;
  if (path === '/version') return send(fixture('P-001'));
  if (path === '/api') return send(fixture('P-002'));
  if (path === '/apis') return json(groups);
  if (path === '/api/v1') return json(core);
  if (path === '/apis/apps/v1') return json(discovery('apps/v1', [resource('deployments', 'Deployment', true, ['deploy'])]));
  if (path === '/apis/metrics.k8s.io/v1beta1') return json(discovery('metrics.k8s.io/v1beta1', [resource('nodes', 'NodeMetrics', false), resource('pods', 'PodMetrics', true)]));
  if (path === '/apis/synthetic.example/v1') return json(discovery('synthetic.example/v1', []));
  if (path === '/apis/synthetic.example/v1beta1') return json(discovery('synthetic.example/v1beta1', [resource('widgets', 'Widget', true, ['wd'])]));
  if (path.split('/').length === 4 && path.startsWith('/apis/')) return json(discovery(path.slice(6), []));
  if (path === '/api/v1/namespaces') return page(variant === 'namespace-filter' ? 'P-011' : 'P-004');
  if (path === '/api/v1/namespaces/kube-system') return json({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'kube-system' }, status: { phase: 'Active' } });
  if (path === '/api/v1/nodes') {
    if (variant === 'metrics') return json({ kind: 'NodeList', apiVersion: 'v1', metadata: {}, items: [{ metadata: { name: 'synthetic-node' }, status: { allocatable: { cpu: '1', memory: '1Gi' }, capacity: { cpu: '1', memory: '1Gi' } } }] });
    return page('P-005');
  }
  if (path === '/api/v1/namespaces/kube-system/events') return send(fixture('P-007'));
  if (path === '/apis/apps/v1/namespaces/default/deployments') return send(fixture('P-008'));
  if (path === '/api/v1/namespaces/kube-system/pods/resource-008/log') return send(fixture('P-010'));
  if (path === '/api/v1/namespaces/kube-system/pods/axi-design-nonexistent-probe') return send(fixture('P-012'));
  if (path === '/api/v1/namespaces/kube-system/pods/resource-008') return json({ apiVersion: 'v1', kind: 'Pod', ...fixture('P-006').body.items[0] });
  if (path === '/api/v1/namespaces/kube-system/pods') return page('P-006');
  if (path === '/apis/metrics.k8s.io/v1beta1/nodes') return send(fixture('metrics-node-success'));
  if (path === '/apis/metrics.k8s.io/v1beta1/namespaces/synthetic-space/pods') return send(fixture('metrics-pod-success'));
  if (path === '/apis/synthetic.example/v1beta1/namespaces/kube-system/widgets') return json({ kind: 'WidgetList', apiVersion: 'synthetic.example/v1beta1', metadata: {}, items: [{ metadata: { name: 'synthetic-widget', namespace: 'kube-system' } }] });
  if (path === '/api/v1/namespaces/decoy/pods') return json({ kind: 'PodList', apiVersion: 'v1', metadata: {}, items: [{ metadata: { name: 'decoy-pod', namespace: 'decoy' }, status: { phase: 'Pending' } }] });
  if (path === '/openapi/v3') return json({ paths: { 'api/v1': { serverRelativeURL: '/openapi/v3/api/v1?hash=synthetic' } } });
  if (path === '/openapi/v3/api/v1') return json({ openapi: '3.0.0', info: { title: 'Synthetic schema', version: 'v1' }, paths: {
    '/api/v1/namespaces/{namespace}/pods': { get: { 'x-kubernetes-group-version-kind': { group: '', version: 'v1', kind: 'Pod' }, responses: { '200': { description: 'A pod list' } } } },
  }, components: { schemas: {
    'io.k8s.api.core.v1.Pod': { type: 'object', description: 'Synthetic pod schema', 'x-kubernetes-group-version-kind': [{ group: '', version: 'v1', kind: 'Pod' }], properties: { metadata: { type: 'object', description: 'Object identity' }, spec: { type: 'object', description: 'Pod specification' } } },
  } } });
  send({ status: 404, headers: { 'Content-Type': 'application/json' }, body: { kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'NotFound', message: 'NotFound', code: 404 } });
});
server.requestTimeout = 15_000;
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address();
assert(address && typeof address !== 'string');
const config = join(directory, 'config.json');
writeFileSync(config, JSON.stringify({ version: 1, defaultProfile: 'selected', profiles: { selected: {
  origin: `https://127.0.0.1:${address.port}`, auth: 'token', namespace: 'kube-system', certificateAuthority: readFileSync(join(directory, 'ca.crt'), 'utf8'), token: { env: 'SYNTHETIC_TOKEN' },
} } }), { mode: 0o600 });
const prefix = join(directory, 'installed');
const npm = 'npm';
const packed = JSON.parse(execFileSync(npm, ['pack', '--offline', '--json', '--pack-destination', directory], { cwd: root, encoding: 'utf8' }));
execFileSync(npm, ['install', '--offline', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(directory, packed[0].filename)], { stdio: 'pipe' });
const installed = join(prefix, 'node_modules/@knowttl/kubernetes-axi');
const cli = join(installed, 'bin/kubernetes-axi.js');
const temporary = join(directory, 'invocations');
mkdirSync(temporary, { mode: 0o700 });
const environment: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('KUBERNETES_') && key !== 'KUBECONFIG')),
  HOME: directory, USERPROFILE: directory, APPDATA: directory, XDG_CONFIG_HOME: directory,
  TMPDIR: temporary, TMP: temporary, TEMP: temporary,
  KUBERNETES_AXI_CONFIG: config, SYNTHETIC_TOKEN: 'synthetic-selected-token', KUBECONFIG: join(directory, 'poison-kubeconfig'),
  KUBERNETES_AXI_READ_ONLY: 'true',
};
const cases: { case: string; outcome: string }[] = [];
const run = async (args: string[], executable = cli): Promise<{ code: number; stdout: string; stderr: string }> => {
  try { const result = await execute('node', [executable, ...args], { env: environment, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }); return { code: 0, ...result }; }
  catch (error) { const result = error as { code: number; stdout: string; stderr: string }; return { code: result.code, stdout: result.stdout, stderr: result.stderr }; }
};
const check = async (id: string, test: () => Promise<void>): Promise<void> => {
  const filter = process.argv.indexOf('--case');
  if (filter >= 0 && !new RegExp(process.argv[filter + 1]!).test(id)) return;
  requests.length = 0; override = undefined; variant = '';
  try { await test(); cases.push({ case: id, outcome: 'pass' }); }
  catch (error) { cases.push({ case: id, outcome: 'failure' }); console.error(id, error); process.exitCode = 1; }
};
const compact = async (...args: string[]): Promise<any> => {
  const result = await run(args); assert.equal(result.code, 0, result.stdout); assert.equal(result.stderr, ''); return decode(result.stdout);
};
const nativeFile = join(directory, 'native.json');
const decoyFile = join(directory, 'decoy.json');
const nativeSettings = {
  apiVersion: 'v1', kind: 'Config',
  clusters: [{ name: 'local', cluster: { server: `https://127.0.0.1:${address.port}`, 'certificate-authority-data': readFileSync(join(directory, 'ca.crt')).toString('base64') } }],
  users: [{ name: 'local', user: { token: 'synthetic-selected-token' } as Record<string, unknown> }],
  contexts: [{ name: 'local', context: { cluster: 'local', user: 'local', namespace: 'kube-system' } }, { name: 'other', context: { cluster: 'local', user: 'local', namespace: 'decoy' } }],
  'current-context': 'local',
};
writeFileSync(nativeFile, JSON.stringify(nativeSettings), { mode: 0o600 });
writeFileSync(decoyFile, JSON.stringify({ ...nativeSettings, 'current-context': 'other' }), { mode: 0o600 });
const local = async (test: () => Promise<void>): Promise<void> => {
  const selected = environment.KUBERNETES_AXI_CONFIG;
  delete environment.KUBERNETES_AXI_CONFIG;
  try { await test(); } finally { environment.KUBERNETES_AXI_CONFIG = selected; }
};
try {
  if (!process.argv.includes('--b3-only')) {
  await check('CC-008/014-cancellation-cleanup', async () => {
    variant = 'cancel';
    const arrived = new Promise<void>(done => { cancelRequest = done; });
    let child: ReturnType<typeof execFile>;
    const finished = new Promise<void>(done => {
      child = execFile(process.execPath, [cli, 'get', 'pods'], { env: environment, timeout: 20_000 }, () => done());
    });
    await arrived;
    child!.kill('SIGTERM');
    await finished;
    assert.deepEqual(readdirSync(temporary), []);
    cancelRequest = undefined;
  });
  await check('CC-005-private-inputs', async () => {
    const link = join(directory, 'redirected-config'); symlinkSync(config, link);
    for (const path of [link, config]) {
      if (path === config) chmodSync(config, 0o666);
      try { const result = await run(['--config', path, 'get', 'pods']); assert.equal((decode(result.stdout) as any).error.code, 'CONFIG_INSECURE'); assert.equal(requests.length, 0); }
      finally { chmodSync(config, 0o600); }
    }
  });
  await check('CC-002-partial-environment', async () => {
    environment.KUBERNETES_AXI_ORIGIN = nativeSettings.clusters[0]!.cluster.server;
    try { const result = await run(['get', 'pods']); assert.equal((decode(result.stdout) as any).error.code, 'CONFIG_INVALID'); assert.equal(requests.length, 0); }
    finally { delete environment.KUBERNETES_AXI_ORIGIN; }
  });
  await check('CC-001-profile-isolation', async () => {
    environment.KUBERNETES_AXI_ORIGIN = 'https://poison.invalid';
    try { assert.equal((await compact('--profile', 'selected', 'get', 'pods')).source, 'file:selected'); }
    finally { delete environment.KUBERNETES_AXI_ORIGIN; }
  });
  await check('CC-001-file-selection-precedence', async () => {
    const original = readFileSync(config);
    const settings = JSON.parse(original.toString());
    settings.profiles.decoy = { ...settings.profiles.selected, namespace: 'decoy' };
    try {
      writeFileSync(config, JSON.stringify(settings));
      environment.KUBERNETES_AXI_PROFILE = 'decoy';
      assert.equal((await compact('get', 'pods')).pods[0].name, 'decoy-pod');
      assert.equal((await compact('--profile', 'selected', 'get', 'pods')).pods[0].name, 'resource-008');
      delete environment.KUBERNETES_AXI_PROFILE;
      assert.equal((await compact('get', 'pods')).source, 'file:selected');
      delete settings.defaultProfile; writeFileSync(config, JSON.stringify(settings));
      const ambiguous = await run(['get', 'pods']); assert.equal((decode(ambiguous.stdout) as any).error.code, 'PROFILE_AMBIGUOUS');
      const missing = await run(['--profile', 'missing', 'get', 'pods']); assert.equal((decode(missing.stdout) as any).error.code, 'PROFILE_NOT_FOUND');
      settings.profiles = {}; writeFileSync(config, JSON.stringify(settings));
      const empty = await run(['get', 'pods']); assert.equal((decode(empty.stdout) as any).error.code, 'PROFILE_REQUIRED');
    } finally { delete environment.KUBERNETES_AXI_PROFILE; writeFileSync(config, original); }
  });
  await check('standard-diagnostics', async () => {
    assert.equal((await compact('auth', 'status')).secretSource.env, 'SYNTHETIC_TOKEN');
    assert.deepEqual((await compact('profile', 'list')).profiles, [{ name: 'selected', default: true }]);
    assert.equal((await compact('config', 'path')).path, config);
    assert.equal(requests.length, 0);
  });
  await check('CC-009-native-selection', async () => local(async () => {
    const saved = environment.KUBECONFIG;
    environment.KUBECONFIG = `${decoyFile}:${nativeFile}`;
    const original = readFileSync(nativeFile);
    try {
      const result = await run(['--native-config', 'ambient', 'native', '--', '--context=local', 'get', 'pods', '-o', 'json']);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.items[0].metadata.name, 'resource-008');
      assert.equal((await compact('--native-config', 'ambient', 'get', 'pods')).pods[0].name, 'decoy-pod');
      assert.deepEqual(readFileSync(nativeFile), original);
      const relative = structuredClone(nativeSettings) as any;
      delete relative.clusters[0].cluster['certificate-authority-data'];
      relative.clusters[0].cluster['certificate-authority'] = 'ca.crt';
      writeFileSync(nativeFile, JSON.stringify(relative));
      assert.equal((await compact('--native-config', nativeFile, 'get', 'pods')).pods[0].name, 'resource-008');
      assert.deepEqual(readdirSync(temporary), []);
    } finally { environment.KUBECONFIG = saved; writeFileSync(nativeFile, original); }
  }));
  await check('CC-009-native-impersonation-refused', async () => local(async () => {
    const original = readFileSync(nativeFile);
    try {
      for (const [field, value] of [['as', 'administrator'], ['as-uid', 'synthetic-uid'], ['as-groups', ['system:masters']], ['as-user-extra', { scope: ['synthetic'] }]] as const) {
        const settings = structuredClone(nativeSettings);
        settings.users[0]!.user[field] = value;
        writeFileSync(nativeFile, JSON.stringify(settings));
        for (const args of [['get', 'pods'], ['native', '--', 'get', 'pods']]) {
          const result = await run(['--native-config', nativeFile, ...args]);
          assert.equal(result.code, 2, result.stdout + result.stderr);
          assert.deepEqual((decode(result.stdout) as any).error, { code: 'USAGE', message: 'Native kubeconfig impersonation is unavailable under the isolated bounded-read policy (impersonation).' });
          assert.equal(requests.length, 0);
          assert.deepEqual(readdirSync(temporary), []);
        }
      }
    } finally { writeFileSync(nativeFile, original); }
  }));
  await check('CC-009-native-source-edit', async () => local(async () => {
    const original = readFileSync(nativeFile);
    const decoy = readFileSync(decoyFile);
    environment.KUBERNETES_AXI_READ_ONLY = 'false';
    try {
      const result = await run(['--native-config', nativeFile, 'native', '--', 'config', 'use-context', 'other']);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const current = await run(['--native-config', nativeFile, 'native', '--', 'config', 'current-context']);
      assert.equal(current.stdout, 'other\n'); assert.deepEqual(readFileSync(decoyFile), decoy); assert.equal(requests.length, 0);
      const beforeFailure = readFileSync(nativeFile);
      const failure = await run(['--native-config', nativeFile, 'native', '--', 'config', 'use-context', 'missing']);
      assert.notEqual(failure.code, 0); assert.deepEqual(readFileSync(nativeFile), beforeFailure);
    } finally { writeFileSync(nativeFile, original); environment.KUBERNETES_AXI_READ_ONLY = 'true'; }
  }));
  await check('R10-helper-mutations-refused-before-acquisition', async () => local(async () => {
    const original = readFileSync(nativeFile);
    const counter = join(directory, 'mutation-helper-count');
    const helper = structuredClone(nativeSettings);
    helper.users[0]!.user = { exec: { apiVersion: 'client.authentication.k8s.io/v1', command: process.execPath, args: [join(root, 'test/credential-helper.ts')], interactiveMode: 'Never', provideClusterInfo: true,
      env: [{ name: 'SYNTHETIC_HELPER_COUNTER', value: counter }] } };
    writeFileSync(nativeFile, JSON.stringify(helper));
    writeFileSync(counter, '0');
    environment.KUBERNETES_AXI_READ_ONLY = 'false';
    try {
      for (const trust of [[], ['--trust-exec']]) {
        for (const args of [
          ['prepare', '--', 'patch', 'configmap', 'selected', '-n', 'synthetic-b3', '--type=merge', '-p', '{"data":{"value":"after"}}'],
          ['server-dry-run', '--', 'create', 'configmap', 'helper-created', '--from-literal=value=after'],
          ['confirm', '00000000-0000-0000-0000-000000000000', '--digest', '0'.repeat(64)],
        ]) {
          const result = await run(['--native-config', nativeFile, ...trust, ...args]);
          assert.equal(result.code, 1, result.stdout + result.stderr);
          const failure = (decode(result.stdout) as any).error;
          assert.equal(failure.code, 'AUTH_HELPER_MUTATION_UNAVAILABLE');
          assert.match(failure.message, /ExecCredential.*principal binding/);
          assert.equal(requests.length, 0);
          assert.equal(readFileSync(counter, 'utf8'), '0');
        }
      }
      const identity = await compact('--native-config', nativeFile, '--trust-exec', 'auth', 'whoami');
      assert.equal(identity.reviews[0].status.userInfo.username, 'synthetic-identity');
      const access = await compact('--native-config', nativeFile, '--trust-exec', 'auth', 'can-i', 'get', 'pods');
      assert.equal(access.reviews[0].status.allowed, true);
    } finally { writeFileSync(nativeFile, original); environment.KUBERNETES_AXI_READ_ONLY = 'true'; }
  }));
  await check('CC-012-helper-renewal-redaction', async () => local(async () => {
    const original = readFileSync(nativeFile);
    const counter = join(directory, 'helper-count');
    const helper = structuredClone(nativeSettings);
    helper.users[0]!.user = { exec: { apiVersion: 'client.authentication.k8s.io/v1', command: process.execPath, args: [join(root, 'test/credential-helper.ts')], interactiveMode: 'Never', provideClusterInfo: true,
      env: [{ name: 'SYNTHETIC_HELPER_COUNTER', value: counter }] } };
    writeFileSync(nativeFile, JSON.stringify(helper));
    identities.length = 0;
    override = { path: '/api/v1/namespaces/kube-system/pods', envelope: { status: 200, headers: {}, body: { kind: 'PodList', apiVersion: 'v1', metadata: { continue: helperTokens.flatMap(token => [token, encodeURIComponent(token), Buffer.from(token).toString('base64')]).join('|') }, items: [] } } };
    try {
      const untrusted = await run(['--native-config', nativeFile, 'get', 'pods']);
      assert.equal((decode(untrusted.stdout) as any).error.code, 'AUTH_HELPER_UNTRUSTED'); assert.equal(requests.length, 0);
      const result = await run(['--native-config', nativeFile, '--trust-exec', 'get', 'pods']);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal((decode(result.stdout) as any).continue, Array(6).fill('[REDACTED]').join('|'));
      assert(identities.includes(`Bearer ${helperTokens[0]}`)); assert(identities.includes(`Bearer ${helperTokens[1]}`));
      assert(Number(readFileSync(counter, 'utf8')) >= 2);
      writeFileSync(counter, '0');
      override = { path: '/api/v1/namespaces/kube-system/pods/resource-008/log', envelope: { status: 200, headers: { 'Content-Type': 'text/plain' }, body: helperTokens.flatMap(token => [token, encodeURIComponent(token), Buffer.from(token).toString('base64')]).join('|') } };
      const native = await run(['--native-config', nativeFile, '--trust-exec', 'native', '--', 'logs', 'resource-008']);
      assert.equal(native.code, 0, native.stdout + native.stderr);
      assert.equal(native.stdout, Array(6).fill('[REDACTED]').join('|'));
      writeFileSync(counter, '0');
      override = { path: '/api/v1/namespaces/kube-system/pods', envelope: { status: 200, headers: {}, body: { kind: 'PodList', apiVersion: 'v1', metadata: {}, items: helperTokens.map(token => ({ metadata: { name: 'synthetic-pod', namespace: 'kube-system', annotations: { synthetic: token } } })) } } };
      const nativeJson = await run(['--native-config', nativeFile, '--trust-exec', 'native', '--', 'get', 'pods', '-o', 'json']);
      assert.equal(nativeJson.code, 0, nativeJson.stdout + nativeJson.stderr);
      assert.deepEqual(JSON.parse(nativeJson.stdout).items.map((item: any) => item.metadata.annotations.synthetic), ['[REDACTED]', '[REDACTED]']);
      environment.SYNTHETIC_HELPER_FAILURE = 'true';
      const failure = await run(['--native-config', nativeFile, '--trust-exec', 'native', '--', 'get', 'pods']);
      assert.notEqual(failure.code, 0); assert(!`${failure.stdout}${failure.stderr}`.includes(helperTokens[0]!));
      assert.deepEqual(readdirSync(temporary), []);
    } finally { delete environment.SYNTHETIC_HELPER_FAILURE; writeFileSync(nativeFile, original); }
  }));
  const lists = [
    ['AC-004', 'P-004', 'namespaces', undefined, 'phase'],
    ['AC-005', 'P-005', 'nodes', undefined, 'ready'],
    ['AC-006', 'P-006', 'pods', 'kube-system', 'phase'],
    ['AC-007', 'P-007', 'events', 'kube-system', undefined],
    ['AC-008', 'P-008', 'deployments', 'default', 'desired'],
  ] as const;
  for (const [id, retained, type, namespace, field] of lists) await check(id, async () => {
    const args = ['get', type, ...(namespace ? ['-n', namespace] : [])];
    const expected = fixture(retained).body;
    const output = await compact(...args);
    assert.deepEqual(output[type].map((item: any) => item.name), expected.items.map((item: any) => item.metadata.name));
    assert.equal(output.continue, expected.metadata.continue ?? '');
    assert.equal(output.complete, !expected.metadata.continue);
    if (field === 'phase') assert.equal(output[type][0].phase, expected.items[0].status.phase);
    if (field === 'ready') assert.equal(output[type][0].ready, expected.items[0].status.conditions.find((condition: any) => condition.type === 'Ready').status);
    if (field === 'desired') assert.equal(output[type][0].desired, expected.items[0].spec.replicas);
    const native = await run(['native', '--', ...args, '-o', 'json']);
    assert.equal(native.code, 0, native.stderr);
    assert.deepEqual(JSON.parse(native.stdout).items.map((item: any) => item.metadata.name), expected.items.map((item: any) => item.metadata.name));
  });
  await check('AC-011-PRESENT', async () => {
    const output = await compact('get', 'pod', 'resource-008');
    assert.deepEqual(output.pods, [{ name: 'resource-008', namespace: 'kube-system', phase: 'Running' }]);
    const native = await run(['native', '--', 'get', 'pod', 'resource-008', '-o', 'json']);
    assert.equal(native.code, 0, native.stderr); assert.equal(JSON.parse(native.stdout).metadata.name, 'resource-008');
  });
  for (const [id, args, path, envelope, code] of [
    ['AC-011', ['get', 'pods', 'axi-design-nonexistent-probe'], '/api/v1/namespaces/kube-system/pods/axi-design-nonexistent-probe', fixture('P-012'), 'RESOURCE_NOT_FOUND'],
    ['AC-009', ['top', 'node'], '/apis/metrics.k8s.io/v1beta1/nodes', fixture('P-009'), 'API_UNAVAILABLE'],
    ['denied', ['get', 'pods'], '/api/v1/namespaces/kube-system/pods', { status: 403, headers: {}, body: { kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'Forbidden', message: 'Forbidden', code: 403 } }, 'ACCESS_DENIED'],
    ['expiry', ['get', 'pods'], '/api/v1/namespaces/kube-system/pods', { status: 410, headers: {}, body: { kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'Expired', message: 'Expired', code: 410 } }, 'RESOURCE_EXPIRED'],
    ['credential-expiry', ['get', 'pods'], '/api/v1/namespaces/kube-system/pods', { status: 401, headers: {}, body: { kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'Unauthorized', message: 'Unauthorized', code: 401 } }, 'AUTH_REQUIRED'],
    ['schema-unavailable', ['explain', 'pods'], '/openapi/v3/api/v1', { status: 404, headers: {}, body: { kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'NotFound', message: 'NotFound', code: 404 } }, 'SCHEMA_UNAVAILABLE'],
    ['malformed', ['get', 'pods'], '/api/v1/namespaces/kube-system/pods', 'malformed', 'UPSTREAM_INVALID'],
    ['timeout', ['get', 'pods'], '/api/v1/namespaces/kube-system/pods', 'timeout', 'UPSTREAM_TIMEOUT'],
    ['byte-limit', ['get', 'pods'], '/api/v1/namespaces/kube-system/pods', 'oversize', 'OUTPUT_LIMIT'],
  ] as const) await check(id, async () => {
    override = { path, envelope: envelope as Envelope | 'malformed' | 'timeout' | 'oversize' };
    const result = await run([...args]); assert.equal(result.code, 1, result.stdout); assert.equal((decode(result.stdout) as any).error.code, code);
    const native = await run(['native', '--', ...args]); assert.notEqual(native.code, 0); assert(native.stdout || native.stderr);
  });
  for (const name of ['forbidden', 'gone', 'timeout', 'unauthorized', 'expired', 'invalid-json']) await check(`failure-reason:${name}`, async () => {
    override = { path: `/api/v1/namespaces/kube-system/pods/${name}`, envelope: { status: 404, headers: {}, body: {
      kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'NotFound', message: `pods "${name}" not found`, details: { name, kind: 'pods' }, code: 404,
    } } };
    const result = await run(['get', 'pods', name]);
    const failure = (decode(result.stdout) as any).error;
    assert.equal(result.code, 1); assert.equal(failure.code, 'RESOURCE_NOT_FOUND'); assert.equal(failure.upstreamStatus, 404);
    const native = await run(['native', '--', 'get', 'pods', name]);
    assert.equal(native.code, 1); assert.equal(native.stdout, ''); assert.match(native.stderr, /Error from server \(NotFound\):/);
    assert(native.stderr.includes(`"${name}"`));
  });
  for (const [status, reason, code] of [[401, 'Unauthorized', 'AUTH_REQUIRED'], [403, 'Forbidden', 'ACCESS_DENIED'], [410, 'Gone', 'RESOURCE_EXPIRED'], [504, 'Timeout', 'UPSTREAM_TIMEOUT']] as const) await check(`schema-reason:${reason}`, async () => {
    override = { path: '/openapi/v3/api/v1', envelope: { status, headers: {}, body: {
      kind: 'Status', apiVersion: 'v1', status: 'Failure', reason, message: `${reason}: openapi schema NotFound timeout`, code: status,
    } } };
    const result = await run(['explain', 'pods']);
    assert.equal(result.code, 1); assert.equal((decode(result.stdout) as any).error.code, code);
  });
  for (const [type, namespace, expected] of [
    ['node', undefined, { name: 'synthetic-node', cpu: '125m', memory: '64Mi' }],
    ['pod', 'synthetic-space', { name: 'synthetic-pod', namespace: 'synthetic-space', cpu: '50m', memory: '48Mi' }],
  ] as const) await check(`AC-009-${type}`, async () => {
    variant = 'metrics';
    const args = ['top', type, ...(namespace ? ['-n', namespace] : [])];
    assert.deepEqual((await compact(...args)).metrics, [expected]);
    const native = await run(['native', '--', ...args]); assert.equal(native.code, 0, native.stderr);
    assert.match(native.stdout, new RegExp(`${expected.name}\\s+${expected.cpu}`)); assert(native.stdout.includes(expected.memory));
  });
  await check('AC-010', async () => {
    assert.equal((await compact('-n', 'kube-system', 'logs', 'resource-008')).logs, fixture('P-010').body);
    const native = await run(['native', '--', 'logs', 'resource-008']); assert.equal(native.code, 0, native.stderr); assert.equal(native.stdout, fixture('P-010').body);
  });
  await check('AC-002-003-026', async () => {
    const discovery = await compact('api-versions'); assert.deepEqual(discovery.versions, fixture('P-002').body.versions); assert(discovery.groups.some((group: any) => group.name === 'apps' && group.preferredVersion === 'apps/v1'));
    assert.deepEqual(discovery.groups.find((group: any) => group.name === 'autoscaling').versions, ['autoscaling/v2', 'autoscaling/v1']);
    assert.deepEqual(discovery.groups.find((group: any) => group.name === 'synthetic.example').versions, ['synthetic.example/v1', 'synthetic.example/v1beta1']);
    const resources = await compact('api-resources'); assert.deepEqual(resources.resources.find((item: any) => item.name === 'widgets'), { name: 'widgets', aliases: ['wd'], namespaced: true, kind: 'Widget', verbs: ['get', 'list'], apiVersion: 'synthetic.example/v1beta1' });
    assert.equal(resources.complete, true);
    assert.equal((await compact('get', 'wd')).widgets[0].name, 'synthetic-widget');
    const native = await run(['native', '--', 'get', 'wd', '-o', 'json']); assert.equal(native.code, 0, native.stderr); assert.equal(JSON.parse(native.stdout).items[0].metadata.name, 'synthetic-widget');
  });
  await check('AC-025', async () => {
    const output = await compact('explain', 'pods', '--api-version=v1', '--output=plaintext'); assert.match(output.text, /Synthetic pod schema/);
    const native = await run(['native', '--', 'explain', 'pods', '--api-version=v1', '--output=plaintext']); assert.equal(native.code, 0, native.stderr); assert.match(native.stdout, /Synthetic pod schema/);
  });
  await check('namespace-decoys', async () => {
    const selected = await compact('get', 'pods', '-n', 'kube-system'); const decoy = await compact('get', 'pods', '-n', 'decoy'); assert.equal(selected.pods[0].name, 'resource-008'); assert.equal(decoy.pods[0].name, 'decoy-pod');
    override = { path: '/api/v1/namespaces/kube-system/pods', envelope: { status: 200, headers: {}, body: { kind: 'PodList', apiVersion: 'v1', metadata: {}, items: [{ metadata: { name: 'decoy-pod', namespace: 'decoy' } }] } } };
    const result = await run(['get', 'pods']); assert.equal((decode(result.stdout) as any).error.code, 'UPSTREAM_INVALID');
  });
  await check('AC-011-filtered-page', async () => { variant = 'namespace-filter'; const output = await compact('get', 'namespaces', '-l', 'name=resource-016'); assert.equal(output.namespaces[0].name, 'resource-016'); assert.equal(output.continue, 'opaque-page-021'); assert(requests.some(path => path.includes('labelSelector=name%3Dresource-016'))); });
  await check('AC-HOME-001', async () => { const home = await compact(); assert.equal(home.source, 'file:selected'); assert.equal(home.context, 'selected'); assert.equal(home.namespace, 'kube-system'); assert.equal(home.kubectlVersion, 'v1.32.2'); assert.equal(home.pods[0].name, 'resource-008'); assert.equal(home.complete, false); });
  await check('home-missing-auth', async () => {
    const saved = environment.SYNTHETIC_TOKEN; environment.SYNTHETIC_TOKEN = '';
    try { const result = await run([]); assert.equal((decode(result.stdout) as any).error.code, 'AUTH_REQUIRED'); assert.equal(requests.length, 0); }
    finally { environment.SYNTHETIC_TOKEN = saved!; }
  });
  for (const args of [
    ['native', '--', 'get', 'secrets', '-o', 'json'],
    ['get', 'pods', '--namespce=other'], ['native', '--', 'get', 'pods', '--profile=cpu'], ['native', '--', 'get', 'pods', '--server=https://example.invalid'],
    ['native', '--', 'exec', 'resource-008', '--', 'sh'], ['native', '--', 'get', 'pods', '--watch'], ['get', 'pods', '--chunk-size=0'],
    ['native', '--', 'scale', 'deployment/demo', '--replicas=2'], ['native', '--', 'create', 'token', 'demo'],
    ['native', '--', 'rollout', 'status', 'deployment/demo'], ['native', '--', 'rollout', 'status', 'deployment/demo', '--watch=true'],
    ['native', '--', 'get', 'pods', '--watch-only'], ['native', '--', 'get', 'pods', '--output-watch-events'], ['logs', 'resource-008', '--follow'],
  ]) await check(`pre-effect:${args.join(' ')}`, async () => { const result = await run(args); assert.notEqual(result.code, 0); assert.equal(requests.length, 0); });
  await check('streaming-disabled', async () => {
    const result = await run(['native', '--', 'get', 'pods', '--watch=false', '--watch-only=false', '--output-watch-events=false', '-o', 'json']);
    assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).items[0].metadata.name, 'resource-008');
    const saved = environment.SYNTHETIC_TOKEN; environment.SYNTHETIC_TOKEN = '';
    try {
      const bounded = await run(['native', '--', 'rollout', 'status', 'deployment/demo', '--watch=false']);
      assert.equal((decode(bounded.stdout) as any).error.code, 'AUTH_REQUIRED');
      const streaming = await run(['native', '--', 'rollout', 'status', 'deployment/demo']);
      assert.equal((decode(streaming.stdout) as any).error.code, 'USAGE');
    } finally { environment.SYNTHETIC_TOKEN = saved!; }
  });
  await check('generated-help-offline', async () => {
    const help = await compact('native', '--', 'get', '-Ah'); assert(help.flags.some((flag: any) => flag.name === '--namespace' && flag.short === '-n' && flag.type === 'string')); assert.equal(requests.length, 0);
  });
  await check('diff-staged-limit', async () => {
    const result = await run(['native', '--', 'diff', '-f', 'unopened.yaml']);
    assert.equal((decode(result.stdout) as any).error.code, 'NOT_YET_SUPPORTED_STAGED'); assert.equal(requests.length, 0);
  });
  await check('ordered-repeat-flags', async () => {
    const native = await run(['--profile', 'selected', 'native', '--', 'get', 'pods', '-n', 'decoy', '-n', 'kube-system', '-o', 'json']); assert.equal(native.code, 0, native.stderr); assert.equal(JSON.parse(native.stdout).items[0].metadata.namespace, 'kube-system');
  });
  await check('stale-metadata', async () => {
    const path = join(installed, 'command-metadata.json'); const saved = readFileSync(path);
    try { writeFileSync(path, Buffer.concat([saved, Buffer.from(' ')])); const result = await run(['get', 'pods']); assert.equal((decode(result.stdout) as any).error.code, 'METADATA_STALE'); assert.equal(requests.length, 0); }
    finally { writeFileSync(path, saved); }
  });
  }
  await checkMutations({ run, check, environment, directory, requests });
  await checkRemote({ server, run, check, environment, directory, requests, cli });
  await check('R6-native-prefix-all-operation-paths', async () => local(async () => {
    variant = 'native-prefix'; environment.KUBERNETES_AXI_READ_ONLY = 'false';
    const settings = structuredClone(nativeSettings);
    settings.clusters[0]!.cluster.server += nativePrefix;
    settings.contexts[0]!.context.namespace = 'synthetic-b3';
    writeFileSync(nativeFile, JSON.stringify(settings));
    const before = structuredClone(rootDecoy);
    const native = async (args: string[]): Promise<any> => {
      const result = await run(['--native-config', nativeFile, ...args]);
      assert.equal(result.code, 0, result.stdout + result.stderr); return decode(result.stdout);
    };
    try {
      const saved = await native(['prepare', '--', 'create', 'configmap', 'prefixed', '-n', 'synthetic-b3', '--from-literal=value=selected']);
      const preview = await native(['preview', saved.request]);
      const committed = await native(['confirm', saved.request, '--digest', preview.digest]);
      assert.equal(committed.state, 'complete');
      await native(['server-dry-run', '--', 'patch', 'configmap', 'prefixed', '-n', 'synthetic-b3', '--type=merge', '-p', '{"data":{"value":"dry-run"}}']);
      assert.equal((await native(['auth', 'whoami'])).reviews[0].status.userInfo.username, 'synthetic-identity');
      assert.equal((await native(['auth', 'can-i', 'get', 'configmaps', '-n', 'synthetic-b3'])).reviews[0].status.allowed, true);
      const patch = await native(['prepare', '--', 'patch', 'configmap', 'prefixed', '-n', 'synthetic-b3', '--type=merge', '-p', '{"data":{"value":"reconciled"}}']);
      const patchPreview = await native(['preview', patch.request]);
      const args = ['--native-config', nativeFile, 'confirm', patch.request, '--digest', patchPreview.digest];
      const uncertain = await run(args);
      assert.equal(uncertain.code, 1, uncertain.stdout + uncertain.stderr);
      assert.equal((decode(uncertain.stdout) as any).results[0].observed[0].name, 'prefixed');
      const start = requests.length;
      const reconciled = await run(args);
      assert.equal(reconciled.code, 1, reconciled.stdout + reconciled.stderr);
      assert.equal((decode(reconciled.stdout) as any).results.at(-1).outcome, 'reconciled_without_retry');
      assert.deepEqual(requests.slice(start), [nativePrefix + '/api/v1/namespaces/synthetic-b3/configmaps/prefixed']);
      assert(requests.every(path => path.startsWith(nativePrefix + '/')), JSON.stringify(requests));
      assert.deepEqual(rootDecoy, before);
    } finally {
      writeFileSync(nativeFile, JSON.stringify(nativeSettings)); environment.KUBERNETES_AXI_READ_ONLY = 'true';
    }
  }));
} finally {
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  console.log(JSON.stringify({ tasks: ['B2.1', 'B2.2', 'B2.3', 'B2.4', 'B3.1', 'B3.2', 'B3.3', 'B3.4'], outcome: process.exitCode ? 'failure' : 'pass', nativeOS: process.platform,
    packageSha256: createHash('sha256').update(readFileSync(join(directory, packed[0].filename))).digest('hex'),
    kubectlPins: JSON.parse(readFileSync(join(installed, 'kubectl-pins.json'), 'utf8')),
    publicPaths: ['installed compact CLI', 'installed native kubectl route'], network: 'isolated Linux network namespace; loopback only', fixtureHashes: hashes, cases,
    nativeWriteObserver: process.env.KUBERNETES_AXI_TEST_WRITE_OBSERVER_SHA256 ?? 'not supplied',
    pending: ['Artium journeys and real credential-store observation require the separate opt-in verifier', ...(process.env.KUBERNETES_AXI_TEST_WRITE_OBSERVER ? [] : ['B3.4 native write observation requires a pinned strace binary']), 'native Windows commissioning'] }, null, 2));
  rmSync(directory, { recursive: true, force: true });
}
