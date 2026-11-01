import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:https';
import { get } from 'node:https';
import { join } from 'node:path';
import { decode } from '@toon-format/toon';
import { constants, createDeflate } from 'node:zlib';
import type { Duplex } from 'node:stream';
import { deliverCredential } from './private-delivery.ts';

const core = '/api/v1/namespaces/synthetic-remote';
const token = 'synthetic-issued-only-in-memory+/=';
let revision = '1';
let fallback = false;
let tokenMode: 'valid' | 'expired' | 'hold' = 'valid';
let tokenReached: (() => void) | undefined;
const forwarded: { method: string; path: string; query: string }[] = [];
const pod = () => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'selected', namespace: 'synthetic-remote', uid: 'remote-pod', resourceVersion: revision }, spec: { containers: [{ name: 'first', image: 'synthetic' }, { name: 'selected-container', image: 'synthetic' }] }, status: { phase: 'Running' } });

export function remoteFixture(incoming: IncomingMessage, response: ServerResponse): boolean {
  const path = new URL(incoming.url!, 'https://local').pathname;
  if (!path.startsWith(core)) return false;
  const selected = incoming.headers.authorization === 'Bearer synthetic-selected-token';
  if (!selected && !(incoming.headers.authorization === `Bearer ${token}` && incoming.method === 'GET' && path === `${core}/pods/selected`)) { response.writeHead(401).end(); return true; }
  if (path.endsWith('/token') && tokenMode === 'hold') { tokenReached?.(); return true; }
  const body = path === `${core}/pods/selected` ? pod() : path === `${core}/serviceaccounts/selected` ? {
    apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'selected', namespace: 'synthetic-remote', uid: 'remote-sa', resourceVersion: '1' },
  } : path === `${core}/serviceaccounts/selected/token` ? {
    apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest', status: { token, expirationTimestamp: new Date(Date.now() + (tokenMode === 'expired' ? -1 : 600_000)).toISOString() },
  } : undefined;
  if (incoming.method !== 'GET') forwarded.push({ method: incoming.method!, path, query: '' });
  response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? {}));
  return true;
}

function webSocketFrame(channel: number, text: string): Buffer {
  const payload = Buffer.concat([Buffer.from([channel]), Buffer.from(text)]);
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x82;
  if (payload.length < 126) header[1] = payload.length;
  else { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  return Buffer.concat([header, payload]);
}

// SPDY/3.1 uses an 8-byte frame header and one shared zlib header context.
// With stdin and TTY disabled, remotecommand v4 opens error, stdout, stderr in order.
function spdySession(socket: Duplex, head: Buffer, output: string, status: string): void {
  const compressor = createDeflate();
  let compressed: Buffer[] = [];
  compressor.on('data', (bytes: Buffer) => compressed.push(bytes));
  compressor.on('error', () => socket.destroy());
  const frame = (id: number, flags: number, payload: Buffer, type = 0): void => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(type ? (0x80030000 | type) >>> 0 : id, 0);
    header[4] = flags; header.writeUIntBE(payload.length, 5, 3);
    socket.write(Buffer.concat([header, payload]));
  };
  const streams: number[] = [];
  let pending = head;
  let processing = false;
  const consume = async (): Promise<void> => {
    if (processing) return;
    processing = true;
    while (pending.length >= 8) {
      const length = pending.readUIntBE(5, 3);
      if (pending.length < 8 + length) break;
      const message = pending.subarray(0, 8 + length); pending = pending.subarray(8 + length);
      const control = (message[0]! & 0x80) !== 0;
      const type = control ? message.readUInt16BE(2) : 0;
      if (type === 6) { frame(0, 0, message.subarray(8), 6); continue; }
      if (type !== 1) continue;
      const id = message.readUInt32BE(8) & 0x7fffffff;
      streams.push(id);
      compressor.write(Buffer.alloc(4));
      await new Promise<void>(resolve => compressor.flush(constants.Z_SYNC_FLUSH, resolve));
      const payload = Buffer.alloc(4); payload.writeUInt32BE(id);
      frame(0, 0, Buffer.concat([payload, ...compressed]), 2); compressed = [];
      if (streams.length === 3) {
        frame(streams[1]!, 1, Buffer.from(output));
        frame(streams[2]!, 1, Buffer.from('diagnostic\n'));
        frame(streams[0]!, 1, Buffer.from(status));
      }
    }
    processing = false;
  };
  socket.on('data', (bytes: Buffer) => { pending = Buffer.concat([pending, bytes]); void consume(); });
  socket.once('close', () => compressor.destroy());
  void consume();
}

