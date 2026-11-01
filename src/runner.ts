import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Ajv } from 'ajv';
import type { Identity } from './credentials.js';
import type { Invocation } from './grammar.js';
import { Failure } from './errors.js';
import { privateDirectory, writePrivate } from './private-files.js';
import { readPrivate } from './private-files.js';
import { nativeConfig, inspectNative } from './native.js';
import type { Redactor } from './redaction.js';
import { mutationSession } from './mutations.js';
import { byteProcess, type ByteExecution } from './byte-process.js';
import { clientOnly } from './grammar.js';

const execute = promisify(execFile);
const pins = JSON.parse(await readFile(new URL('../kubectl-pins.json', import.meta.url), 'utf8')) as {
  version: string; supportedServerMinors: number[]; binaries: Record<string, { file: string; sha256: string }>;
};
const ajv = new Ajv();
const validVersion = ajv.compile<{ major: string; minor: string; gitVersion: string }>({
  type: 'object', required: ['major', 'minor', 'gitVersion'],
  properties: { major: { const: '1' }, minor: { type: 'string', pattern: '^[0-9]+\\+?$' }, gitVersion: { type: 'string' } },
});
function compatibleVersion(value: unknown): asserts value is { major: string; minor: string; gitVersion: string } {
  if (!validVersion(value)) throw new Failure('UPSTREAM_INVALID', 'The server version response is invalid.');
  if (!pins.supportedServerMinors.includes(Number.parseInt(value.minor, 10))) throw new Failure('BINARY_INCOMPATIBLE', 'Server version is outside the recorded kubectl skew matrix.');
}
interface Resource { name: string; singularName: string; namespaced: boolean; kind: string; verbs: string[]; shortNames?: string[]; prefix: string; apiVersion: string }
interface ObjectEnvelope {
  apiVersion?: string; kind?: string;
  metadata: { name?: string; namespace?: string; continue?: string; resourceVersion?: string; remainingItemCount?: number };
  status?: { phase?: string; availableReplicas?: number; conditions?: { type: string; status: string }[] };
  spec?: { replicas?: number };
  usage?: Record<string, string>;
  containers?: { name: string; usage: Record<string, string> }[];
}
const validObject = ajv.compile<ObjectEnvelope>({
  type: 'object', required: ['metadata'], properties: {
    apiVersion: { type: 'string' }, kind: { type: 'string' },
    metadata: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 }, namespace: { type: 'string' } } },
    status: { type: 'object', properties: {
      phase: { type: 'string' }, availableReplicas: { type: 'integer' },
      conditions: { type: 'array', items: { type: 'object', required: ['type', 'status'], properties: { type: { type: 'string' }, status: { type: 'string' } } } },
    } },
    spec: { type: 'object', properties: { replicas: { type: 'integer' } } },
    usage: { type: 'object', required: ['cpu', 'memory'], properties: { cpu: { type: 'string' }, memory: { type: 'string' } } },
    containers: { type: 'array', items: { type: 'object', required: ['name', 'usage'], properties: {
      name: { type: 'string' }, usage: { type: 'object', required: ['cpu', 'memory'], properties: { cpu: { type: 'string' }, memory: { type: 'string' } } },
    } } },
  },
});
const validPage = ajv.compile<{ apiVersion: string; kind: string; metadata: ObjectEnvelope['metadata']; items: ObjectEnvelope[] }>({
  type: 'object', required: ['apiVersion', 'kind', 'metadata', 'items'], properties: {
    apiVersion: { type: 'string' }, kind: { type: 'string' }, items: { type: 'array' },
    metadata: { type: 'object', properties: { continue: { type: 'string' }, resourceVersion: { type: 'string' }, remainingItemCount: { type: 'integer', minimum: 0 } } },
  },
});
const validDiscovery = ajv.compile<{ groupVersion: string; resources: Resource[] }>({
  type: 'object', required: ['groupVersion', 'resources'], properties: {
    groupVersion: { type: 'string' }, resources: { type: 'array', items: {
      type: 'object', required: ['name', 'singularName', 'namespaced', 'kind', 'verbs'], properties: {
        name: { type: 'string', pattern: '^[a-z0-9][a-z0-9./-]*$' }, singularName: { type: 'string' }, kind: { type: 'string', minLength: 1 }, namespaced: { type: 'boolean' },
        verbs: { type: 'array', items: { type: 'string' } }, shortNames: { type: 'array', items: { type: 'string' } },
      },
    } },
  },
});
const validCore = ajv.compile<{ versions: string[] }>({
  type: 'object', required: ['versions'], properties: { versions: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^v[0-9]+((alpha|beta)[0-9]+)?$' } } },
});
const groupVersionSchema = { type: 'object', required: ['groupVersion'], properties: { groupVersion: { type: 'string', pattern: '^[a-z0-9][a-z0-9.-]*/v[0-9]+((alpha|beta)[0-9]+)?$' } } };
const validGroups = ajv.compile<{ groups: { name: string; versions: { groupVersion: string }[]; preferredVersion: { groupVersion: string } }[] }>({
  type: 'object', required: ['groups'], properties: { groups: { type: 'array', items: {
    type: 'object', required: ['name', 'versions', 'preferredVersion'], properties: {
      name: { type: 'string', pattern: '^[a-z0-9][a-z0-9.-]*$' },
      versions: { type: 'array', minItems: 1, items: groupVersionSchema },
      preferredVersion: groupVersionSchema,
    },
  } } },
});
export interface NativeOutput { native: true; stdout: string; stderr: string; exitCode: number }

export async function readCluster(identity: Identity | undefined, invocation: Invocation, redactor: Redactor, byteExecution?: ByteExecution): Promise<object | NativeOutput> {
  const pin = pins.binaries[`${process.platform}-${process.arch}`];
  if (!pin) throw new Failure('BINARY_UNSUPPORTED', 'Use a recorded Linux or Windows amd64 runtime.');
  const binary = await realpath(fileURLToPath(new URL(`../vendor/${pin.file}`, import.meta.url)));
  const digest = createHash('sha256').update(await readFile(binary)).digest('hex');
  if (digest !== pin.sha256) throw new Failure('BINARY_INTEGRITY', 'Restore the recorded managed kubectl binary; PATH fallback is disabled.');
  const flags = invocation.flags;
  let namespace = flags.get('namespace') ?? identity?.profile.namespace ?? 'default';
  const all = flags.get('all-namespaces') === 'true';
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace) || namespace.length > 63) throw new Failure('USAGE', 'Use a valid Kubernetes namespace.', 2);
  const directory = join(tmpdir(), `kubernetes-axi-${randomUUID()}`);
  await privateDirectory(directory);
  const profile = identity?.profile;
  const secret = identity?.secret;
  const user = profile?.auth === 'token' ? { token: secret } : {
    'client-certificate-data': Buffer.from(profile?.clientCertificate ?? '').toString('base64'), 'client-key-data': Buffer.from(secret ?? '').toString('base64'),
  };
  const config = join(directory, 'config.json');
  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort('SIGINT');
  const terminate = (): void => cancellation.abort('SIGTERM');
  const hangup = (): void => cancellation.abort('SIGHUP');
  byteExecution?.signal.addEventListener('abort', cancel, { once: true });
  process.once('SIGTERM', terminate);
  process.once('SIGINT', cancel);
  process.once('SIGHUP', hangup);
  const deadline = Date.now() + 15_000;
  let requests = 0;
  let retainedBytes = 0;
  const env: NodeJS.ProcessEnv = {
    HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory,
    TMPDIR: directory, TEMP: directory, TMP: directory,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
  };
  const invoke = async (args: string[], format: 'json' | 'text' | 'native' = 'json'): Promise<unknown> => {
    if (format === 'native' && byteExecution) {
      const exitCode = await byteProcess(binary, ['--kubeconfig', config, '--cache-dir', directory, '--request-timeout=0', ...args], env, byteExecution, redactor);
      return { native: true, stdout: '', stderr: '', exitCode };
    }
    if (++requests > 64 || Date.now() >= deadline) throw new Failure('UPSTREAM_TIMEOUT', 'The bounded operation exhausted its request or time budget.');
    let result;
    try {
      result = await execute(binary, ['--kubeconfig', config, '--cache-dir', directory, '--request-timeout=5s', ...args], { env, signal: cancellation.signal, timeout: Math.min(10_000, deadline - Date.now()), maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    } catch (error) {
      const failed = error as { stderr?: string; stdout?: string; code?: string | number; killed?: boolean };
      if (failed.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Failure('OUTPUT_LIMIT', 'Output exceeded 4 MiB; narrow the selection.', 1, { cause: 'byte_limit' });
      if (failed.killed) throw new Failure('UPSTREAM_TIMEOUT', 'The bounded request timed out.', 1, { cause: 'timeout' });
      if (format === 'native' && typeof failed.code === 'number') return { native: true, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', exitCode: failed.code };
      const stderr = failed.stderr ?? '';
      const reason = /^(?:error: )?Error from server \(([^)]+)\):/mi.exec(stderr)?.[1]
        ?? (/^error: You must be logged in to the server \(/m.test(stderr) ? 'Unauthorized' : undefined);
      const errors: [string[], string, number, string][] = [
        [['Unauthorized'], 'AUTH_REQUIRED', 401, 'The selected identity was rejected.'],
        [['Forbidden'], 'ACCESS_DENIED', 403, 'The selected identity cannot perform this read.'],
        [['BadRequest'], 'BAD_REQUEST', 400, 'The API rejected the read arguments; check the selector, container and requested options.'],
        [['Expired', 'Gone'], 'RESOURCE_EXPIRED', 410, 'The continuation expired; start a new read.'],
        [['Timeout', 'ServerTimeout'], 'UPSTREAM_TIMEOUT', 504, 'The bounded request timed out.'],
        [['NotFound'], args.includes('explain') ? 'SCHEMA_UNAVAILABLE' : args.some(arg => arg.startsWith('--raw=/apis/metrics.k8s.io/')) ? 'API_UNAVAILABLE' : 'RESOURCE_NOT_FOUND', 404, 'The selected resource or API was not found.'],
      ];
      for (const [reasons, code, upstreamStatus, message] of errors) if (reason && reasons.includes(reason)) throw new Failure(code, message, 1, { upstreamStatus, cause: code });
      if (!reason) {
        if (args.includes('explain') && /^(?:error: )?the server doesn't have a resource type /mi.test(stderr)) throw new Failure('RESOURCE_NOT_FOUND', 'The requested resource type was not found in discovery.');
        if (args[0] === 'logs' && /^error: container .+ is not valid for pod /m.test(stderr)) throw new Failure('BAD_REQUEST', 'The selected container does not exist in this pod.');
        if (/^(?:error: )?(?:Unable to connect to the server: |net\/http: |context )[^\n]*(?:deadline exceeded|timed out|Timeout)/m.test(stderr)) throw new Failure('UPSTREAM_TIMEOUT', 'The bounded request timed out.', 1, { cause: 'timeout' });
        if (args.includes('explain') && /^error: (?:failed to (?:download|fetch) openapi|error loading schema)/mi.test(stderr)) {
          // Explain loses HTTP failure reasons; a raw read retains the server's status.
          const schema = /^error: failed to fetch openapi schema for ((?:api|apis\/[a-z0-9][a-z0-9.-]*)\/v[0-9]+(?:(?:alpha|beta)[0-9]+)?):/m.exec(stderr)?.[1];
          if (schema) {
            try { await invoke(['get', `--raw=/openapi/v3/${schema}`]); }
            catch (error) {
              if (!(error instanceof Failure) || !['RESOURCE_NOT_FOUND', 'UPSTREAM_INVALID'].includes(error.code)) throw error;
            }
          }
          throw new Failure('SCHEMA_UNAVAILABLE', 'The selected resource schema is unavailable or invalid.', 1, { cause: 'schema' });
        }
        if (/^error: (?:invalid character|unexpected end|[^\n]*cannot unmarshal|invalid JSON)/mi.test(stderr)) throw new Failure('UPSTREAM_INVALID', 'The API returned a malformed response.', 1, { cause: 'malformed' });
      }
      throw new Failure('UPSTREAM_FAILED', 'The bounded Kubernetes read failed; check endpoint, TLS trust and identity.', 1, { cause: 'transport' });
    }
    retainedBytes += Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    if (retainedBytes > 4 * 1024 * 1024) throw new Failure('OUTPUT_LIMIT', 'The operation exceeded its 4 MiB retained-output budget.');
    if (format === 'native') return { native: true, stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    if (format === 'text') return result.stdout;
    try { return JSON.parse(result.stdout) as unknown; }
    catch { throw new Failure('UPSTREAM_INVALID', 'The API returned malformed JSON.', 1, { cause: 'malformed' }); }
  };
  const raw = (path: string): Promise<unknown> => invoke(['get', `--raw=${path}`]);
  let close = async (): Promise<void> => {};
  let source = identity?.source ?? '';
  let binding = JSON.stringify(identity);
  try {
    if (clientOnly(invocation)) {
      if (invocation.command.path === 'plugin list') env.PATH = process.env.PATH;
      return await invoke(invocation.argv, 'native') as NativeOutput;
    }
    if (invocation.nativeConfig && invocation.native && invocation.command.path.startsWith('config ')) {
      if (invocation.nativeConfig === 'ambient') throw new Failure('CONFIG_INVALID', 'Native config operations require one explicitly selected source file.');
      if (invocation.command.effect === 'localWrite' && /^(true|1)$/i.test(process.env.KUBERNETES_AXI_READ_ONLY ?? '')) throw new Failure('READ_ONLY', 'Native config writes are disabled by read-only policy.');
      await writePrivate(config, await readPrivate(invocation.nativeConfig, false));
      await inspectNative(binary, config, redactor, cancellation.signal);
      const result = await invoke(invocation.argv, 'native') as NativeOutput;
      if (result.exitCode === 0 && invocation.command.effect === 'localWrite') await writePrivate(invocation.nativeConfig, await readPrivate(config, true));
      return result;
    }
    if (invocation.nativeConfig) {
      const loaded = await nativeConfig(binary, invocation.nativeConfig, flags.get('context'), directory, invocation.trustExec, redactor, cancellation.signal, Boolean(invocation.workflow) || invocation.command.effect === 'clusterWrite');
      close = loaded.close;
      namespace = flags.get('namespace') ?? loaded.namespace;
      source = loaded.source;
      binding = loaded.binding;
      if (['doctor', 'auth status'].includes(invocation.command.path)) return { source, ...loaded.diagnostic, connectivity: 'not checked' };
      await writePrivate(config, JSON.stringify(loaded.config));
    } else await writePrivate(config, JSON.stringify({
      apiVersion: 'v1', kind: 'Config',
      clusters: [{ name: 'selected', cluster: { server: profile!.origin, 'certificate-authority-data': Buffer.from(profile!.certificateAuthority).toString('base64') } }],
      users: [{ name: 'selected', user }], contexts: [{ name: 'selected', context: { cluster: 'selected', user: 'selected', namespace } }], 'current-context': 'selected',
    }));
    if (invocation.workflow || invocation.command.effect === 'authorization') {
      const session = await mutationSession(config, invocation, namespace, redactor, cancellation.signal, compatibleVersion, binding);
      const closeIdentity = close;
      close = async () => { await session.close(); await closeIdentity(); };
      if (invocation.workflow?.kind === 'confirm' && !session.argv || session.prepared) return await session.finish();
      await writePrivate(config, JSON.stringify(session.config));
      const args = [...(session.argv ?? invocation.argv)];
      if (session.rawPath) {
        // RequestURI replaces the configured prefix, so the raw URI must carry it.
        for (let index = 0; index < args.length; index++) {
          if (args[index] === '--raw') args[++index] = session.rawPath;
          else if (args[index]!.startsWith('--raw=')) args[index] = `--raw=${session.rawPath}`;
        }
      }
      if (invocation.workflow && !session.argv) {
        if (!invocation.flags.has('raw') && invocation.command.flags.some(flag => flag.name === 'dry-run')) args.push('--dry-run=server');
        if (invocation.command.flags.some(flag => flag.name === 'wait')) args.push('--wait=false');
      }
      const result = await invoke(args, 'native') as NativeOutput;
      if (session.argv) {
        await session.finish(result.exitCode === 0, result.exitCode);
        return result;
      }
      if (invocation.command.effect === 'authorization') {
        const review = await session.finish(result.exitCode === 0);
        process.exitCode = result.exitCode;
        return invocation.native ? result : review;
      }
      if (result.exitCode !== 0) {
        // Expose a guarded refusal before falling back to the native failure.
        await session.finish(false, result.exitCode, result.stderr);
        if (invocation.native) return result;
        throw new Failure('UPSTREAM_FAILED', 'The operation could not be prepared or validated; check its resource, permissions and arguments.');
      }
      const finished = await session.finish();
      return finished;
    }
    const client = await invoke(['version', '--client=true', '-o', 'json']) as { clientVersion?: { gitVersion?: string } };
    if (client.clientVersion?.gitVersion !== pins.version) throw new Failure('BINARY_VERSION', 'Restore the recorded managed kubectl version.');
    const version = await raw('/version');
    compatibleVersion(version);
    const provenance = { source, kubectlVersion: pins.version, kubectlSha256: digest };
    if (invocation.native) return await invoke(invocation.argv, 'native') as NativeOutput;
    const command = invocation.command.path;
    if (command === 'version') return { ...provenance, gitVersion: version.gitVersion };
    if (command === 'logs') {
      const logs = await invoke([...invocation.argv, ...(flags.has('tail') ? [] : ['--tail=100']), ...(flags.has('limit-bytes') ? [] : ['--limit-bytes=65536'])], 'text') as string;
      return { ...provenance, logs, complete: false, truncated: Buffer.byteLength(logs) >= Number(flags.get('limit-bytes') ?? 65536), bound: 'tail and byte limits; snapshot only' };
    }
    if (['describe', 'explain', 'rollout history', 'rollout status'].includes(command)) return { ...provenance, text: await invoke(invocation.argv, 'text'), complete: false, bound: 'execution and byte limits' };
    const core = await raw('/api');
    const groups = await raw('/apis');
    if (!validCore(core) || !validGroups(groups) || groups.groups.some(group => !group.versions.some(version => version.groupVersion === group.preferredVersion.groupVersion) || group.versions.some(version => !version.groupVersion.startsWith(`${group.name}/`)))) throw new Failure('UPSTREAM_INVALID', 'API discovery returned an invalid envelope.');
    if (command === 'api-versions') return { ...provenance, versions: core.versions, groups: groups.groups.map(group => ({ name: group.name, versions: group.versions.map(version => version.groupVersion), preferredVersion: group.preferredVersion.groupVersion })) };
    const candidates = [...core.versions.map(version => ({ version, prefix: `/api/${version}` })), ...groups.groups.flatMap(group => [group.preferredVersion, ...group.versions.filter(version => version.groupVersion !== group.preferredVersion.groupVersion)].map(({ groupVersion }) => ({ version: groupVersion, prefix: `/apis/${groupVersion}` })))];
    const resources: Resource[] = [];
    const requested = invocation.home ? 'pods' : command.startsWith('top ') ? (command === 'top node' ? 'nodes' : 'pods') : invocation.positionals[0];
    for (const candidate of candidates) {
      if (command.startsWith('top ') && !candidate.version.startsWith('metrics.k8s.io/')) continue;
      const listing = await raw(candidate.prefix);
      if (!validDiscovery(listing) || listing.groupVersion !== candidate.version) throw new Failure('UPSTREAM_INVALID', 'Resource discovery returned an invalid envelope.');
      for (const resource of listing.resources) if (!resource.name.includes('/')) resources.push({ ...resource, prefix: candidate.prefix, apiVersion: candidate.version });
      if (command !== 'api-resources' && resources.some(resource => matches(resource, requested))) break;
    }
    if (command === 'api-resources') return { ...provenance, resources: resources.map(resource => ({ name: resource.name, aliases: resource.shortNames ?? [], namespaced: resource.namespaced, kind: resource.kind, verbs: resource.verbs, apiVersion: resource.apiVersion })), complete: true };
    const resource = resources.find(resource => matches(resource, requested));
    if (!resource) throw new Failure('API_UNAVAILABLE', command.startsWith('top ') ? 'The metrics.k8s.io API does not advertise the requested metrics resource.' : 'Discovery does not advertise the requested resource.');
    const name = command.startsWith('top ') ? invocation.positionals[0] : invocation.positionals[1];
    if (name && !/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Failure('USAGE', 'Supply one Kubernetes resource name.', 2);
    const route = `${resource.prefix}${resource.namespaced && !all ? `/namespaces/${namespace}` : ''}/${resource.name}${name ? `/${name}` : ''}`;
    const query = new URLSearchParams();
    if (!name && !command.startsWith('top ')) query.set('limit', '100');
    if (flags.has('continue')) query.set('continue', flags.get('continue')!);
    for (const [flag, parameter] of [['selector', 'labelSelector'], ['field-selector', 'fieldSelector']] as const) if (flags.has(flag)) query.set(parameter, flags.get(flag)!);
    const body = await raw(`${route}${query.size ? `?${query}` : ''}`);
    let items: ObjectEnvelope[];
    let page: ObjectEnvelope['metadata'] = {};
    if (name) {
      if (!validObject(body) || body.kind !== resource.kind || body.apiVersion !== resource.apiVersion || body.metadata.name !== name) throw new Failure('UPSTREAM_INVALID', 'The named response does not match the selected resource.');
      items = [body];
    } else {
      if (!validPage(body) || body.kind !== `${resource.kind}List` || body.apiVersion !== resource.apiVersion || !body.items.every(item => validObject(item))) throw new Failure('UPSTREAM_INVALID', 'The resource list does not match the discovered schema.');
      items = body.items;
      page = body.metadata;
    }
    if (resource.namespaced && items.some(item => !item.metadata.namespace || (!all && item.metadata.namespace !== namespace))) throw new Failure('UPSTREAM_INVALID', 'The response does not match the selected namespace.');
    const rows = items.slice(0, 100).map(item => compact(item, resource.kind));
    const state = { complete: !page.continue && !page.remainingItemCount && items.length <= 100, truncated: items.length > 100, continue: page.continue ?? '', resourceVersion: page.resourceVersion ?? '', ...(page.remainingItemCount === undefined ? {} : { remainingItemCount: page.remainingItemCount }) };
    if (invocation.home) return { ...provenance, bin: process.argv[1], description: 'Read Kubernetes with isolated credentials and pinned kubectl.', context: 'selected', namespace, pods: rows, ...state };
    return { ...provenance, [command.startsWith('top ') ? 'metrics' : resource.name]: rows, ...state };
  } finally {
    cancellation.abort();
    await close();
    await rm(directory, { recursive: true, force: true });
    process.removeListener('SIGTERM', terminate);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGHUP', hangup);
    byteExecution?.signal.removeEventListener('abort', cancel);
  }
}

function matches(resource: Resource, requested?: string): boolean {
  return requested !== undefined && [resource.name, resource.singularName, resource.kind.toLowerCase(), ...(resource.shortNames ?? []), `${resource.name}.${resource.apiVersion.split('/')[0]}`].includes(requested);
}

function compact(item: ObjectEnvelope, kind: string): object {
  const row = { name: item.metadata.name, ...(item.metadata.namespace ? { namespace: item.metadata.namespace } : {}) };
  if (kind === 'Node') return { ...row, ready: item.status?.conditions?.find(condition => condition.type === 'Ready')?.status ?? 'Unknown' };
  if (kind === 'Deployment') return { ...row, desired: item.spec?.replicas ?? 1, available: item.status?.availableReplicas ?? 0 };
  if (kind === 'Pod' || kind === 'Namespace') return { ...row, phase: item.status?.phase ?? 'Unknown' };
  if (kind === 'NodeMetrics' || kind === 'PodMetrics') {
    const usages = kind === 'NodeMetrics' ? [item.usage] : item.containers?.map(container => container.usage);
    if (!usages?.length || usages.some(usage => !usage || typeof usage.cpu !== 'string' || typeof usage.memory !== 'string')) throw new Failure('UPSTREAM_INVALID', 'Metrics usage is missing or invalid.');
    return { ...row, cpu: `${usages.reduce((sum, usage) => sum + quantity(usage!.cpu!, 'cpu'), 0)}m`, memory: `${usages.reduce((sum, usage) => sum + quantity(usage!.memory!, 'memory'), 0)}Mi` };
  }
  return { ...row, kind };
}

function quantity(value: string, type: 'cpu' | 'memory'): number {
  const match = /^(\d+(?:\.\d+)?)(n|u|m|Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(value);
  const units: Record<string, number> = { '': 1, n: 1e-9, u: 1e-6, m: 1e-3, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, k: 1000, M: 1e6, G: 1e9, T: 1e12 };
  if (!match) throw new Failure('UPSTREAM_INVALID', 'Metrics contain an invalid quantity.');
  return Number((Number(match[1]) * units[match[2] ?? '']! * (type === 'cpu' ? 1000 : 1 / 1024 ** 2)).toPrecision(12));
}
