import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fstatSync, writeSync } from 'node:fs';
import { Ajv } from 'ajv';
import { configPath } from './credentials.js';
import { Failure } from './errors.js';
import { requireWrites } from './grammar.js';
import type { Invocation } from './grammar.js';
import type { Redactor } from './redaction.js';
import { privateDirectory, readPrivate, writePrivate } from './private-files.js';
import { remoteSession } from './remote-session.js';
import { routeEffect } from './route-policy.js';

const execute = promisify(execFile);
interface Metadata { name?: string; namespace?: string; uid?: string; resourceVersion?: string; continue?: string }
interface Document { apiVersion?: string; kind?: string; metadata?: Metadata; items?: Document[]; [field: string]: unknown }
interface Reply { status: number; body: Document }
interface Snapshot { path: string; objects: { name: string; namespace: string; uid: string; version: string }[]; absent: boolean; collection: boolean }
interface Change { operation: string; method: string; path: string; target: string; contentType: string; body: unknown; wire: string; inputBase64: string }
interface Execution { argv: string[]; target: string; route: string; query: string }
interface Plan { version: 1; key: string; binding: string; command: string; namespace: string; awaitDeletion: boolean; snapshots: Snapshot[]; changes: Change[]; display: object; execution?: Execution }
interface Saved { plan: Plan; digest: string; state: 'prepared' | 'running' | 'complete' | 'failed'; results: Result[] }
interface Result { operation: string; method: string; path: string; outcome: string; upstreamStatus?: number; observed?: Snapshot['objects'] }
interface Config {
  'current-context'?: string;
  clusters: { cluster: { server: string; 'certificate-authority-data': string; 'tls-server-name'?: string } }[];
  users: { user: { token?: string; 'client-certificate-data'?: string; 'client-key-data'?: string; exec?: { apiVersion: string; command: string; args: string[]; provideClusterInfo?: boolean } } }[];
}
const validDocument = new Ajv().compile<Document>({ type: 'object', properties: {
  kind: { type: 'string' }, apiVersion: { type: 'string' },
  metadata: { type: 'object', properties: Object.fromEntries(['name', 'namespace', 'uid', 'resourceVersion', 'continue'].map(name => [name, { type: 'string' }])) },
  items: { type: 'array', items: { type: 'object' } },
} });
const root = (config?: string): string => join(dirname(configPath(config)), 'requests');
const mac = (key: string, value: unknown): string => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
function prefix(invocation: Invocation): string {
  const selectors = [['--config', invocation.config], ['--profile', invocation.profile], ['--native-config', invocation.nativeConfig]];
  return 'kubernetes-axi' + selectors.filter(([, value]) => value !== undefined).map(([flag, value]) => ` ${flag} '${value!.replaceAll("'", "'\\''")}'`).join('') + (invocation.trustExec ? ' --trust-exec' : '');
}

async function savedRequest(invocation: Invocation): Promise<{ saved: Saved; directory: string; signingKey: string }> {
  const workflow = invocation.workflow;
  if (!workflow || !('key' in workflow)) throw new Failure('USAGE', 'Select a prepared request.', 2);
  const directory = join(root(invocation.config), workflow.key);
  const signingKey = await readPrivate(join(directory, 'key'), true);
  const value = JSON.parse(await readPrivate(join(directory, 'request.json'), true)) as Saved;
  const digest = mac(signingKey, value.plan);
  if (value.plan.version !== 1 || value.plan.key !== workflow.key || typeof value.digest !== 'string' || value.digest.length !== digest.length || !timingSafeEqual(Buffer.from(value.digest), Buffer.from(digest))) throw new Failure('PREVIEW_INVALID', 'The saved request was changed; prepare a new request.');
  return { saved: value, directory, signingKey };
}

export async function preview(invocation: Invocation): Promise<object> {
  const { saved } = await savedRequest(invocation);
  return { request: saved.plan.key, digest: saved.digest, state: saved.state, ...saved.plan.display,
    help: [`${prefix(invocation)} confirm ${saved.plan.key} --digest ${saved.digest}`] };
}

