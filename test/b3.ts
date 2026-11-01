import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { decode } from '@toon-format/toon';

// Synthetic Kubernetes boundary, shared with B2's real TLS server and installed package.
// Schemas and preconditions follow the Kubernetes API concepts and v1.32 API reference.
interface ObjectBody { apiVersion: string; kind: string; metadata: { name: string; namespace?: string; uid: string; resourceVersion: string; [key: string]: any }; [key: string]: any }
const ns = 'synthetic-b3';
const core = `/api/v1/namespaces/${ns}`;
const apps = `/apis/apps/v1/namespaces/${ns}`;
const widgets = `/apis/synthetic.example/v1beta1/namespaces/${ns}/widgets`;
const resource = (name: string, kind: string, namespaced: boolean, shortNames: string[] = []) => ({ name, singularName: kind.toLowerCase(), kind, namespaced, shortNames, verbs: ['get', 'list', 'create', 'update', 'patch', 'delete', 'deletecollection'] });
const discovery = (groupVersion: string, resources: object[]) => ({ kind: 'APIResourceList', apiVersion: 'v1', groupVersion, resources });
const objects = new Map<string, ObjectBody>();
const effects: { method: string; path: string; body: any; wire: string; dryRun: boolean }[] = [];
let mode = '';
let revision = 1;
const doc = (apiVersion: string, kind: string, name: string, namespace?: string, extra: object = {}): ObjectBody => ({ apiVersion, kind,
  metadata: { name, ...(namespace ? { namespace } : {}), uid: `uid-${kind}-${namespace ?? ''}-${name}`, resourceVersion: String(revision++), labels: { app: 'selected' } }, ...extra });
const deployment = (name: string) => doc('apps/v1', 'Deployment', name, ns, {
  spec: { replicas: 2, selector: { matchLabels: { app: 'selected' } }, template: {
    metadata: { labels: { app: 'selected' } }, spec: { containers: [{ name: 'app', image: 'synthetic:v1', ports: [{ containerPort: 80 }] }] },
  } }, status: { observedGeneration: 1, replicas: 2, updatedReplicas: 2, availableReplicas: 2 },
});