interface Result { code: number; stdout: string; stderr: string }
export async function checkRemote(context: {
  server: Server; run: (args: string[]) => Promise<Result>; check: (name: string, action: () => Promise<void>) => Promise<void>;
  environment: NodeJS.ProcessEnv; directory: string; requests: string[]; cli: string;
}): Promise<void> {
  const { server, run, check, environment, directory, requests, cli } = context;
  const deliver = (args: string[], cancel = false) => deliverCredential(cli, environment, args, token, cancel ? stop => { tokenReached = stop; } : undefined);
  server.on('upgrade', (incoming, socket, head) => {
    if (incoming.headers.authorization !== 'Bearer synthetic-selected-token') { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    const url = new URL(incoming.url!, 'https://local');
    forwarded.push({ method: incoming.method!, path: url.pathname, query: url.search });
    if (fallback && incoming.method === 'GET') { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    const commands = url.searchParams.getAll('command');
    const output = JSON.stringify(commands);
    const status = JSON.stringify(commands[0] === 'fail' ? { status: 'Failure', reason: 'NonZeroExitCode', details: { causes: [{ reason: 'ExitCode', message: '17' }] } } : { status: 'Success' });
    socket.on('error', () => socket.destroy());
    if (incoming.method === 'GET') {
      const accept = createHash('sha1').update(incoming.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: v5.channel.k8s.io\r\n\r\n`);
      socket.end(Buffer.concat([webSocketFrame(1, output), webSocketFrame(2, 'diagnostic\n'), webSocketFrame(3, status), Buffer.from([0x88, 2, 3, 232])]));
    } else {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: SPDY/3.1\r\nX-Stream-Protocol-Version: v4.channel.k8s.io\r\n\r\n');
      spdySession(socket, head, output, status);
    }
  });
  const prepare = async (args: string[]) => {
    const result = await run(['prepare', '--', ...args, ...(args.includes('--') ? [] : ['-n', 'synthetic-remote'])]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const saved = decode(result.stdout) as { request: string };
    const preview = await run(['preview', saved.request]); assert.equal(preview.code, 0, preview.stdout);
    const value = decode(preview.stdout) as { digest: string };
    return ['confirm', saved.request, '--digest', value.digest];
  };
  try {
    environment.KUBERNETES_AXI_READ_ONLY = 'false';
    await check('AC-017:TTY requires a local terminal', async () => {
      requests.length = 0;
      const result = await run(['prepare', '--', 'exec', 'selected', '-it', '--', 'true']);
      assert.match(result.stdout, /LOCAL_TERMINAL_REQUIRED/); assert.equal(requests.length, 0);
    });
    for (const spdy of [false, true]) await check(`AC-017-TRANSPORT:${spdy ? 'SPDY fallback' : 'WebSocket GET'}`, async () => {
      fallback = spdy; forwarded.length = 0;
      const confirmation = await prepare(['exec', 'selected', '-n', 'synthetic-remote', '-c', 'selected-container', '--', 'printf', 'same', 'same', '', 'last']);
      assert.equal(forwarded.length, 0, 'Preparation opens no stream');
      const result = await run(confirmation);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), ['printf', 'same', 'same', '', 'last']);
      assert.equal(result.stderr, 'diagnostic\n');
      assert.deepEqual(forwarded.map(item => item.method), spdy ? ['GET', 'POST'] : ['GET']);
      assert.equal(new URLSearchParams(forwarded.at(-1)!.query).get('container'), 'selected-container');
    });
    await check('AC-EXIT-001:remote exit code', async () => {
      fallback = false;
      const result = await run(await prepare(['exec', 'selected', '-n', 'synthetic-remote', '--', 'fail']));
      assert.equal(result.code, 17, result.stdout + result.stderr);
      assert.equal(result.stdout, '["fail"]'); assert.match(result.stderr, /^diagnostic\n/);
    });
    await check('AC-017:stale target opens no stream', async () => {
      const confirmation = await prepare(['exec', 'selected', '-n', 'synthetic-remote', '--', 'true']);
      revision = '2'; forwarded.length = 0;
      const result = await run(confirmation);
      assert.match(result.stdout, /PREVIEW_STALE/); assert.deepEqual(forwarded, []);
    });
    environment.KUBERNETES_AXI_ACQUIRE_CREDENTIAL = 'true';
    await check('AC-030:private issued token delivery', async () => {
      const confirmation = await prepare(['create', 'token', 'selected', '--duration=10m']);
      forwarded.length = 0;
      const missing = await run(confirmation); assert.match(missing.stdout, /PRIVATE_DELIVERY_REQUIRED/); assert.deepEqual(forwarded, []);
      const delivery = await deliver(confirmation);
      assert.equal(delivery.code, 0, delivery.stdout);
      assert.equal(delivery.credential, token + '\n');
      assert(!delivery.stdout.includes(token) && !delivery.stderr.includes(token));
      const settings = JSON.parse(readFileSync(environment.KUBERNETES_AXI_CONFIG!, 'utf8'));
      const profile = settings.profiles.selected;
      const status = await new Promise<number | undefined>((resolve, reject) => {
        get(profile.origin + `${core}/pods/selected`, { ca: profile.certificateAuthority, headers: { authorization: `Bearer ${delivery.credential.trim()}` } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject);
      });
      assert.equal(status, 200, 'Selected recipient consumes the issued credential at the selected API');
      assert.equal(forwarded.length, 1);
      const scan = (path: string): void => { for (const entry of readdirSync(path)) { const file = join(path, entry); if (statSync(file).isDirectory()) scan(file); else if (!file.includes('/node_modules/') && !file.includes('/protocol/')) assert(!readFileSync(file).includes(Buffer.from(token)), file); } };
      scan(directory);
      const replay = await deliver(confirmation); assert.equal(forwarded.length, 1); assert.equal(replay.credential, '');
    });
    await check('AC-030:expired credential is never delivered', async () => {
      const confirmation = await prepare(['create', 'token', 'selected', '--duration=10m']);
      tokenMode = 'expired';
      try { const result = await deliver(confirmation); assert.notEqual(result.code, 0); assert.equal(result.credential, ''); assert(!result.stdout.includes(token) && !result.stderr.includes(token)); }
      finally { tokenMode = 'valid'; }
    });
    await check('AC-030:cancellation closes the private channel', async () => {
      const confirmation = await prepare(['create', 'token', 'selected', '--duration=10m']);
      tokenMode = 'hold';
      try { const result = await deliver(confirmation, true); assert.notEqual(result.code, 0); assert.equal(result.credential, ''); assert(!result.stdout.includes(token) && !result.stderr.includes(token)); }
      finally { tokenMode = 'valid'; tokenReached = undefined; }
    });
    await check('AC-018:attach separates stdout and stderr', async () => {
      const confirmation = await prepare(['attach', 'selected', '-n', 'synthetic-remote', '-c', 'selected-container', '--quiet']);
      const result = await run(confirmation); assert.equal(result.code, 0, result.stdout + result.stderr); assert.equal(result.stdout, '[]'); assert.equal(result.stderr, 'diagnostic\n');
    });
    environment.KUBERNETES_AXI_READ_ONLY = 'true';
    for (const args of [
      ['prepare', '--', 'exec', 'selected', '--', 'true'], ['prepare', '--', 'create', 'token', 'selected', '--duration=10m'],
      ['native', '--', 'get', '--raw=/api/v1/namespaces/synthetic-remote/pods/selected/exec'],
      ['prepare', '--', 'get', '--raw=/api/v1/namespaces/synthetic-remote/pods/selected/proxy/exec'],
      ['native', '--', 'kustomize', '--enable-alpha-plugins'], ['native', '--', 'plugin', 'run'],
    ]) await check(`AC-RO-001:${args.join(' ')}`, async () => {
      requests.length = 0; forwarded.length = 0;
      const result = await run(args); assert.notEqual(result.code, 0); assert.deepEqual(requests, []); assert.deepEqual(forwarded, []);
    });
  } finally {
    environment.KUBERNETES_AXI_READ_ONLY = 'true'; delete environment.KUBERNETES_AXI_ACQUIRE_CREDENTIAL;
  }
}