function publicBody(value: unknown, secret = false): unknown {
  if (Array.isArray(value)) return value.map(item => publicBody(item, secret));
  if (!value || typeof value !== 'object') return value;
  const body = value as Record<string, unknown>;
  secret ||= body.kind === 'Secret';
  const pointer = typeof body.path === 'string' ? body.path.split('/').slice(1).map(part => part.replaceAll('~1', '/').replaceAll('~0', '~')) : [];
  const protectedValue = pointer.some(key => secret && ['data', 'binaryData', 'stringData', 'annotations'].includes(key) || key === 'kubectl.kubernetes.io/last-applied-configuration');
  // Secret payloads and credential-bearing annotations never enter public previews.
  return Object.fromEntries(Object.entries(body).map(([key, item]) => [key,
    key === 'value' && protectedValue || secret && ['data', 'binaryData', 'stringData', 'annotations'].includes(key) || key === 'kubectl.kubernetes.io/last-applied-configuration' ? '[REDACTED]' : publicBody(item, secret)]));
}

function snapshot(path: string, reply: Reply): Snapshot {
  if (reply.status === 404) return { path, objects: [], absent: true, collection: false };
  if (reply.status >= 300) throw new Failure('ACCESS_DENIED', 'The selected identity cannot read the exact mutation targets.', 1, { upstreamStatus: reply.status });
  const collection = Array.isArray(reply.body.items);
  const items = collection ? reply.body.items! : [reply.body];
  if (items.length > 100 || reply.body.metadata?.continue) throw new Failure('SELECTION_LIMIT', 'Narrow the selection to at most 100 fully enumerated objects.');
  const objects = items.map(item => {
    if (!validDocument(item) || !item.metadata?.name || !item.metadata.uid || !item.metadata.resourceVersion) throw new Failure('UPSTREAM_INVALID', 'Mutation targets require a name, UID and resourceVersion.');
    const route = new URL(path, 'http://local').pathname;
    const namespace = /\/namespaces\/([^/]+)\//.exec(route)?.[1];
    const name = route.replace(/\/(?:scale|approval|ephemeralcontainers)$/, '').split('/').at(-1);
    if (namespace && item.metadata.namespace !== namespace || !collection && item.metadata.name !== name) throw new Failure('UPSTREAM_INVALID', 'The snapshot does not match the selected name and namespace.');
    return { name: item.metadata.name, namespace: item.metadata.namespace ?? '', uid: item.metadata.uid, version: item.metadata.resourceVersion };
  }).sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
  return { path, objects, absent: false, collection };
}

function operation(method: string, path: string): string {
  path = path.split('?')[0]!;
  if (/\/selfsubjectaccessreviews$|\/selfsubjectrulesreviews$|\/subjectaccessreviews$|\/localsubjectaccessreviews$/.test(path)) return 'OP-021';
  if (/\/selfsubjectreviews$/.test(path)) return 'OP-028';
  if (/\/scale$/.test(path)) return 'OP-024';
  if (/\/approval$/.test(path)) return 'OP-022';
  if (/\/eviction$/.test(path)) return 'OP-023';
  return method === 'POST' ? 'OP-012' : method === 'PUT' ? 'OP-013' : method === 'PATCH' ? 'OP-014' : 'OP-015';
}

