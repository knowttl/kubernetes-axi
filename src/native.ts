import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, rm } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Failure } from './errors.js';
import { readPrivate, writePrivate } from './private-files.js';
import type { Redactor } from './redaction.js';

const execute = promisify(execFile);
interface Entry { name: string; cluster?: Record<string, unknown>; user?: Record<string, unknown>; context?: { cluster: string; user: string; namespace?: string } }
interface Config { clusters: Entry[]; users: Entry[]; contexts: Entry[]; 'current-context'?: string }
interface Exec { apiVersion: string; command: string; args?: string[]; env?: { name: string; value: string }[]; interactiveMode?: string; provideClusterInfo?: boolean }

export async function inspectNative(binary: string, snapshot: string, redactor: Redactor, signal: AbortSignal): Promise<Config> {
  try {
    const result = await execute(binary, ['--kubeconfig', snapshot, 'config', 'view', '--merge=false', '--raw', '-o', 'json'], { signal, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    const config = JSON.parse(result.stdout) as Config;
    for (const { user } of config.users ?? []) if (user) {
      redactor.register(...['token', 'password'].map(key => typeof user[key] === 'string' ? user[key] : undefined));
      for (const key of ['client-key-data', 'client-certificate-data']) if (typeof user[key] === 'string') redactor.register(Buffer.from(user[key], 'base64').toString());
      const helper = user.exec as Exec | undefined;
      if (helper) redactor.register(...(helper.env ?? []).map(item => item.value));
    }
    return config;
  } catch { throw new Failure('CONFIG_INVALID', 'The selected native kubeconfig is invalid.'); }
}

export async function nativeConfig(binary: string, selection: string, context: string | undefined, directory: string, trustExec: boolean, redactor: Redactor, signal: AbortSignal): Promise<{ config: object; source: string; namespace: string; close: () => Promise<void> }> {
  const paths = selection === 'ambient' ? (process.env.KUBECONFIG ? process.env.KUBECONFIG.split(delimiter).filter(Boolean) : [join((await import('node:os')).homedir(), '.kube', 'config')]) : [selection];
  if (!paths.length || paths.some(path => !isAbsolute(path))) throw new Failure('CONFIG_INVALID', 'Select absolute native kubeconfig paths.');
  const merged: Config = { clusters: [], users: [], contexts: [] };
  const origins = new Map<Entry, string>();
  for (const [index, path] of paths.entries()) {
    let contents: string;
    try { contents = await readPrivate(path, false); }
    catch (error) { if (selection === 'ambient' && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const snapshot = join(directory, `source-${index}.json`);
    await writePrivate(snapshot, contents);
    let parsed: Config;
    try {
      parsed = await inspectNative(binary, snapshot, redactor, signal);
    }
    finally { await rm(snapshot, { force: true }); }
    for (const key of ['clusters', 'users', 'contexts'] as const) {
      for (const entry of parsed[key] ?? []) if (!merged[key].some(existing => existing.name === entry.name)) { merged[key].push(entry); origins.set(entry, path); }
    }
    if (!merged['current-context'] && parsed['current-context']) merged['current-context'] = parsed['current-context'];
  }
  const name = context ?? merged['current-context'];
  const selected = merged.contexts.find(entry => entry.name === name)?.context;
  const clusterEntry = merged.clusters.find(entry => entry.name === selected?.cluster);
  const userEntry = merged.users.find(entry => entry.name === selected?.user);
  if (!selected || !clusterEntry?.cluster || !userEntry?.user) throw new Failure('CONFIG_INVALID', 'Select an existing native context with a cluster and identity.');
  const cluster = { ...clusterEntry.cluster };
  const user = { ...userEntry.user };
  const server = new URL(String(cluster.server));
  if (server.protocol !== 'https:' || server.username || server.password || cluster['insecure-skip-tls-verify'] || cluster['proxy-url']) throw new Failure('CONFIG_INVALID', 'Native contexts require verified HTTPS without a proxy override.');
  if (user['auth-provider'] || user.tokenFile || user.username || user.password) throw new Failure('CONFIG_INVALID', 'Use native token, certificate or a trusted ExecCredential helper.');
  for (const [target, entry, field, secret] of [[cluster, clusterEntry, 'certificate-authority', false], [user, userEntry, 'client-certificate', false], [user, userEntry, 'client-key', true]] as const) {
    if (target[field] && !target[`${field}-data`]) target[`${field}-data`] = Buffer.from(await readPrivate(resolve(dirname(origins.get(entry)!), String(target[field])), secret)).toString('base64');
    delete target[field];
  }
  if (!cluster['certificate-authority-data']) throw new Failure('CONFIG_INVALID', 'Supply explicit native certificate authority trust.');
  if (!user.exec && !user.token && !(user['client-certificate-data'] && user['client-key-data'])) throw new Failure('AUTH_REQUIRED', 'Supply authentication in the selected native identity.');
  redactor.register(typeof user.token === 'string' ? user.token : undefined, ...['client-key-data', 'client-certificate-data'].map(key => typeof user[key] === 'string' ? Buffer.from(user[key], 'base64').toString() : undefined));
  let close = async (): Promise<void> => {};
  if (user.exec) {
    if (!trustExec) throw new Failure('AUTH_HELPER_UNTRUSTED', 'Review the selected helper, then opt in with --trust-exec. Its existing cache remains helper-owned.');
    if (process.platform === 'win32') throw new Failure('AUTH_HELPER_UNAVAILABLE', 'Native Windows helper-channel commissioning is pending.');
    const helper = user.exec as Exec;
    if (!['client.authentication.k8s.io/v1', 'client.authentication.k8s.io/v1beta1'].includes(helper.apiVersion) || typeof helper.command !== 'string' || (helper.args && (!Array.isArray(helper.args) || helper.args.some(arg => typeof arg !== 'string'))) || !['Never', 'IfAvailable', undefined].includes(helper.interactiveMode)) throw new Failure('AUTH_HELPER_UNAVAILABLE', 'Select a supported non-interactive ExecCredential helper.');
    const command = helper.command.includes('/') ? resolve(dirname(origins.get(userEntry)!), helper.command) : helper.command;
    const socketPath = join(directory, 'exec.sock');
    let acquisitions = 0;
    const server = createServer({ allowHalfOpen: true }, socket => {
      let request = '';
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      socket.on('data', chunk => { request += chunk; if (request.length > 1024 * 1024) socket.destroy(); });
      socket.on('end', () => {
        void (async () => {
          try {
            if (++acquisitions > 64) throw new Error('bounded');
            const input = JSON.parse(request) as { info?: string };
            const env = { ...process.env, ...Object.fromEntries((helper.env ?? []).map(item => [item.name, item.value])), KUBERNETES_EXEC_INFO: input.info };
            const result = await execute(command, helper.args ?? [], { env, signal, timeout: 8000, maxBuffer: 1024 * 1024 });
            const credential = JSON.parse(result.stdout) as { apiVersion?: string; kind?: string; status?: { token?: string; clientCertificateData?: string; clientKeyData?: string; expirationTimestamp?: string } };
            const status = credential.status;
            if (credential.apiVersion !== helper.apiVersion || credential.kind !== 'ExecCredential' || !status || !((typeof status.token === 'string' && status.token.length > 0) || (typeof status.clientCertificateData === 'string' && typeof status.clientKeyData === 'string')) || (status.expirationTimestamp && !Number.isFinite(Date.parse(status.expirationTimestamp)))) throw new Error('invalid');
            redactor.register(status.token, status.clientKeyData, status.clientCertificateData);
            // Nothing reaches kubectl until every newly acquired secret is registered.
            socket.end(JSON.stringify({ apiVersion: credential.apiVersion, kind: 'ExecCredential', status }));
          } catch { socket.end(); }
        })();
      });
    });
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(socketPath, done); });
    await chmod(socketPath, 0o600);
    close = async () => { await new Promise<void>(done => server.close(() => done())); };
    user.exec = { apiVersion: helper.apiVersion, command: process.execPath, args: [fileURLToPath(new URL('./exec-shim.js', import.meta.url)), socketPath], interactiveMode: helper.interactiveMode ?? 'Never', provideClusterInfo: helper.provideClusterInfo ?? false };
  }
  return {
    config: { apiVersion: 'v1', kind: 'Config', clusters: [{ name: 'selected', cluster }], users: [{ name: 'selected', user }], contexts: [{ name: name!, context: { cluster: 'selected', user: 'selected', namespace: selected.namespace ?? 'default' } }], 'current-context': name },
    source: `native:${paths.join(delimiter)} context:${name}; ambient exception; helper cache owned by helper`, namespace: selected.namespace ?? 'default', close,
  };
}