function reset(): void {
  objects.clear(); effects.length = 0; mode = ''; revision = 1;
  objects.set(`${core}/configmaps/selected`, doc('v1', 'ConfigMap', 'selected', ns, { data: { value: 'before' } }));
  objects.set(`${core}/configmaps/decoy`, doc('v1', 'ConfigMap', 'decoy', ns, { data: { value: 'decoy' } }));
  objects.set(`${core}/secrets/selected`, doc('v1', 'Secret', 'selected', ns, { data: { key: 'YmVmb3Jl' }, metadata: { ...doc('v1', 'Secret', 'selected', ns).metadata, annotations: {} } }));
  objects.set(`${apps}/deployments/selected`, deployment('selected'));
  objects.set(`${apps}/deployments/decoy`, deployment('decoy'));
  const rs = doc('apps/v1', 'ReplicaSet', 'b3-revision-one', ns, { spec: { replicas: 0, selector: { matchLabels: { app: 'selected' } }, template: structuredClone(objects.get(`${apps}/deployments/selected`)!.spec.template) } });
  rs.metadata.annotations = { 'deployment.kubernetes.io/revision': '1' };
  rs.metadata.ownerReferences = [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'selected', uid: objects.get(`${apps}/deployments/selected`)!.metadata.uid, controller: true }];
  rs.spec.template.spec.containers[0].image = 'synthetic:v0'; objects.set(`${apps}/replicasets/b3-revision-one`, rs);
  objects.set(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings/selected`, doc('rbac.authorization.k8s.io/v1', 'RoleBinding', 'selected', ns, { roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'reader' }, subjects: [] }));
  objects.set(`${widgets}/selected`, doc('synthetic.example/v1beta1', 'Widget', 'selected', ns, { spec: { value: 'before' } }));
  objects.set('/api/v1/nodes/b3-node', doc('v1', 'Node', 'b3-node', undefined, { spec: { unschedulable: false }, status: {} }));
  objects.set('/api/v1/nodes/b3-decoy', doc('v1', 'Node', 'b3-decoy', undefined, { spec: { unschedulable: false }, status: {} }));
  objects.set('/api/v1/namespaces/b3-space', doc('v1', 'Namespace', 'b3-space'));
  objects.set('/apis/certificates.k8s.io/v1/certificatesigningrequests/b3-csr', doc('certificates.k8s.io/v1', 'CertificateSigningRequest', 'b3-csr', undefined, { spec: { signerName: 'synthetic.example/test', request: 'c3ludGhldGlj', usages: ['client auth'] }, status: {} }));
  for (const name of ['pod-a', 'pod-b']) objects.set(`${core}/pods/${name}`, doc('v1', 'Pod', name, ns, { spec: { nodeName: 'b3-node', containers: [{ name: 'app', image: 'synthetic:v1' }] }, status: { phase: 'Running' } }));
}

function merge(before: any, patch: any): any {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return structuredClone(patch);
  const result = { ...before };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else if (Array.isArray(value) && value.every(item => item && typeof item === 'object' && 'name' in item)) {
      const entries = new Map((result[key] ?? []).map((item: any) => [item.name, item]));
      for (const item of value) entries.set(item.name, merge(entries.get(item.name), item));
      result[key] = [...entries.values()];
    } else result[key] = typeof value === 'object' && !Array.isArray(value) ? merge(result[key], value) : value;
  }
  return result;
}

export function mutationFixture(request: IncomingMessage, response: ServerResponse, loseReply = false): boolean {
  const url = new URL(request.url!, 'https://local');
  const path = url.pathname;
  const send = (body: object, status = 200): void => { response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)); };
  const status = (reason: string, code: number): void => send({ kind: 'Status', apiVersion: 'v1', status: 'Failure', reason, message: reason, code }, code);
  const routes: Record<string, object> = {
    '/api/v1': discovery('v1', [resource('pods', 'Pod', true, ['po']), { ...resource('pods/eviction', 'Eviction', true), group: 'policy', version: 'v1' }, resource('namespaces', 'Namespace', false, ['ns']), resource('nodes', 'Node', false, ['no']), resource('events', 'Event', true, ['ev']), resource('configmaps', 'ConfigMap', true, ['cm']), resource('secrets', 'Secret', true), resource('services', 'Service', true, ['svc']), resource('serviceaccounts', 'ServiceAccount', true, ['sa'])]),
    '/apis/networking.k8s.io/v1': discovery('networking.k8s.io/v1', [resource('ingresses', 'Ingress', true)]),
    '/apis/apps/v1': discovery('apps/v1', [resource('deployments', 'Deployment', true, ['deploy']), { ...resource('deployments/scale', 'Scale', true), group: 'autoscaling', version: 'v1' }, resource('replicasets', 'ReplicaSet', true, ['rs']), resource('daemonsets', 'DaemonSet', true, ['ds']), resource('statefulsets', 'StatefulSet', true, ['sts'])]),
    '/apis/policy/v1': discovery('policy/v1', [resource('poddisruptionbudgets', 'PodDisruptionBudget', true, ['pdb'])]),
    '/apis/autoscaling/v2': discovery('autoscaling/v2', [resource('horizontalpodautoscalers', 'HorizontalPodAutoscaler', true, ['hpa'])]),
    '/apis/autoscaling/v1': discovery('autoscaling/v1', [resource('horizontalpodautoscalers', 'HorizontalPodAutoscaler', true, ['hpa'])]),
    '/apis/certificates.k8s.io/v1': discovery('certificates.k8s.io/v1', [resource('certificatesigningrequests', 'CertificateSigningRequest', false, ['csr']), resource('certificatesigningrequests/approval', 'CertificateSigningRequest', false)]),
    '/apis/rbac.authorization.k8s.io/v1': discovery('rbac.authorization.k8s.io/v1', [resource('rolebindings', 'RoleBinding', true)]),
  };
  if (request.method === 'GET' && routes[path]) { send(routes[path]!); return true; }
  const review = /\/apis\/(authorization|authentication)\.k8s\.io\/v1[^/]*\/(selfsubjectaccessreviews|selfsubjectrulesreviews|selfsubjectreviews)$/.exec(path);
  if (review) {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      effects.push({ method: request.method!, path, body, wire: Buffer.concat(chunks).toString(), dryRun: false });
      if (mode === 'review-denied') return status('Forbidden', 403);
      send({ ...body, status: review[2] === 'selfsubjectreviews' ? { userInfo: { username: 'synthetic-identity', groups: ['synthetic'] } } : review[2] === 'selfsubjectrulesreviews' ? { resourceRules: [], nonResourceRules: [], incomplete: true, evaluationError: 'synthetic partial rules' } : { allowed: mode !== 'access-denied', denied: mode === 'access-denied', reason: 'synthetic explicit review' } });
    })(); return true;
  }
  const selectedPath = request.method !== 'GET' && path === '/api/v1/namespaces' || path.startsWith(core) || path.startsWith(apps) || path.startsWith(widgets) || /\/namespaces\/synthetic-b3\//.test(path) || /\/b3-[a-z-]+(?:\/|$)/.test(path) || path === '/api/v1/pods' && url.searchParams.get('fieldSelector')?.includes('b3-node');
  if (!selectedPath) return false;
  void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const subresource = path.endsWith('/scale') || path.endsWith('/approval') || path.endsWith('/eviction') || path.endsWith('/ephemeralcontainers');
    const target = subresource ? path.slice(0, path.lastIndexOf('/')) : path;
    const existing = objects.get(target);
    const scale = (object: ObjectBody): ObjectBody => ({ apiVersion: 'autoscaling/v1', kind: 'Scale', metadata: object.metadata, spec: { replicas: object.spec.replicas }, status: { replicas: object.spec.replicas, selector: 'app=selected' } });
    if (request.method === 'GET') {
      if (mode === 'absent-eviction' && target === `${core}/pods/pod-a`) {
        objects.delete(target);
        return status('NotFound', 404);
      }
      if (mode === 'create-after-preflight' && target === `${core}/configmaps/absent` && !existing) {
        objects.set(target, doc('v1', 'ConfigMap', 'absent', ns, { data: { value: 'other-actor' } }));
        return status('NotFound', 404);
      }
      if (existing) return send(path.endsWith('/scale') ? scale(existing) : existing);
      if (subresource || path.split('/').at(-1) === 'absent') return status('NotFound', 404);
      const listKinds: Record<string, [string, string]> = { pods: ['v1', 'Pod'], configmaps: ['v1', 'ConfigMap'], deployments: ['apps/v1', 'Deployment'], replicasets: ['apps/v1', 'ReplicaSet'], widgets: ['synthetic.example/v1beta1', 'Widget'], poddisruptionbudgets: ['policy/v1', 'PodDisruptionBudget'], horizontalpodautoscalers: ['autoscaling/v2', 'HorizontalPodAutoscaler'] };
      const listing = listKinds[path.split('/').at(-1)!];
      if (!listing) return status('NotFound', 404);
      let items = [...objects].filter(([key]) => path === '/api/v1/pods' ? key.includes('/pods/') : key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')).map(([, object]) => object);
      const selector = url.searchParams.get('labelSelector');
      if (selector) items = items.filter(item => selector.split(',').every(part => { const [key, value] = part.split('='); return item.metadata.labels?.[key!] === value; }));
      const field = url.searchParams.get('fieldSelector');
      if (field?.startsWith('metadata.name=')) items = items.filter(item => item.metadata.name === field.slice('metadata.name='.length));
      if (field?.startsWith('spec.nodeName=')) items = items.filter(item => item.spec?.nodeName === field.slice('spec.nodeName='.length));
      return send({ kind: listing[1] + 'List', apiVersion: listing[0], metadata: { resourceVersion: 'list-version' }, items });
    }
    const dryRun = url.searchParams.get('dryRun') === 'All' || body.dryRun?.includes('All') || body.deleteOptions?.dryRun?.includes('All') || false;
    effects.push({ method: request.method!, path, body, wire: Buffer.concat(chunks).toString(), dryRun });
    if (mode === 'conflict') return status('Conflict', 409);
    if (mode === 'partial-bulk' && request.method === 'DELETE' && effects.filter(effect => effect.method === 'DELETE').length === 2) return status('Forbidden', 403);
    if (path.endsWith('/eviction') && (mode === 'deny-eviction' || mode === 'partial-drain' && effects.filter(effect => effect.path.endsWith('/eviction')).length === 2)) return status('Forbidden', 403);
    if (request.method === 'DELETE' && !existing && url.searchParams.has('fieldSelector')) {
      const name = url.searchParams.get('fieldSelector')!.slice('metadata.name='.length);
      const object = objects.get(`${path}/${name}`);
      if (object && (body.preconditions?.uid !== object.metadata.uid || body.preconditions?.resourceVersion !== object.metadata.resourceVersion)) return status('Conflict', 409);
      if (!dryRun) objects.delete(`${path}/${name}`);
      return send({ kind: 'Status', apiVersion: 'v1', status: 'Success' });
    }
    if (request.method === 'DELETE' || path.endsWith('/eviction')) {
      const preconditions = path.endsWith('/eviction') ? body.deleteOptions?.preconditions : body.preconditions;
      if (!existing) return status('NotFound', 404);
      if (preconditions && (preconditions.uid !== existing.metadata.uid || preconditions.resourceVersion !== existing.metadata.resourceVersion)) return status('Conflict', 409);
      if (!dryRun && mode !== 'eviction-pending') objects.delete(target);
      return send({ kind: 'Status', apiVersion: 'v1', status: 'Success' });
    }
    let changed: ObjectBody;
    if (request.method === 'POST') {
      const location = `${path}/${body.metadata.name}`;
      if (objects.has(location)) return status('AlreadyExists', 409);
      changed = doc(body.apiVersion, body.kind, body.metadata.name, body.metadata.namespace, body);
      changed.metadata = { ...body.metadata, uid: `created-${revision}`, resourceVersion: String(revision++) };
      if (!dryRun) objects.set(location, changed);
    } else {
      if (!existing) return status('NotFound', 404);
      if (body.metadata?.resourceVersion && body.metadata.resourceVersion !== existing.metadata.resourceVersion) return status('Conflict', 409);
      const before = path.endsWith('/scale') ? scale(existing) : existing;
      if (Array.isArray(body)) {
        changed = structuredClone(before);
        for (const patch of body) {
          const segments = patch.path.slice(1).split('/').map((part: string) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
          const parent = segments.slice(0, -1).reduce((object: any, key: string) => object[key], changed);
          const key = segments.at(-1);
          if (patch.op === 'test' && parent[key] !== patch.value) return status('Conflict', 409);
          if (['add', 'replace'].includes(patch.op)) parent[key] = patch.value;
          if (patch.op === 'remove') delete parent[key];
        }
      } else changed = request.method === 'PUT' ? structuredClone(body) : merge(before, body);
      changed.metadata = { ...existing.metadata, ...changed.metadata, resourceVersion: String(revision++) };
      if (!dryRun) objects.set(target, path.endsWith('/scale') ? { ...existing, metadata: changed.metadata, spec: { ...existing.spec, replicas: changed.spec.replicas } } : changed);
    }
    if ((mode === 'loss-after-commit' || loseReply) && !dryRun) { response.destroy(); return; }
    send(changed, request.method === 'POST' ? 201 : 200);
  })().catch(error => { console.error(error); status('InternalError', 500); });
  return true;
}

interface Harness {
  run: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  check: (id: string, test: () => Promise<void>) => Promise<void>;
  environment: NodeJS.ProcessEnv;
  directory: string;
  requests: string[];
}

export async function checkMutations({ run, check, environment, directory, requests }: Harness): Promise<void> {
  const output = async (args: string[]): Promise<any> => { const result = await run(args); assert.equal(result.code, 0, result.stdout + result.stderr); return decode(result.stdout); };
  const prepare = async (args: string[]): Promise<any> => output(['prepare', '--', ...args]);
  const approved = async (args: string[]): Promise<any> => { const saved = await prepare(args); const preview = await output(['preview', saved.request]); return { ...saved, digest: preview.digest }; };
  const confirm = async (saved: any): Promise<any> => output(['confirm', saved.request, '--digest', saved.digest]);
  const test = async (name: string, body: () => Promise<void>): Promise<void> => check(name, async () => {
    reset(); environment.KUBERNETES_AXI_READ_ONLY = 'false'; environment.KUBERNETES_AXI_COLLECTION_DELETE = 'true';
    try { await body(); } finally { environment.KUBERNETES_AXI_READ_ONLY = 'true'; delete environment.KUBERNETES_AXI_COLLECTION_DELETE; }
  });
  await test('B3-disabled-writes', async () => {
    environment.KUBERNETES_AXI_READ_ONLY = 'true';
    const result = await run(['prepare', '--', 'create', 'namespace', 'b3-created']);
    assert.equal((decode(result.stdout) as any).error.code, 'READ_ONLY'); assert.equal(requests.length, 0); assert.equal(effects.length, 0);
  });
  for (const [name, args, method, path, target] of [
    ['AC-018-debug-create', ['debug', 'pod-a', '-n', ns, '--image=synthetic:debug', '--copy-to=debug-copy', '--container=debugger', '--attach=false', '--', 'true'], 'POST', `${core}/pods`, `${core}/pods/debug-copy`],
    ['AC-018-debug-patch', ['debug', 'pod-a', '-n', ns, '--image=synthetic:debug', '--container=debugger', '--attach=false', '--', 'true'], 'PATCH', `${core}/pods/pod-a/ephemeralcontainers`, `${core}/pods/pod-a`],
  ] as const) await test(name, async () => {
    const decoy = structuredClone(objects.get(`${core}/pods/pod-b`));
    const saved = await approved([...args]);
    assert.equal(effects.length, 0, 'Debug preparation must not create or patch upstream');
    assert.equal((await confirm(saved)).state, 'complete');
    assert.deepEqual(effects.map(effect => ({ method: effect.method, path: effect.path })), [{ method, path }]);
    assert.equal(objects.get(target)!.spec[method === 'POST' ? 'containers' : 'ephemeralContainers'].at(-1).name, 'debugger');
    assert.deepEqual(objects.get(`${core}/pods/pod-b`), decoy);
  });
  await test('AC-029-raw-read-and-mutation', async () => {
    const read = await run(['native', '--', 'get', `--raw=${core}/configmaps/selected`]);
    assert.equal(read.code, 0, read.stdout + read.stderr);
    assert.equal(JSON.parse(read.stdout).data.value, 'before');
    const file = join(directory, 'raw-configmap.json');
    writeFileSync(file, JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'raw-created', namespace: ns }, data: { value: 'raw' } }));
    const saved = await approved(['create', `--raw=${core}/configmaps`, '-f', file]);
    assert.equal(effects.length, 0);
    assert.equal((await confirm(saved)).state, 'complete');
    assert.equal(objects.get(`${core}/configmaps/raw-created`)!.data.value, 'raw');
  });
  for (const args of [
    ['native', '--', 'get', `--raw=${core}/pods/pod-a/proxy/api/v1/pods`],
    ['prepare', '--', 'create', `--raw=${core}/pods/pod-a/proxy/api/v1/configmaps`, '-f', '/unopened.json'],
    ['native', '--', 'get', `--raw=${core}/pods/pod-a/exec?command=true`],
    ['prepare', '--', 'apply', '-k', '/unopened'],
    ['server-dry-run', '--', 'kustomize', '--enable-alpha-plugins'],
  ]) await test(`AC-029-guard:${args.join(' ')}`, async () => {
    const result = await run(args); assert.notEqual(result.code, 0); assert.equal(requests.length, 0); assert.equal(effects.length, 0);
  });
  await test('AC-012-prepare-preview-confirm-once', async () => {
    const saved = await prepare(['create', 'configmap', 'created', '-n', ns, '--from-literal=value=after']);
    assert.equal(effects.length, 0); assert(!objects.has(`${core}/configmaps/created`));
    requests.length = 0;
    const preview = await output(['preview', saved.request]);
    assert.equal(requests.length, 0); assert.equal(preview.changes[0].method, 'POST');
    const requestDir = join(directory, 'requests', saved.request);
    assert.equal(statSync(requestDir).mode & 0o777, 0o700); assert.equal(statSync(join(requestDir, 'request.json')).mode & 0o777, 0o600);
    const committed = await confirm({ ...saved, digest: preview.digest });
    assert.equal(committed.state, 'complete'); assert.equal(objects.get(`${core}/configmaps/created`)!.data.value, 'after');
    const frozen = JSON.parse(readFileSync(join(requestDir, 'request.json'), 'utf8'));
    assert.equal(effects[0]!.wire, frozen.plan.changes[0].wire);
    const journal = JSON.parse(readFileSync(join(requestDir, 'outcome.json'), 'utf8'));
    assert.equal(journal.results[0].outcome, 'committed'); assert.equal(journal.results[0].upstreamStatus, 201);
    await confirm({ ...saved, digest: preview.digest }); assert.equal(effects.length, 1);
  });
  await test('B3-preview-binding', async () => {
    const saved = await approved(['patch', 'configmap', 'selected', '-n', ns, '--type=merge', '-p', '{"data":{"value":"after"}}']);
    const wrong = await run(['confirm', saved.request, '--digest', 'a'.repeat(64)]);
    assert.equal((decode(wrong.stdout) as any).error.code, 'PREVIEW_MISMATCH'); assert.equal(effects.length, 0);
    const token = environment.SYNTHETIC_TOKEN; environment.SYNTHETIC_TOKEN = 'synthetic-other';
    try { const identity = await run(['confirm', saved.request, '--digest', saved.digest]); assert.equal((decode(identity.stdout) as any).error.code, 'PREVIEW_MISMATCH'); }
    finally { environment.SYNTHETIC_TOKEN = token!; }
    assert.equal(effects.length, 0);
  });
  await test('B3-stale-preview', async () => {
    const saved = await approved(['delete', 'configmap', 'selected', '-n', ns]);
    objects.get(`${core}/configmaps/selected`)!.metadata.resourceVersion = 'changed';
    const result = await run(['confirm', saved.request, '--digest', saved.digest]);
    assert.equal((decode(result.stdout) as any).error.code, 'PREVIEW_STALE'); assert.equal(effects.length, 0);
  });
  await test('R9-absent-delete-refused', async () => {
    const before = structuredClone([...objects]);
    const result = await run(['prepare', '--', 'delete', 'configmap', 'absent', '-n', ns]);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.equal((decode(result.stdout) as any).error.code, 'PREVIEW_TARGET_ABSENT');
    assert.equal(effects.length, 0);
    assert.deepEqual([...objects], before);
  });
  await test('R9-absent-replace-refused', async () => {
    const before = structuredClone([...objects]);
    const file = join(directory, 'manifest.json');
    writeFileSync(file, JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'absent', namespace: ns }, data: { value: 'replacement' } }));
    const result = await run(['prepare', '--', 'replace', '-f', file, '-n', ns, '--validate=false']);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.equal((decode(result.stdout) as any).error.code, 'PREVIEW_TARGET_ABSENT');
    assert.equal(effects.length, 0);
    assert.deepEqual([...objects], before);
  });
  await test('R9-absent-eviction-refused', async () => {
    const decoy = structuredClone(objects.get(`${core}/pods/pod-b`));
    mode = 'absent-eviction';
    const result = await run(['prepare', '--', 'drain', 'b3-node', '--force', '--ignore-daemonsets']);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.equal((decode(result.stdout) as any).error.code, 'PREVIEW_TARGET_ABSENT');
    assert.equal(effects.length, 0);
    assert.deepEqual(objects.get(`${core}/pods/pod-b`), decoy);
    assert.equal(objects.get('/api/v1/nodes/b3-node')!.spec.unschedulable, false);
  });
  await test('R12-compact-secret-last-applied-refused', async () => {
    const secret = objects.get(`${core}/secrets/selected`)!;
    const payload = 'c3ludGhldGljLWxhc3QtYXBwbGllZC1zZWNyZXQ=';
    secret.metadata.annotations = { 'kubectl.kubernetes.io/last-applied-configuration': JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'selected', namespace: ns }, data: { 'api-key': payload } }) };
    const result = await run(['apply', 'view-last-applied', 'secret', 'selected', '-n', ns, '-o', 'json']);
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.equal((decode(result.stdout) as any).error.code, 'CAPABILITY_UNAVAILABLE');
    assert(!`${result.stdout}${result.stderr}`.includes(payload));
    assert.equal(requests.length, 0);
  });
  for (const [name, args, target, expected] of [
    ['AC-014-merge', ['patch', 'cm', 'selected', '-n', ns, '--type=merge', '-p', '{"data":{"value":"after"}}'], `${core}/configmaps/selected`, 'after'],
    ['AC-014-json', ['patch', 'cm', 'selected', '-n', ns, '--type=json', '-p', '[{"op":"replace","path":"/data/value","value":"after"}]'], `${core}/configmaps/selected`, 'after'],
    ['AC-014-custom', ['patch', 'widget', 'selected', '-n', ns, '--type=merge', '-p', '{"spec":{"value":"after"}}'], `${widgets}/selected`, 'after'],
  ] as const) await test(name, async () => {
    const decoy = structuredClone(objects.get(`${core}/configmaps/decoy`));
    await confirm(await approved([...args]));
    assert.equal(objects.get(target)!.data?.value ?? objects.get(target)!.spec.value, expected);
    assert.deepEqual(objects.get(`${core}/configmaps/decoy`), decoy);
  });
  for (const [scope, path, type, apiVersion, kind, extra] of [
    ['core', `${core}/configmaps`, 'configmap', 'v1', 'ConfigMap', { data: { value: 'after' } }],
    ['grouped', `${apps}/deployments`, 'deployment', 'apps/v1', 'Deployment', { spec: { replicas: 3, selector: { matchLabels: { app: 'selected' } }, template: deployment('selected').spec.template } }],
    ['cluster', '/api/v1/namespaces', 'namespace', 'v1', 'Namespace', { metadata: { labels: { changed: 'true' } } }],
    ['custom', widgets, 'widget', 'synthetic.example/v1beta1', 'Widget', { spec: { value: 'after' } }],
  ] as const) {
    for (const verb of ['create', 'replace', 'apply'] as const) await test(`B3-${verb}-${scope}`, async () => {
      const name = verb === 'create' ? 'b3-created' : scope === 'cluster' ? 'b3-space' : 'selected';
      const current = objects.get(`${path}/${name}`);
      const manifest: any = { apiVersion, kind, ...extra, metadata: { name, ...(scope === 'cluster' ? {} : { namespace: ns }), ...(verb === 'replace' ? { resourceVersion: current!.metadata.resourceVersion } : {}), ...(scope === 'cluster' ? extra.metadata : {}) } };
      const file = join(directory, 'manifest.json'); writeFileSync(file, JSON.stringify(manifest));
      const args = [verb, '-f', file, '--validate=false', ...(scope === 'cluster' ? [] : ['-n', ns]), ...(verb === 'apply' ? ['--openapi-patch=false'] : [])];
      const saved = await approved(args); assert.equal(effects.length, 0);
      await confirm(saved);
      const changed = objects.get(`${path}/${name}`)!; assert(changed, `${verb} ${type}`);
      if (scope === 'core') assert.equal(changed.data.value, 'after');
      if (scope === 'grouped') assert.equal(changed.spec.replicas, 3);
      if (scope === 'custom') assert.equal(changed.spec.value, 'after');
      if (scope === 'cluster') assert.equal(changed.metadata.labels.changed, 'true');
    });
  }
  await test('B3-server-side-apply', async () => {
    const file = join(directory, 'manifest.json'); writeFileSync(file, JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'selected', namespace: ns }, data: { value: 'applied' } }));
    await confirm(await approved(['apply', '-f', file, '-n', ns, '--server-side', '--validate=false']));
    assert.equal(objects.get(`${core}/configmaps/selected`)!.data.value, 'applied');
  });
  for (const race of [false, true]) await test(`R3-absent-apply-${race ? 'race' : 'create'}`, async () => {
    const file = join(directory, 'manifest.json');
    writeFileSync(file, JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'absent', namespace: ns }, data: { value: 'approved' } }));
    const saved = await approved(['apply', '-f', file, '-n', ns, '--server-side', '--validate=false']);
    if (race) mode = 'create-after-preflight';
    const result = await run(['confirm', saved.request, '--digest', saved.digest]);
    assert.equal(result.code, race ? 1 : 0, result.stdout + result.stderr);
    assert.equal(objects.get(`${core}/configmaps/absent`)!.data.value, race ? 'other-actor' : 'approved');
    assert.equal(effects.length, 1);
    assert.equal(effects[0]!.method, 'POST');
    if (race) assert.equal((decode(result.stdout) as any).results[0].upstreamStatus, 409);
  });
  await test('R4-revoked-bulk-capability', async () => {
    const before = structuredClone([...objects]);
    const saved = await approved(['delete', 'configmaps', '-n', ns, '--all']);
    delete environment.KUBERNETES_AXI_COLLECTION_DELETE;
    requests.length = 0;
    const result = await run(['confirm', saved.request, '--digest', saved.digest]);
    assert.equal((decode(result.stdout) as any).error.code, 'CAPABILITY_UNAVAILABLE');
    assert.equal(effects.length, 0); assert.equal(requests.length, 0);
    assert.deepEqual([...objects], before);
    environment.KUBERNETES_AXI_COLLECTION_DELETE = 'true';
    assert.equal((await confirm(saved)).state, 'complete');
  });
  for (const [type, path, value] of [
    ['secret', '/data/key', 'c2VjcmV0'],
    ['secret', '/stringData/key', 'synthetic-string-secret'],
    ['secret', '/binaryData/key', 'c3ludGhldGljLWJpbmFyeQ=='],
    ['secret', '/metadata/annotations/private~1key', 'synthetic-annotation-secret'],
    ['configmap', '/metadata/annotations/kubectl.kubernetes.io~1last-applied-configuration', 'synthetic-last-applied-secret'],
  ]) await test(`R2-json-patch-redaction-${path}`, async () => {
    const target = `${core}/${type === 'secret' ? 'secrets' : 'configmaps'}/selected`;
    Object.assign(objects.get(target)!, { stringData: {}, binaryData: {} });
    objects.get(target)!.metadata.annotations = {};
    const patch = JSON.stringify([{ op: 'add', path, value }]);
    const saved = await prepare(['patch', type!, 'selected', '-n', ns, '--type=json', '-p', patch]);
    const result = await run(['preview', saved.request]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert(!result.stdout.includes(value!));
    const preview = decode(result.stdout) as any;
    assert.equal(preview.changes[0].change.at(-1).value, '[REDACTED]');
    const frozen = JSON.parse(readFileSync(join(directory, 'requests', saved.request, 'request.json'), 'utf8'));
    assert.equal(frozen.plan.changes[0].body.at(-1).value, value);
    await confirm({ ...saved, digest: preview.digest });
    assert.equal(effects[0]!.wire, frozen.plan.changes[0].wire);
    const segments = path!.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    assert.equal(segments.reduce((body: any, key) => body[key], objects.get(target)), value);
  });
  for (const dryRun of [false, true]) await test(`R1-ingress-${dryRun ? 'dry-run' : 'confirm'}`, async () => {
    const args = ['create', 'ingress', 'demo', '-n', ns, '--rule=example.test/=svc:80', '--validate=false'];
    if (dryRun) await output(['server-dry-run', '--', ...args]);
    else await confirm(await approved(args));
    const rule = effects[0]!.body.spec.rules[0];
    assert.equal(rule.host, 'example.test');
    assert.equal(rule.http.paths[0].path, '/');
    assert.equal(rule.http.paths[0].pathType, 'Exact');
    assert.equal(rule.http.paths[0].backend.service.name, 'svc');
    assert.equal(rule.http.paths[0].backend.service.port.number, 80);
    assert.equal(effects[0]!.dryRun, dryRun);
    assert.equal(objects.has(`/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses/demo`), !dryRun);
  });
  await test('R1-pod-inline-references-and-fields', async () => {
    const fields = { 'f:metadata': { 'f:labels': { 'f:app': {} } } };
    const manifest = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'mapped', namespace: ns,
      managedFields: [{ manager: 'synthetic', operation: 'Apply', apiVersion: 'v1', fieldsType: 'FieldsV1', fieldsV1: fields }] },
    spec: { containers: [{ name: 'app', image: 'synthetic:v1',
      livenessProbe: { httpGet: { path: '/health', port: 80 } },
      env: [{ name: 'CONFIG', valueFrom: { configMapKeyRef: { name: 'settings', key: 'key' } } }, { name: 'SECRET', valueFrom: { secretKeyRef: { name: 'credentials', key: 'key' } } }],
      envFrom: [{ configMapRef: { name: 'settings' } }, { secretRef: { name: 'credentials' } }],
    }], volumes: [{ name: 'settings', configMap: { name: 'settings' } }, { name: 'credentials', secret: { secretName: 'credentials' } },
      { name: 'projected', projected: { sources: [{ configMap: { name: 'settings' } }, { secret: { name: 'credentials' } }] } }],
    } };
    const file = join(directory, 'manifest.json'); writeFileSync(file, JSON.stringify(manifest));
    await confirm(await approved(['create', '-f', file, '-n', ns, '--validate=false']));
    const changed = objects.get(`${core}/pods/mapped`)!;
    assert.deepEqual(changed.spec, manifest.spec);
    assert.deepEqual(changed.metadata.managedFields[0].fieldsV1, fields);
  });
  for (const [name, variant] of [['B3-conflict-reconciliation', 'conflict'], ['B3-uncertain-reconciliation', 'loss-after-commit']] as const) await test(name, async () => {
    const saved = await approved(['patch', 'cm', 'selected', '-n', ns, '--type=merge', '-p', '{"data":{"value":"after"}}']);
    mode = variant; requests.length = 0;
    const result = await run(['confirm', saved.request, '--digest', saved.digest]);
    assert.equal(result.code, 1, result.stdout);
    const report = decode(result.stdout) as any;
    assert.equal(report.state, 'failed'); assert.equal(report.results.length, 1); assert.equal(report.results[0].observed[0].name, 'selected');
    assert.equal(objects.get(`${core}/configmaps/selected`)!.data.value, variant === 'conflict' ? 'before' : 'after');
    await run(['confirm', saved.request, '--digest', saved.digest]); assert.equal(effects.length, 1);
  });
  await test('AC-016-selection-cannot-widen', async () => {
    const saved = await approved(['delete', 'configmaps', '-n', ns, '--all']);
    objects.set(`${core}/configmaps/newcomer`, doc('v1', 'ConfigMap', 'newcomer', ns));
    const result = await run(['confirm', saved.request, '--digest', saved.digest]);
    assert.equal((decode(result.stdout) as any).error.code, 'PREVIEW_STALE'); assert.equal(effects.length, 0);
  });
  await test('AC-016-collection-delete', async () => {
    const saved = await approved(['delete', 'configmaps', '-n', ns, '--all']);
    const result = await confirm(saved);
    assert.equal(result.results.length, 2); assert(result.results.every((item: any) => item.operation === 'OP-016'));
    assert(!objects.has(`${core}/configmaps/selected`)); assert(!objects.has(`${core}/configmaps/decoy`));
    assert(effects.every(item => item.path === `${core}/configmaps` && item.body.preconditions.uid));
  });
  await test('AC-016-partial-bulk-failure', async () => {
    const saved = await approved(['delete', 'configmaps', '-n', ns, '--all']);
    mode = 'partial-bulk';
    const result = await run(['confirm', saved.request, '--digest', saved.digest]);
    assert.equal(result.code, 1, result.stdout);
    const report = decode(result.stdout) as any;
    assert.equal(report.results[0].outcome, 'committed'); assert.equal(report.results[1].upstreamStatus, 403);
    assert.equal([...objects.keys()].filter(path => path.startsWith(`${core}/configmaps/`)).length, 1);
  });
  await test('AC-027-server-dry-run', async () => {
    const before = structuredClone(objects.get(`${core}/configmaps/selected`));
    const output = await run(['server-dry-run', '--', 'patch', 'cm', 'selected', '-n', ns, '--type=merge', '-p', '{"data":{"value":"after"}}']);
    assert.equal(output.code, 0, output.stdout + output.stderr); assert.equal(effects.length, 1); assert(effects[0]!.dryRun); assert.deepEqual(objects.get(`${core}/configmaps/selected`), before);
  });
  await test('AC-024-scale-conflict-and-target', async () => {
    const decoy = structuredClone(objects.get(`${apps}/deployments/decoy`));
    await confirm(await approved(['scale', 'deployment/selected', '-n', ns, '--replicas=4', '--current-replicas=2']));
    assert.equal(objects.get(`${apps}/deployments/selected`)!.spec.replicas, 4); assert.deepEqual(objects.get(`${apps}/deployments/decoy`), decoy);
    const conflict = await run(['prepare', '--', 'scale', 'deployment/selected', '-n', ns, '--replicas=8', '--current-replicas=2']);
    assert.notEqual(conflict.code, 0); assert.equal(effects.length, 1);
  });
  await test('AC-024-scale-patch-variant', async () => {
    await confirm(await approved(['scale', 'deployment/selected', '-n', ns, '--replicas=4']));
    assert.equal(objects.get(`${apps}/deployments/selected`)!.spec.replicas, 4);
    assert(effects.some(effect => effect.method === 'PATCH' && effect.path.endsWith('/scale')));
  });
  for (const [name, args, verify] of [
    ['cordon', ['cordon', 'b3-node'], () => assert.equal(objects.get('/api/v1/nodes/b3-node')!.spec.unschedulable, true)],
    ['uncordon', ['uncordon', 'b3-node'], () => assert.equal(objects.get('/api/v1/nodes/b3-node')!.spec.unschedulable, false)],
    ['taint', ['taint', 'node', 'b3-node', 'maintenance=true:NoSchedule'], () => assert.equal(objects.get('/api/v1/nodes/b3-node')!.spec.taints[0].key, 'maintenance')],
    ['certificate-approve', ['certificate', 'approve', 'b3-csr'], () => assert.equal(objects.get('/apis/certificates.k8s.io/v1/certificatesigningrequests/b3-csr')!.status.conditions[0].type, 'Approved')],
    ['certificate-deny', ['certificate', 'deny', 'b3-csr'], () => assert.equal(objects.get('/apis/certificates.k8s.io/v1/certificatesigningrequests/b3-csr')!.status.conditions[0].type, 'Denied')],
    ['rollout-pause', ['rollout', 'pause', 'deployment/selected', '-n', ns], () => assert.equal(objects.get(`${apps}/deployments/selected`)!.spec.paused, true)],
    ['rollout-restart', ['rollout', 'restart', 'deployment/selected', '-n', ns], () => assert(objects.get(`${apps}/deployments/selected`)!.spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt'])],
    ['label', ['label', 'configmap', 'selected', '-n', ns, 'maintenance=true'], () => assert.equal(objects.get(`${core}/configmaps/selected`)!.metadata.labels.maintenance, 'true')],
    ['annotate', ['annotate', 'configmap', 'selected', '-n', ns, 'description=after'], () => assert.equal(objects.get(`${core}/configmaps/selected`)!.metadata.annotations.description, 'after')],
    ['set-image', ['set', 'image', 'deployment/selected', '-n', ns, 'app=synthetic:v2'], () => assert.equal(objects.get(`${apps}/deployments/selected`)!.spec.template.spec.containers[0].image, 'synthetic:v2')],
    ['set-env', ['set', 'env', 'deployment/selected', '-n', ns, 'MODE=after'], () => assert.equal(objects.get(`${apps}/deployments/selected`)!.spec.template.spec.containers[0].env[0].value, 'after')],
    ['set-resources', ['set', 'resources', 'deployment/selected', '-n', ns, '--limits=cpu=100m'], () => assert.equal(objects.get(`${apps}/deployments/selected`)!.spec.template.spec.containers[0].resources.limits.cpu, '100m')],
    ['set-serviceaccount', ['set', 'serviceaccount', 'deployment/selected', 'synthetic-account', '-n', ns], () => assert.equal(objects.get(`${apps}/deployments/selected`)!.spec.template.spec.serviceAccountName, 'synthetic-account')],
    ['set-selector', ['set', 'selector', 'service/selected', 'app=after', '-n', ns], () => assert.equal(objects.get(`${core}/services/selected`)!.spec.selector.app, 'after')],
    ['set-subject', ['set', 'subject', 'rolebinding/selected', '--user=synthetic-user', '-n', ns], () => assert.equal(objects.get(`/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/rolebindings/selected`)!.subjects[0].name, 'synthetic-user')],
    ['rollout-undo', ['rollout', 'undo', 'deployment/selected', '-n', ns, '--to-revision=1'], () => assert.equal(objects.get(`${apps}/deployments/selected`)!.spec.template.spec.containers[0].image, 'synthetic:v0')],
  ] as const) await test(`B3-operation-${name}`, async () => {
    objects.set(`${core}/services/selected`, doc('v1', 'Service', 'selected', ns, { spec: { selector: { app: 'before' }, ports: [{ port: 80 }] } }));
    const decoy = structuredClone(objects.get('/api/v1/nodes/b3-decoy'));
    await confirm(await approved([...args])); verify(); assert.deepEqual(objects.get('/api/v1/nodes/b3-decoy'), decoy);
  });
  await test('B3-rollout-resume', async () => {
    objects.get(`${apps}/deployments/selected`)!.spec.paused = true;
    await confirm(await approved(['rollout', 'resume', 'deployment/selected', '-n', ns]));
    assert.equal(objects.get(`${apps}/deployments/selected`)!.spec.paused ?? false, false);
  });
  await test('B3-rollout-read-status-history', async () => {
    environment.KUBERNETES_AXI_READ_ONLY = 'true';
    const history = await output(['rollout', 'history', 'deployment/selected', '-n', ns]); assert.match(history.text, /1/);
    const status = await output(['rollout', 'status', 'deployment/selected', '-n', ns, '--watch=false']); assert.match(status.text, /successfully rolled out/);
    assert.equal(effects.length, 0);
  });
  for (const [name, args, target, verify] of [
    ['create-deployment-typed', ['create', 'deployment', 'b3-created', '-n', ns, '--image=synthetic:v1', '--replicas=2'], `${apps}/deployments/b3-created`, (body: any) => assert.equal(body.spec.replicas, 2)],
    ['run', ['run', 'b3-run', '-n', ns, '--image=synthetic:v1', '--restart=Never'], `${core}/pods/b3-run`, (body: any) => assert.equal(body.spec.containers[0].image, 'synthetic:v1')],
    ['expose', ['expose', 'deployment/selected', '-n', ns, '--name=b3-service', '--port=80'], `${core}/services/b3-service`, (body: any) => assert.equal(body.spec.ports[0].port, 80)],
    ['autoscale', ['autoscale', 'deployment/selected', '-n', ns, '--name=b3-hpa', '--min=1', '--max=3', '--cpu-percent=70'], `/apis/autoscaling/v1/namespaces/${ns}/horizontalpodautoscalers/b3-hpa`, (body: any) => assert.equal(body.spec.maxReplicas, 3)],
    ['disruption-budget', ['create', 'poddisruptionbudget', 'b3-budget', '-n', ns, '--selector=app=selected', '--min-available=1', '--validate=false'], `/apis/policy/v1/namespaces/${ns}/poddisruptionbudgets/b3-budget`, (body: any) => assert.equal(body.spec.minAvailable, 1)],
  ] as const) await test(`B3-operation-${name}`, async () => {
    await confirm(await approved([...args])); verify(objects.get(target));
  });
  for (const [name, variant, remaining] of [['drain-success', '', 0], ['drain-denied', 'deny-eviction', 2], ['drain-partial', 'partial-drain', 1]] as const) await test(`AC-023-${name}`, async () => {
    const saved = await approved(['drain', 'b3-node', '--force', '--ignore-daemonsets']);
    assert.equal(effects.length, 0);
    mode = variant;
    const result = await run(['confirm', saved.request, '--digest', saved.digest]);
    assert.equal(result.code, variant ? 1 : 0, result.stdout);
    assert.equal([...objects.keys()].filter(path => path.includes('/pods/')).length, remaining);
    assert.equal(objects.get('/api/v1/nodes/b3-node')!.spec.unschedulable, true);
    if (variant) { const report = decode(result.stdout) as any; assert.equal(report.state, 'failed'); assert.equal(report.results.at(-1).upstreamStatus, 403); assert(new URL(report.results.at(-1).path, 'https://local').pathname.endsWith('/eviction')); }
  });
  await test('AC-023-drain-accepted-still-pending', async () => {
    const saved = await approved(['drain', 'b3-node', '--force', '--ignore-daemonsets']);
    mode = 'eviction-pending';
    const result = await run(['confirm', saved.request, '--digest', saved.digest]);
    assert.equal(result.code, 1, result.stdout);
    const report = decode(result.stdout) as any;
    assert.equal(report.complete, false); assert.equal(report.results.filter((result: any) => result.outcome === 'accepted_pending').length, 2);
    assert.equal([...objects.keys()].filter(path => path.includes('/pods/')).length, 2);
  });
  await test('AC-021-028-reviews-own-permissions', async () => {
    environment.KUBERNETES_AXI_READ_ONLY = 'true';
    assert.equal((await output(['auth', 'whoami'])).reviews[0].status.userInfo.username, 'synthetic-identity');
    mode = 'access-denied'; const denied = await run(['auth', 'can-i', 'get', 'secrets', '-n', ns]); assert.equal(denied.code, 1);
    mode = 'review-denied'; const forbidden = await run(['auth', 'whoami']); assert.equal(forbidden.code, 1);
    assert(effects.every(item => item.method === 'POST' && /selfsubject(reviews|accessreviews)$/.test(item.path)));
  });
  await test('B3-tampered-request', async () => {
    const saved = await approved(['delete', 'configmap', 'selected', '-n', ns]);
    const file = join(directory, 'requests', saved.request, 'request.json'); const content = JSON.parse(readFileSync(file, 'utf8'));
    content.plan.changes[0].path = `${core}/configmaps/decoy`; writeFileSync(file, JSON.stringify(content));
    const result = await run(['confirm', saved.request, '--digest', saved.digest]); assert.equal((decode(result.stdout) as any).error.code, 'PREVIEW_INVALID'); assert.equal(effects.length, 0);
    assert(readdirSync(join(directory, 'requests')).length > 0);
  });
}