export async function mutationSession(configFile: string, invocation: Invocation, namespace: string, redactor: Redactor, signal: AbortSignal, compatibleVersion: (value: unknown) => void, nativeBinding?: string): Promise<{
  config: object; argv?: string[]; prepared?: boolean; finish: (success?: boolean) => Promise<object>; close: () => Promise<void>;
}> {
  const config = JSON.parse(await readFile(configFile, 'utf8')) as Config;
  const cluster = config.clusters[0]!.cluster;
  const user = config.users[0]!.user;
  let count = 0;
  let bytes = 0;
  const deadline = Date.now() + 15_000;
  let credentialIssuance = invocation.command.path === 'create token';
  const upstream = async (method: string, path: string, body?: unknown, contentType = 'application/json', wire?: string): Promise<Reply> => {
    if (++count > 256 || Date.now() >= deadline) throw new Failure('UPSTREAM_TIMEOUT', 'The bounded operation exhausted its request or time budget.');
    if (!/^\/(?:api(?:\/|\?|$)|apis(?:\/|\?|$)|version(?:\?|$)|openapi\/)/.test(path) || path.includes('..') || /\/\/|%2f|%2e/i.test(path)) throw new Failure('USAGE', 'Only discovered Kubernetes API routes are supported.', 2);
    const effect = path.startsWith('/openapi/') ? 'read' : routeEffect(method, path);
    if (['connection', 'execution'].includes(effect) || effect === 'credentials' && !credentialIssuance) throw new Failure('EFFECT_UNCLASSIFIED', 'This route requires its explicit bounded execution or acquisition capability.');
    let token = user.token;
    let cert = user['client-certificate-data'] ? Buffer.from(user['client-certificate-data'], 'base64').toString() : undefined;
    let key = user['client-key-data'] ? Buffer.from(user['client-key-data'], 'base64').toString() : undefined;
    if (user.exec) {
      // This is the existing private broker shim, never the configured helper itself.
      const info = { apiVersion: user.exec.apiVersion, kind: 'ExecCredential', spec: { interactive: false,
        ...(user.exec.provideClusterInfo ? { cluster: { server: cluster.server, 'certificate-authority-data': cluster['certificate-authority-data'] } } : {}) } };
      const acquired = JSON.parse((await execute(user.exec.command, user.exec.args, { signal, timeout: 8000, maxBuffer: 1024 * 1024,
        env: { KUBERNETES_EXEC_INFO: JSON.stringify(info) } })).stdout) as { status: { token?: string; clientCertificateData?: string; clientKeyData?: string } };
      token = acquired.status.token; cert = acquired.status.clientCertificateData; key = acquired.status.clientKeyData;
    }
    redactor.register(token, cert, key);
    const payload = wire ?? (body === undefined ? undefined : JSON.stringify(body));
    return await new Promise<Reply>((resolve, reject) => {
      const call = request(new URL(cluster.server.replace(/\/$/, '') + path), { method, ca: Buffer.from(cluster['certificate-authority-data'], 'base64'),
        ...(cluster['tls-server-name'] ? { servername: cluster['tls-server-name'] } : {}), ...(cert ? { cert } : {}), ...(key ? { key } : {}), signal,
        headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { 'content-type': contentType, 'content-length': Buffer.byteLength(payload) }) },
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) call.destroy(new Failure('OUTPUT_LIMIT', 'Narrow the operation to less than 4 MiB of API output.'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
            if (!validDocument(body)) throw new Error('invalid');
            resolve({ status: response.statusCode ?? 502, body });
          } catch { reject(new Failure('UPSTREAM_INVALID', 'The API returned an invalid JSON envelope.')); }
        });
      });
      call.on('error', reject);
      call.setTimeout(Math.min(5000, Math.max(1, deadline - Date.now())), () => call.destroy(new Failure('UPSTREAM_TIMEOUT', 'The bounded request timed out.')));
      call.end(payload);
    });
  };
  const workflow = invocation.workflow;
  if (workflow?.kind === 'confirm') {
    requireWrites();
    const { saved, directory, signingKey } = await savedRequest(invocation);
    credentialIssuance = saved.plan.changes.some(change => change.operation === 'OP-030');
    if ((saved.plan.changes.some(change => change.operation === 'OP-016') || saved.plan.changes.filter(change => change.method === 'DELETE').length > 1) && !/^(true|1)$/i.test(process.env.KUBERNETES_AXI_COLLECTION_DELETE ?? '')) throw new Failure('CAPABILITY_UNAVAILABLE', 'Bulk deletion also requires KUBERNETES_AXI_COLLECTION_DELETE=true.');
    const binding = mac(signingKey, nativeBinding ?? config);
    if (saved.digest !== workflow.digest || saved.plan.binding !== binding) throw new Failure('PREVIEW_MISMATCH', 'Select the original cluster and identity and supply the exact preview digest.');
    if (saved.plan.changes.some(change => change.operation === 'OP-030')) {
      if (!/^(true|1)$/i.test(process.env.KUBERNETES_AXI_ACQUIRE_CREDENTIAL ?? '')) throw new Failure('CAPABILITY_UNAVAILABLE', 'Token issuance requires KUBERNETES_AXI_ACQUIRE_CREDENTIAL=true.');
      const fd = invocation.credentialFd;
      if (fd === undefined) throw new Failure('PRIVATE_DELIVERY_REQUIRED', 'Supply --credential-fd <inherited-private-pipe> on confirmation.');
      try {
        const sink = fstatSync(fd);
        if (!sink.isFIFO() && !sink.isSocket()) throw new Error('not a pipe');
        for (const publicFd of [1, 2]) {
          const stream = fstatSync(publicFd);
          if (sink.dev === stream.dev && sink.ino === stream.ino) throw new Error('public stream');
        }
      } catch { throw new Failure('PRIVATE_DELIVERY_REQUIRED', 'The credential sink must be an inherited private pipe distinct from public output.'); }
    }
    const report = (): object => ({ request: saved.plan.key, state: saved.state, complete: saved.state === 'complete', results: saved.results });
    const persist = async (): Promise<void> => {
      await writePrivate(join(directory, 'request.json'), JSON.stringify(saved));
      await writePrivate(join(directory, 'outcome.json'), JSON.stringify(redactor.value(report())));
    };
    const reconcile = async (change: Change): Promise<Snapshot['objects']> => snapshot(change.target, await upstream('GET', change.target)).objects;
    if (saved.state === 'complete') return { config, finish: async () => report(), close: async () => {} };
    if (saved.state !== 'prepared') {
      for (const change of saved.plan.changes) saved.results.push({ operation: change.operation, method: 'GET', path: change.target, outcome: 'reconciled_without_retry', observed: await reconcile(change) });
      process.exitCode = 1;
      return { config, finish: async () => report(), close: async () => {} };
    }
    compatibleVersion((await upstream('GET', '/version')).body);
    for (const selected of saved.plan.snapshots) {
      const current = snapshot(selected.path, await upstream('GET', selected.path));
      if (JSON.stringify(current) !== JSON.stringify(selected)) throw new Failure('PREVIEW_STALE', 'Targets or resourceVersions changed; prepare and preview a new request.');
    }
    // An atomic claim makes simultaneous or interrupted confirmations one-shot.
    try { await rename(join(directory, 'claim'), join(directory, 'claimed')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new Failure('REQUEST_CLAIMED', 'This request was already claimed. Confirm again only to reconcile its recorded outcome.');
    }
    saved.state = 'running';
    await persist();
    if (saved.plan.execution) {
      const execution = saved.plan.execution;
      const session = await remoteSession(config, saved.plan.namespace, execution.target, execution.route, execution.query, signal);
      return { ...session, argv: execution.argv, finish: async (success = true) => {
        saved.state = success ? 'complete' : 'failed';
        saved.results.push({ operation: 'OP-017', method: 'CONNECT', path: execution.route, outcome: success ? 'complete' : 'failed' });
        await persist();
        return report();
      } };
    }
    let pending = false;
    for (const change of saved.plan.changes) {
      const result: Result = { operation: change.operation, method: change.method, path: change.path, outcome: 'uncertain' };
      saved.results.push(result);
      await persist();
      try {
        const reply = await upstream(change.method, change.path, change.body, change.contentType, change.wire);
        if (change.operation === 'OP-030') {
          const status = reply.body.status as { token?: unknown; expirationTimestamp?: unknown } | undefined;
          const token = status?.token;
          if (typeof token === 'string') redactor.register(token);
          if (reply.status >= 300 || typeof token !== 'string' || !token || typeof status?.expirationTimestamp !== 'string' || Date.parse(status.expirationTimestamp) <= Date.now()) throw new Failure('CREDENTIAL_ACQUISITION_FAILED', 'The API did not issue a valid bounded credential.');
          if (signal.aborted) throw new Failure('CANCELLED', 'Credential delivery was cancelled.');
          writeSync(invocation.credentialFd!, token + '\n');
          result.upstreamStatus = reply.status;
          result.outcome = 'delivered';
          saved.state = 'complete';
          await persist();
          return { config, finish: async () => report(), close: async () => {} };
        }
        result.upstreamStatus = reply.status;
        result.outcome = reply.status < 300 ? 'committed' : 'failed';
        if (result.outcome === 'committed' && change.method !== 'DELETE' && !change.path.split('?')[0]!.endsWith('/eviction')) {
          const named = change.target.replace(/\/(?:scale|approval|ephemeralcontainers)$/, '').split('/').at(-1);
          const metadata = reply.body.metadata;
          if (!metadata || metadata.name !== named || !metadata.uid || !metadata.resourceVersion) result.outcome = 'uncertain';
        }
      } catch { result.outcome = 'uncertain'; }
      if (result.outcome !== 'committed') {
        saved.state = 'failed';
        try { result.observed = await reconcile(change); }
        catch { result.outcome += '_reconciliation_unavailable'; }
        await persist();
        process.exitCode = 1;
        return { config, finish: async () => report(), close: async () => {} };
      }
      if (saved.plan.awaitDeletion && (change.method === 'DELETE' || change.path.split('?')[0]!.endsWith('/eviction'))) {
        try {
          result.observed = await reconcile(change);
          if (result.observed.length) { result.outcome = 'accepted_pending'; pending = true; }
        } catch { result.outcome = 'accepted_reconciliation_unavailable'; pending = true; }
      }
      await persist();
    }
    saved.state = pending ? 'failed' : 'complete';
    if (pending) process.exitCode = 1;
    await persist();
    return { config, finish: async () => report(), close: async () => {} };
  }
  const snapshots = new Map<string, Snapshot>();
  compatibleVersion((await upstream('GET', '/version')).body);
  const changes: Change[] = [];
  const reviews: { operation: string; upstreamStatus: number; status: unknown }[] = [];
  let failure: unknown;
  const capability = randomBytes(32).toString('hex');
  redactor.register(capability);
  const remember = async (path: string, reply?: Reply): Promise<Snapshot> => {
    const saved = snapshots.get(path);
    if (saved) return saved;
    const selected = snapshot(path, reply ?? await upstream('GET', path));
    snapshots.set(path, selected);
    return selected;
  };
  let execution: Execution | undefined;
  if (['exec', 'attach'].includes(invocation.command.path)) {
    if (user.exec) throw new Failure('CAPABILITY_UNAVAILABLE', 'Helper-backed execution requires a reviewed containment boundary.');
    const name = invocation.positionals[0]?.replace(/^pods?\//, '') ?? '';
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Failure('USAGE', 'Bounded execution requires one named pod.', 2);
    const target = `/api/v1/namespaces/${namespace}/pods/${name}`;
    const pod = await upstream('GET', target);
    await remember(target, pod);
    const containers = (pod.body.spec as { containers?: { name: string }[] } | undefined)?.containers ?? [];
    const container = invocation.flags.get('container') ?? containers[0]?.name;
    if (!container || !containers.some(item => item.name === container)) throw new Failure('USAGE', 'Select a container in the named pod.', 2);
    const query = new URLSearchParams({ container, stdout: 'true', stderr: 'true', timeout: '5s' });
    if (invocation.command.path === 'exec') {
      const delimiter = invocation.argv.indexOf('--');
      if (delimiter < 0 || delimiter === invocation.argv.length - 1) throw new Failure('USAGE', 'Use exec <pod> -- <command> [arguments].', 2);
      for (const arg of invocation.argv.slice(delimiter + 1)) query.append('command', arg);
    }
    execution = { argv: [...invocation.argv], target, route: `${target}/${invocation.command.path}`, query: query.toString() };
    // Container flags must precede the remote command delimiter.
    execution.argv.splice(invocation.argv.indexOf('--') < 0 ? execution.argv.length : invocation.argv.indexOf('--'), 0, '--namespace', namespace, '--container', container);
  }
  const server = createServer((incoming, response) => {
    void (async () => {
      try {
        // Upstream credentials stay in this process. The child gets a disposable capability.
        if (!incoming.url?.startsWith(`/${capability}/`)) { response.writeHead(403).end(); return; }
        let path = incoming.url.slice(capability.length + 1);
        let method = incoming.method!;
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of incoming) {
          size += Buffer.byteLength(chunk);
          if (size > 1024 * 1024) throw new Failure('OUTPUT_LIMIT', 'Mutation payload exceeds 1 MiB.');
          chunks.push(Buffer.from(chunk));
        }
        const input = Buffer.concat(chunks);
        const protobuf = String(incoming.headers['content-type']).includes('application/vnd.kubernetes.protobuf');
        const body: unknown = !input.length ? undefined : protobuf ? (await import('./protobuf.js')).decodeKubernetes(input) : JSON.parse(input.toString());
        let reply: Reply;
        if (method === 'GET') {
          reply = await upstream(method, path);
          if (workflow?.kind === 'prepare' && reply.status < 300 && (reply.body.metadata?.uid || reply.body.items)) await remember(path, reply);
        } else if (invocation.command.effect === 'authorization') {
          if (method !== 'POST' || !/^\/apis\/(?:authorization.k8s.io\/v1\/(?:selfsubjectaccessreviews|selfsubjectrulesreviews)|authentication.k8s.io\/v1(?:beta1|alpha1)?\/selfsubjectreviews)$/.test(path.split('?')[0]!)) throw new Failure('EFFECT_UNCLASSIFIED', 'Only the selected non-persistent review API is allowed.');
          reply = await upstream(method, path, body);
          reviews.push({ operation: operation(method, path), upstreamStatus: reply.status, status: reply.body.status });
        } else {
          requireWrites();
          if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Failure('EFFECT_UNCLASSIFIED', 'Unsupported mutation method.');
          const url = new URL(path, 'http://local');
          url.searchParams.delete('dryRun');
          path = url.pathname + url.search;
          const contentType = protobuf ? 'application/json' : String(incoming.headers['content-type'] ?? 'application/json');
          let target = url.pathname;
          if (target.endsWith('/approval')) target = target.slice(0, -'/approval'.length);
          if (target.endsWith('/ephemeralcontainers')) target = target.slice(0, -'/ephemeralcontainers'.length);
          let payload = body;
          const acquisition = invocation.command.path === 'create token';
          if (acquisition) {
            if (method !== 'POST' || !new RegExp(`^/api/v1/namespaces/${namespace}/serviceaccounts/[a-z0-9][a-z0-9.-]*/token$`).test(url.pathname)) throw new Failure('EFFECT_UNCLASSIFIED', 'Only the selected TokenRequest endpoint is permitted.');
            target = url.pathname.slice(0, -'/token'.length);
          } else if (method === 'POST') {
            if (!validDocument(body) || !body.metadata?.name) throw new Failure('USAGE', 'Preparation requires explicit resource names; generateName is not supported.', 2);
            target = target.endsWith('/eviction') ? target.slice(0, -'/eviction'.length) : `${target}/${body.metadata.name}`;
          }
          if (workflow?.kind === 'server-dry-run') {
            url.searchParams.set('dryRun', 'All');
            changes.push({ operation: 'OP-027', method, path, target, contentType, body, wire: JSON.stringify(body), inputBase64: input.toString('base64') });
            reply = await upstream(method, url.pathname + url.search, body, contentType);
            response.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
            return;
          }
          const selected = await remember(target);
          if (selected.collection) throw new Failure('USAGE', 'Use delete <type> --all or a selector so preparation freezes individual targets.', 2);
          const object = selected.objects[0];
          if (!object && !(method === 'POST' && !url.pathname.endsWith('/eviction') || method === 'PATCH' && contentType.includes('apply-patch'))) throw new Failure('PREVIEW_TARGET_ABSENT', 'Destructive operations require an existing target with UID and resourceVersion; prepare a new request after selecting an existing object.');
          if (acquisition) {
            const spec = (body as { spec?: { expirationSeconds?: number } }).spec;
            if (!spec || typeof spec.expirationSeconds !== 'number' || spec.expirationSeconds <= 0 || spec.expirationSeconds > 3600) throw new Failure('USAGE', 'Request a positive token duration of at most one hour.', 2);
          } else if (method === 'DELETE' || target !== url.pathname && url.pathname.endsWith('/eviction')) {
            const options = { ...(method === 'POST' ? (body as Document).deleteOptions as Record<string, unknown> : body as Record<string, unknown>), preconditions: { uid: object!.uid, resourceVersion: object!.version } };
            delete (options as Record<string, unknown>).dryRun;
            payload = method === 'POST' ? { ...(body as object), deleteOptions: options } : options;
          } else if (object && method === 'PATCH' && contentType.includes('json-patch')) {
            if (!Array.isArray(body)) throw new Failure('UPSTREAM_INVALID', 'Invalid JSON patch.');
            payload = [{ op: 'test', path: '/metadata/uid', value: object.uid }, { op: 'test', path: '/metadata/resourceVersion', value: object.version }, ...body];
          } else if (object && ['PUT', 'PATCH'].includes(method)) {
            if (!validDocument(body)) throw new Failure('UPSTREAM_INVALID', 'Invalid mutation body.');
            if (body.metadata?.resourceVersion && body.metadata.resourceVersion !== object.version) throw new Failure('RESOURCE_CONFLICT', 'The supplied resourceVersion conflicts with the selected object.');
            payload = { ...body, metadata: { ...body.metadata, resourceVersion: object.version, uid: object.uid } };
          } else if (selected.absent && method === 'PATCH' && contentType.includes('apply-patch')) {
            if (!validDocument(body) || !body.metadata?.name || body.metadata.name !== target.split('/').at(-1)) throw new Failure('UPSTREAM_INVALID', 'Invalid apply creation body.');
            method = 'POST';
            url.pathname = target.slice(0, target.lastIndexOf('/'));
            url.searchParams.delete('force');
            path = url.pathname + url.search;
          }
          if (changes.length >= 100) throw new Failure('SELECTION_LIMIT', 'Narrow the operation to at most 100 mutations.');
          const bulk = invocation.command.path === 'delete' && (invocation.flags.get('all') === 'true' || invocation.flags.has('selector') || invocation.flags.has('field-selector') || invocation.positionals.length > 2 || invocation.positionals.some(value => value.includes(',')));
          if (bulk) {
            if (!/^(true|1)$/i.test(process.env.KUBERNETES_AXI_COLLECTION_DELETE ?? '')) throw new Failure('CAPABILITY_UNAVAILABLE', 'Bulk deletion also requires KUBERNETES_AXI_COLLECTION_DELETE=true.');
            const collection = new URL(target.slice(0, target.lastIndexOf('/')), 'http://local');
            collection.searchParams.set('fieldSelector', `metadata.name=${object!.name}`);
            path = collection.pathname + collection.search;
          }
          const change = { operation: acquisition ? 'OP-030' : bulk ? 'OP-016' : operation(method, url.pathname), method, path, target, contentType: method === 'POST' ? 'application/json' : contentType, body: payload, wire: JSON.stringify(payload), inputBase64: input.toString('base64') };
          changes.push(change);
          {
            // Preparation records intent only. It never sends a mutation upstream.
            const before = object ? await upstream('GET', target) : undefined;
            reply = { status: method === 'POST' ? 201 : 200, body: acquisition ? { kind: 'TokenRequest', apiVersion: 'authentication.k8s.io/v1', status: { token: 'preparation-only', expirationTimestamp: new Date(Date.now() + 60_000).toISOString() } } : method === 'DELETE' ? { kind: 'Status', apiVersion: 'v1', status: 'Success' } :
              validDocument(body) && body.kind ? body : before?.body ?? { kind: 'Status', apiVersion: 'v1', status: 'Success' } };
          }
        }
        response.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
      } catch (error) {
        failure = error;
        response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ kind: 'Status', apiVersion: 'v1', status: 'Failure', reason: 'InternalError', message: 'The guarded operation was refused.', code: 500 }));
      }
    })();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Failure('CONFIG_INVALID', 'Cannot establish the private operation channel.');
  return {
    ...(execution ? { prepared: true } : {}),
    config: { apiVersion: 'v1', kind: 'Config', clusters: [{ name: 'selected', cluster: { server: `http://127.0.0.1:${address.port}/${capability}` } }], users: [{ name: 'selected', user: {} }], contexts: [{ name: config['current-context'] ?? 'selected', context: { cluster: 'selected', user: 'selected', namespace } }], 'current-context': config['current-context'] ?? 'selected' },
    finish: async (success = true) => {
      if (failure) throw failure;
      if (invocation.command.effect === 'authorization') {
        const denied = reviews.find(review => review.upstreamStatus >= 300);
        if (denied) throw new Failure(denied.upstreamStatus === 401 ? 'AUTH_REQUIRED' : 'ACCESS_DENIED', 'The selected identity cannot create this review.', 1, { upstreamStatus: denied.upstreamStatus });
        return { reviews, complete: reviews.every(review => !(review.status as Record<string, unknown> | undefined)?.incomplete) };
      }
      if (!success) throw new Failure('UPSTREAM_FAILED', 'The command failed; no prepared request was issued. Check its arguments, targets and permissions.');
      if (workflow?.kind !== 'prepare') return { dryRun: 'server', operations: changes.map(change => ({ operation: 'OP-027', method: change.method, path: change.path })), persisted: false };
      if (changes.filter(change => change.method === 'DELETE').length > 1 && !/^(true|1)$/i.test(process.env.KUBERNETES_AXI_COLLECTION_DELETE ?? '')) throw new Failure('CAPABILITY_UNAVAILABLE', 'Bulk deletion also requires KUBERNETES_AXI_COLLECTION_DELETE=true.');
      const key = randomUUID();
      const directory = join(root(invocation.config), key);
      await privateDirectory(directory);
      const signingKey = randomBytes(32).toString('hex');
      const display = redactor.value({ command: invocation.command.path, namespace, selected: [...snapshots.values()], changes: changes.map(change => ({ operation: change.operation, method: change.method, path: change.path, change: publicBody(change.body, /\/secrets(?:\/|\?|$)/.test(change.path)) })) }) as object;
      const plan: Plan = { version: 1, key, binding: mac(signingKey, nativeBinding ?? config), namespace, command: invocation.command.path,
        awaitDeletion: invocation.command.path === 'drain' || invocation.command.path === 'delete' && invocation.flags.get('wait') !== 'false', snapshots: [...snapshots.values()], changes, display: execution ? { ...display, execution } : display, ...(execution ? { execution } : {}) };
      const saved: Saved = { plan, digest: mac(signingKey, plan), state: 'prepared', results: [] };
      await writePrivate(join(directory, 'key'), signingKey);
      await writePrivate(join(directory, 'request.json'), JSON.stringify(saved));
      await writePrivate(join(directory, 'claim'), 'prepared');
      return { request: key, state: 'prepared', mutations: changes.length, persisted: false, help: [`${prefix(invocation)} preview ${key}`] };
    },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
