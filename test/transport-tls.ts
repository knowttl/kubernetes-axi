import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTlsServer, request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { promisify } from 'node:util';
import { decode } from '@toon-format/toon';
import { mutationFixture } from './b3.ts';

const directory = mkdtempSync(join(tmpdir(), 'kubernetes-axi-mtls-'));
const openssl = (...args: string[]): void => { execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' }); };
openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=synthetic-ca');
for (const name of ['server', 'client']) {
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=synthetic-${name}`, '-addext', `subjectAltName=DNS:synthetic-${name}`);
  openssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '1', '-copy_extensions', 'copy');
}
const pem = (name: string): string => readFileSync(join(directory, name), 'utf8');
const keyPath = join(directory, 'client.key');
const config = join(directory, 'config.json');
const socketPath = join(directory, 'relay.sock');
const clientCertificate = pem('client.crt');
const privateKey = pem('client.key');
const ca = pem('ca.crt');
let hits = 0;
const upstream = createTlsServer({ key: pem('server.key'), cert: pem('server.crt'), ca, requestCert: true, rejectUnauthorized: true }, (incoming, response) => {
  hits++;
  assert.equal(incoming.headers.authorization, undefined);
  assert.equal((incoming.socket as import('node:tls').TLSSocket).getPeerCertificate().subject.CN, 'synthetic-client');
  const path = incoming.url!.split('?')[0];
  if (path === '/version') { response.end(JSON.stringify({ major: '1', minor: '32', gitVersion: 'v1.32.2' })); return; }
  if (path === '/api') { response.end(JSON.stringify({ kind: 'APIVersions', apiVersion: 'v1', versions: ['v1'] })); return; }
  if (path === '/apis') { response.end(JSON.stringify({ kind: 'APIGroupList', apiVersion: 'v1', groups: [] })); return; }
  if (!mutationFixture(incoming, response)) response.writeHead(404).end();
});
await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
const origin = `https://127.0.0.1:${(upstream.address() as { port: number }).port}`;
const pin = createHash('sha256').update(execFileSync('openssl', ['x509', '-in', join(directory, 'server.crt'), '-outform', 'DER'])).digest('hex');
let selectedPin = pin;
let servername = 'synthetic-server';
let relayed = 0;
const relay = createServer((incoming, response) => {
  relayed++;
  assert.equal(incoming.headers.host, new URL(origin).host);
  for (const secret of [privateKey, clientCertificate]) {
    assert(!JSON.stringify(incoming.headers).includes(JSON.stringify(secret).slice(1, -1)));
    assert(!JSON.stringify(incoming.headers).includes(Buffer.from(secret).toString('base64')));
  }
  const call = request(origin + incoming.url, { method: incoming.method, headers: incoming.headers, ca, cert: clientCertificate, key: privateKey, servername, agent: false,
    checkServerIdentity: (name, certificate) => checkServerIdentity(name, certificate) ?? (createHash('sha256').update(certificate.raw).digest('hex') === selectedPin ? undefined : new Error('pin mismatch')) }, reply => {
    response.writeHead(reply.statusCode!, reply.headers);
    reply.pipe(response);
  });
  call.on('error', () => response.writeHead(502).end());
  incoming.pipe(call);
});
await new Promise<void>(resolve => relay.listen(socketPath, resolve));
const profile = { origin, auth: 'certificate', certificateAuthority: ca, clientCertificate, privateKey: { file: keyPath } };
const save = (selected: object): void => writeFileSync(config, JSON.stringify({ version: 1, profiles: { selected } }), { mode: 0o600 });
save(profile);
const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('KUBERNETES_AXI_'))), KUBERNETES_AXI_CONFIG: config, KUBERNETES_AXI_READ_ONLY: 'false', TMPDIR: directory };
const execute = promisify(execFile);
const run = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
  const source = `import { main } from ${JSON.stringify(new URL('../dist/cli.js', import.meta.url).href)}; await main(process.argv.slice(1), {transport:${JSON.stringify({ socketPath, endpoint: origin, capabilities: { clientCertificate: true, serverName: true }, serverName: 'synthetic-server' })}});`;
  try { return { code: 0, ...await execute(process.execPath, ['--input-type=module', '-e', source, '--', ...args], { env: environment, timeout: 20000 }) }; }
  catch (error) { const failed = error as { code: number; stdout: string; stderr: string }; return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr }; }
};
try {
  const version = await run(['version']);
  assert.equal(version.code, 0, version.stdout + version.stderr);
  assert(hits > 0);
  assert.equal(hits, relayed);
  const review = await run(['auth', 'can-i', 'get', 'configmaps']);
  assert.equal(review.code, 0, review.stdout + review.stderr);
  const prepared = await run(['prepare', '--', 'create', 'configmap', 'mtls-relay', '-n', 'synthetic-b3', '--from-literal=value=relay']);
  assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
  const saved = decode(prepared.stdout) as any;
  const preview = decode((await run(['preview', saved.request])).stdout) as any;
  save({ ...profile, clientCertificate: 'different-certificate' });
  hits = 0;
  assert.equal((decode((await run(['confirm', saved.request, '--digest', preview.digest])).stdout) as any).error.code, 'PREVIEW_MISMATCH');
  assert.equal(hits, 0);
  save({ ...profile, auth: 'token', token: { file: keyPath }, clientCertificate: undefined, privateKey: undefined });
  assert.equal((decode((await run(['confirm', saved.request, '--digest', preview.digest])).stdout) as any).error.code, 'PREVIEW_MISMATCH');
  assert.equal(hits, 0);
  save(profile);
  assert.equal((decode((await run(['confirm', saved.request, '--digest', preview.digest])).stdout) as any).state, 'complete');
  for (const [name, expectedPin] of [['wrong-server', pin], ['synthetic-server', 'wrong-pin']]) {
    servername = name!; selectedPin = expectedPin!; hits = 0;
    assert.notEqual((await run(['version'])).code, 0);
    assert.equal(hits, 0);
  }
  console.log('Host TLS passed: mutual TLS, original certificate and identity type binding, hostname and exact pin refusals');
} finally {
  relay.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise<void>(resolve => relay.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
  rmSync(directory, { recursive: true, force: true });
}
