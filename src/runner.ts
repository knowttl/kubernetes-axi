import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Ajv } from 'ajv';
import type { Identity } from './credentials.js';
import { Failure } from './errors.js';
import { privateDirectory, writePrivate } from './private-files.js';

const execute = promisify(execFile);
const pins = JSON.parse(await readFile(new URL('../kubectl-pins.json', import.meta.url), 'utf8')) as {
  version: string;
  supportedServerMinors: number[];
  binaries: Record<string, { file: string; sha256: string }>;
};
const ajv = new Ajv();
const validVersion = ajv.compile<{ major: string; minor: string; gitVersion: string }>({
  type: 'object', required: ['major', 'minor', 'gitVersion'],
  properties: { major: { const: '1' }, minor: { type: 'string', pattern: '^[0-9]+\\+?$' }, gitVersion: { type: 'string' } },
});
const validPods = ajv.compile<{ metadata: { continue?: string; resourceVersion?: string; remainingItemCount?: number }; items: { metadata: { name: string; namespace: string }; status?: { phase?: string } }[] }>({
  type: 'object', required: ['kind', 'metadata', 'items'],
  properties: {
    kind: { const: 'PodList' },
    metadata: { type: 'object', properties: { continue: { type: 'string' }, resourceVersion: { type: 'string' }, remainingItemCount: { type: 'integer', minimum: 0 } } },
    items: { type: 'array', items: {
      type: 'object', required: ['metadata'], properties: {
        metadata: { type: 'object', required: ['name', 'namespace'], properties: { name: { type: 'string' }, namespace: { type: 'string' } } },
        status: { type: 'object', properties: { phase: { type: 'string' } } },
      },
    } },
  },
});

export async function readCluster(identity: Identity, operation: 'version' | 'pods', namespace?: string): Promise<object> {
  const pin = pins.binaries[`${process.platform}-${process.arch}`];
  if (!pin) throw new Failure('BINARY_UNSUPPORTED', 'Use a recorded Linux or Windows amd64 runtime.');
  const binary = await realpath(fileURLToPath(new URL(`../vendor/${pin.file}`, import.meta.url)));
  const digest = createHash('sha256').update(await readFile(binary)).digest('hex');
  if (digest !== pin.sha256) throw new Failure('BINARY_INTEGRITY', 'Restore the recorded managed kubectl binary; PATH fallback is disabled.');
  const directory = join(tmpdir(), `kubernetes-axi-${randomUUID()}`);
  await privateDirectory(directory);
  const { profile, secret } = identity;
  const selectedNamespace = namespace ?? profile.namespace ?? 'default';
  const user = profile.auth === 'token' ? { token: secret } : {
    'client-certificate-data': Buffer.from(profile.clientCertificate!).toString('base64'),
    'client-key-data': Buffer.from(secret).toString('base64'),
  };
  const config = join(directory, 'config.json');
  const env: NodeJS.ProcessEnv = {
    HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory,
    TMPDIR: directory, TEMP: directory, TMP: directory,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
  };
  const invoke = async (args: string[], format: 'json' | 'text' = 'json'): Promise<unknown> => {
    try {
      const result = await execute(binary, ['--kubeconfig', config, '--cache-dir', directory, '--request-timeout=5s', ...args], {
        env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
      });
      return format === 'text' ? result.stdout : JSON.parse(result.stdout) as unknown;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? '';
      if (/Unauthorized|must be logged in/i.test(stderr)) throw new Failure('AUTH_REQUIRED', 'The selected identity was rejected.');
      if (/Forbidden/i.test(stderr)) throw new Failure('ACCESS_DENIED', 'The selected identity cannot perform this read.');
      throw new Failure('UPSTREAM_FAILED', 'The bounded Kubernetes read failed; check endpoint, TLS trust and identity.');
    }
  };
  try {
    await writePrivate(config, JSON.stringify({
      apiVersion: 'v1', kind: 'Config',
      clusters: [{ name: 'selected', cluster: { server: profile.origin, 'certificate-authority-data': Buffer.from(profile.certificateAuthority).toString('base64') } }],
      users: [{ name: 'selected', user }],
      contexts: [{ name: 'selected', context: { cluster: 'selected', user: 'selected', namespace: selectedNamespace } }],
      'current-context': 'selected',
    }));
    const client = await invoke(['version', '--client=true', '-o', 'json']) as { clientVersion?: { gitVersion?: string } };
    if (client.clientVersion?.gitVersion !== pins.version) throw new Failure('BINARY_VERSION', 'Restore the recorded managed kubectl version.');
    const version = await invoke(['get', '--raw=/version']);
    if (!validVersion(version)) throw new Failure('UPSTREAM_INVALID', 'The server version response is invalid.');
    if (!pins.supportedServerMinors.includes(Number.parseInt(version.minor, 10))) {
      throw new Failure('BINARY_INCOMPATIBLE', 'Server version is outside the recorded kubectl skew matrix.');
    }
    const provenance = { source: identity.source, kubectlVersion: pins.version, kubectlSha256: digest };
    if (operation === 'version') return { ...provenance, gitVersion: version.gitVersion };
    const resources = await invoke(['api-resources', '--api-group=', '--namespaced=true', '--verbs=list', '-o', 'name'], 'text');
    if (typeof resources !== 'string' || !resources.trim().split(/\s+/).includes('pods')) {
      throw new Failure('UPSTREAM_INVALID', 'Discovery does not advertise namespaced pod lists.');
    }
    // Native get follows continuation tokens even with chunk-size=0. A bounded raw
    // read through kubectl preserves the server's page state instead of consuming it.
    const pods = await invoke(['get', `--raw=/api/v1/namespaces/${selectedNamespace}/pods?limit=100`]);
    if (!validPods(pods) || pods.items.some(pod => pod.metadata.namespace !== selectedNamespace)) {
      throw new Failure('UPSTREAM_INVALID', 'The pod list does not match the selected namespace or schema.');
    }
    return {
      ...provenance,
      pods: pods.items.map(pod => ({ name: pod.metadata.name, namespace: pod.metadata.namespace, phase: pod.status?.phase ?? 'Unknown' })),
      continue: pods.metadata.continue ?? '', resourceVersion: pods.metadata.resourceVersion ?? '',
      ...(pods.metadata.remainingItemCount === undefined ? {} : { remainingItemCount: pods.metadata.remainingItemCount }),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
