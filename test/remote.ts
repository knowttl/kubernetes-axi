import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:https';
import { get } from 'node:https';
import { join } from 'node:path';
import { decode } from '@toon-format/toon';
import { constants, createDeflate } from 'node:zlib';
import type { Duplex } from 'node:stream';
import { deliverCredential } from './private-delivery.ts';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { dirname } from 'node:path';
import { terminal } from './terminal.ts';
import { portForwardBoundary } from './port-forward.ts';
import { createConnection } from 'node:net';

const core = '/api/v1/namespaces/synthetic-remote';
const token = 'synthetic-issued-only-in-memory+/=';
export const executionToken = 'synthetic-execution-token+/(opaque)~!=';
let revision = '1';
let fallback = false;
let tokenMode: 'valid' | 'expired' | 'hold' = 'valid';
let tokenReached: (() => void) | undefined;
const forwarded: { method: string; path: string; query: string }[] = [];
let portForward: ((incoming: IncomingMessage, socket: Duplex, head: Buffer) => void) | undefined;
export function portForwardFixture(handler: typeof portForward): void { portForward = handler; }
let copyVariant: 'safe' | 'traversal' | 'link' | 'oversize' = 'safe';
export function copyFixtureVariant(variant: typeof copyVariant): void { copyVariant = variant; }
const pod = () => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'selected', namespace: 'synthetic-remote', uid: 'remote-pod', resourceVersion: revision }, spec: { containers: [{ name: 'first', image: 'synthetic' }, { name: 'selected-container', image: 'synthetic' }, { name: 'terminal-container', image: 'synthetic', stdin: true, tty: true }] }, status: { phase: 'Running' } });

export function remoteFixture(incoming: IncomingMessage, response: ServerResponse): boolean {
  const path = new URL(incoming.url!, 'https://local').pathname;
  if (!path.startsWith(core)) return false;
  const selected = ['synthetic-selected-token', executionToken].some(token => incoming.headers.authorization === `Bearer ${token}`);
  if (!selected && !(incoming.headers.authorization === `Bearer ${token}` && incoming.method === 'GET' && path === `${core}/pods/selected`)) { response.writeHead(401).end(); return true; }
  const url = new URL(incoming.url!, 'https://local');
  if (path === `${core}/pods/selected/log`) {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('synthetic followed log line\n'.repeat(8));
    if (url.searchParams.get('follow') !== 'true') response.end();
    return true;
  }
  if (path === `${core}/pods` && url.searchParams.get('watch') === 'true') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(JSON.stringify({ type: 'ADDED', object: pod() }) + '\n');
    return true;
  }
  if (path === `${core}/pods` && incoming.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ apiVersion: 'v1', kind: 'PodList', metadata: { resourceVersion: revision }, items: [pod()] }));
    return true;
  }
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

function webSocketFrame(channel: number, text: string | Buffer): Buffer {
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
  const container = join(directory, 'container', 'files');
  mkdirSync(container, { recursive: true, mode: 0o700 });
  const deliver = (args: string[], cancel = false) => deliverCredential(cli, environment, args, token, cancel ? stop => { tokenReached = stop; } : undefined);
  server.on('upgrade', (incoming, socket, head) => {
    socket.once('end', () => socket.destroy());
    if (!['synthetic-selected-token', executionToken].some(token => incoming.headers.authorization === `Bearer ${token}`)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    const url = new URL(incoming.url!, 'https://local');
    forwarded.push({ method: incoming.method!, path: url.pathname, query: url.search });
    if (url.pathname.endsWith('/portforward')) {
      if (portForward) portForward(incoming, socket, head);
      else socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (fallback && incoming.method === 'GET') { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    const commands = url.searchParams.getAll('command');
    const output = JSON.stringify(commands);
    const status = JSON.stringify(commands[0] === 'fail' ? { status: 'Failure', reason: 'NonZeroExitCode', details: { causes: [{ reason: 'ExitCode', message: '17' }] } } : { status: 'Success' });
    socket.on('error', () => socket.destroy());
    if (incoming.method === 'GET') {
      const accept = createHash('sha1').update(incoming.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: v5.channel.k8s.io\r\n\r\n`);
      if (commands[0] === 'terminal-probe' || url.pathname.endsWith('/attach') && url.searchParams.get('tty') === 'true') {
        socket.write(webSocketFrame(1, 'terminal-ready\n'));
        let pending = head;
        socket.on('data', (chunk: Buffer) => {
          pending = Buffer.concat([pending, chunk]);
          while (pending.length >= 6) {
            const marker = pending[1]! & 127;
            const header = marker === 126 ? 4 : 2;
            if (pending.length < header + 4) return;
            const length = marker === 126 ? pending.readUInt16BE(2) : marker;
            if (pending.length < header + 4 + length) return;
            const mask = pending.subarray(header, header + 4);
            const payload = Buffer.from(pending.subarray(header + 4, header + 4 + length));
            for (let index = 0; index < payload.length; index++) payload[index] = payload[index]! ^ mask[index % 4]!;
            pending = pending.subarray(header + 4 + length);
            if (payload[0] === 4) socket.write(webSocketFrame(1, 'size:' + payload.subarray(1).toString() + '\n'));
            if (payload[0] === 0) {
              const input = payload.subarray(1).toString();
              socket.write(webSocketFrame(1, 'input:' + payload.subarray(1).toString('hex') + '\n'));
              if (input.includes('secret')) {
                socket.write(webSocketFrame(1, 'synthetic-selected-'));
                socket.write(webSocketFrame(1, 'token\n'));
              }
              if (input.includes('exit')) socket.end(Buffer.concat([webSocketFrame(3, input.includes('exitfail') ? JSON.stringify({ status: 'Failure', reason: 'NonZeroExitCode', details: { causes: [{ reason: 'ExitCode', message: '17' }] } }) : status), Buffer.from([0x88, 2, 3, 232])]));
            }
          }
        });
        return;
      }
      if (commands[0] === 'hold') { socket.write(webSocketFrame(1, 'held')); socket.resume(); return; }
      const tarUpload = JSON.stringify(commands) === JSON.stringify(['tar', 'xf', '-', '-C', '/files']);
      const tarDownload = commands.length === 7 && commands.slice(0, 6).join(' ') === 'tar cf - -C /files --' && /^[a-z0-9.-]+$/.test(commands[6]!);
      const tar = (input: Buffer, argv: string[]): void => {
        const child = spawn('tar', argv);
        const stdout: Buffer[] = []; const stderr: Buffer[] = [];
        child.stdout.on('data', (bytes: Buffer) => stdout.push(bytes));
        child.stderr.on('data', (bytes: Buffer) => stderr.push(bytes));
        child.stdin.on('error', () => {}); child.stdin.end(input);
        child.once('close', code => {
          const archive = Buffer.concat(stdout);
          if (tarDownload && archive.length >= 512 && copyVariant !== 'safe') {
            const header = archive.subarray(0, 512);
            if (copyVariant === 'traversal') { header.fill(0, 0, 100); header.fill(0, 345, 500); header.write('../escape.bin'); }
            if (copyVariant === 'link') { header[156] = 50; header.write('../../escape.bin', 157, 100); }
            if (copyVariant === 'oversize') header.write((100 * 1024 * 1024 + 1).toString(8).padStart(11, '0') + '\0', 124, 12);
            header.fill(32, 148, 156);
            header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8);
          }
          socket.end(Buffer.concat([
          webSocketFrame(1, archive), webSocketFrame(2, Buffer.concat(stderr)),
          webSocketFrame(3, JSON.stringify(code === 0 ? { status: 'Success' } : { status: 'Failure', reason: 'NonZeroExitCode', details: { causes: [{ reason: 'ExitCode', message: String(code) }] } })),
          Buffer.from([0x88, 2, 3, 232]),
          ]));
        });
        socket.once('close', () => child.kill('SIGTERM'));
      };
      if (tarDownload) { tar(Buffer.alloc(0), ['cf', '-', '-C', container, '--', commands[6]!]); return; }
      if (commands[0] === 'echo-bytes' || tarUpload) {
        let pending = head;
        const input: Buffer[] = [];
        const receive = (chunk: Buffer): void => {
          pending = Buffer.concat([pending, chunk]);
          while (pending.length >= 6) {
            const marker = pending[1]! & 127;
            const header = marker === 126 ? 4 : 2;
            if (pending.length < header + 4) return;
            const length = marker === 126 ? pending.readUInt16BE(2) : marker;
            if (pending.length < header + 4 + length) return;
            const mask = pending.subarray(header, header + 4);
            const payload = Buffer.from(pending.subarray(header + 4, header + 4 + length));
            for (let index = 0; index < payload.length; index++) payload[index] = payload[index]! ^ mask[index % 4]!;
            pending = pending.subarray(header + 4 + length);
            if (payload[0] === 0) input.push(payload.subarray(1));
            if (payload[0] === 255 && payload[1] === 0) {
              if (tarUpload) tar(Buffer.concat(input), ['xf', '-', '-C', container]);
              else socket.end(Buffer.concat([webSocketFrame(1, Buffer.concat(input)), webSocketFrame(2, Buffer.from([255, 0, 128])), webSocketFrame(3, status), Buffer.from([0x88, 2, 3, 232])]));
            }
          }
        };
        socket.on('data', receive);
        return;
      }
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
    await check('AC-BYTES-001:session stdin stdout stderr and EOF preserve arbitrary bytes', async () => {
      const bytes = Buffer.from([0, 255, 254, 128, 10, 13, 0]);
      const child = spawn(process.execPath, [join(dirname(cli), '../dist/hosted-session.js')], { env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const events = new EventEmitter();
      const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
      child.stderr!.resume();
      let failure: unknown;
      child.on('message', (raw: unknown) => {
        const event = raw as { event: string; channel: 'stdout' | 'stderr'; base64: string };
        if (event.event === 'output') output[event.channel].push(Buffer.from(event.base64, 'base64'));
        if (event.event === 'failed') failure = event;
        events.emit(event.event, raw);
      });
      const prepared = once(events, 'prepared', { signal: AbortSignal.timeout(15000) });
      const closed = once(child, 'close');
      child.send({ action: 'start', args: ['prepare', '--', 'exec', 'selected', '-n', 'synthetic-remote', '-i', '--', 'echo-bytes'], stdinBase64: bytes.toString('base64'), timeoutMs: 10000 });
      const [{ preview }] = await prepared as [{ preview: { digest: string } }];
      const exited = once(events, 'exit', { signal: AbortSignal.timeout(15000) });
      child.send({ action: 'confirm', digest: preview.digest });
      const [result] = await exited as [{ exitCode: number; stdoutEOF: boolean; stderrEOF: boolean }];
      await closed;
      assert.equal(failure, undefined);
      assert.deepEqual(Buffer.concat(output.stdout), bytes);
      assert.deepEqual(Buffer.concat(output.stderr), Buffer.from([255, 0, 128]));
      assert.deepEqual(result, { event: 'exit', exitCode: 0, stdoutEOF: true, stderrEOF: true });
    });
    await check('AC-SESSION-002:private host disconnect removes the running credential files', async () => {
      const child = spawn(process.execPath, [join(dirname(cli), '../dist/hosted-session.js')], { env: environment, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const events = new EventEmitter();
      const received: string[] = [];
      child.on('message', (raw: unknown) => { const event = raw as { event: string }; received.push(event.event); events.emit(event.event, raw); });
      const prepared = once(events, 'prepared', { signal: AbortSignal.timeout(15000) });
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(15000) });
      let phase = 'prepare';
      try {
        child.send({ action: 'start', args: ['prepare', '--', 'exec', 'selected', '-n', 'synthetic-remote', '--', 'hold'], timeoutMs: 10000 });
        const [{ preview }] = await prepared as [{ preview: { digest: string } }];
        phase = 'upgrade';
        const connected = once(server, 'upgrade', { signal: AbortSignal.timeout(10000) });
        child.send({ action: 'confirm', digest: preview.digest });
        await connected;
        phase = 'disconnect-close';
        child.disconnect();
        await exited;
        phase = 'private-file-cleanup';
        assert.deepEqual(readdirSync(environment.TMPDIR!), []);
      } catch (error) { throw new Error(JSON.stringify({ phase, received }), { cause: error }); }
      finally {
        if (child.exitCode === null && child.signalCode === null) {
          const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped;
        }
      }
    });
    await check('AC-017:TTY requires a local terminal', async () => {
      requests.length = 0;
      const result = await run(['prepare', '--', 'exec', 'selected', '-it', '--', 'true']);
      assert.match(result.stdout, /LOCAL_TERMINAL_REQUIRED/); assert.equal(requests.length, 0);
    });
    for (const operation of ['exec', 'attach'] as const) await check(`B5.1-terminal:${operation} input resize and remote exit use a real Linux PTY`, async () => {
      const prepared = terminal([cli, 'prepare', '--', operation, 'selected', '-n', 'synthetic-remote', '-it', ...(operation === 'exec' ? ['--', 'terminal-probe'] : ['-c', 'terminal-container'])], environment);
      assert.equal(await prepared.closed, 0, prepared.output());
      const saved = decode(prepared.output()) as { request: string };
      const preview = await run(['preview', saved.request]);
      assert.equal(preview.code, 0, preview.stdout);
      const { digest } = decode(preview.stdout) as { digest: string };
      const piped = await run(['confirm', saved.request, '--digest', digest]);
      assert.match(piped.stdout, /LOCAL_TERMINAL_REQUIRED/);
      const session = terminal([cli, 'confirm', saved.request, '--digest', digest], environment);
      try {
        await session.waitFor('terminal-ready');
        await session.waitFor('"Width":80');
        session.send({ resize: [40, 120] });
        await session.waitFor('"Width":120');
        session.send({ input: Buffer.from('secret\n').toString('hex') });
        await session.waitFor('[REDACTED]');
        session.send({ input: Buffer.from('exit\n').toString('hex') });
        assert.equal(await session.closed, 0, session.output());
        assert.match(session.output(), /input:657869740a/);
        assert(!session.output().includes(environment.SYNTHETIC_TOKEN!));
      } finally { session.close(); }
      assert.deepEqual(readdirSync(environment.TMPDIR!), []);
    });
    for (const ending of ['remote failure', 'SIGTERM'] as const) await check(`B5.1-terminal:${ending} preserves exit and removes the session`, async () => {
      const prepared = terminal([cli, 'prepare', '--', 'exec', 'selected', '-n', 'synthetic-remote', '-it', '--', 'terminal-probe'], environment);
      assert.equal(await prepared.closed, 0, prepared.output());
      const { request } = decode(prepared.output()) as { request: string };
      const preview = await run(['preview', request]);
      const { digest } = decode(preview.stdout) as { digest: string };
      const session = terminal([cli, 'confirm', request, '--digest', digest], environment);
      try {
        await session.waitFor('terminal-ready');
        session.send(ending === 'SIGTERM' ? { signal: 'SIGTERM' } : { input: Buffer.from('exitfail\n').toString('hex') });
        assert.equal(await session.closed, ending === 'SIGTERM' ? 143 : 17, session.output());
        assert.deepEqual(readdirSync(environment.TMPDIR!), []);
      } finally { session.close(); }
    });
    for (const [name, args, expected] of [
      ['watch', ['get', 'pods', '-n', 'synthetic-remote', '--watch'], 'selected'],
      ['follow', ['logs', 'selected', '-n', 'synthetic-remote', '--follow'], 'synthetic followed log line'],
    ] as const) await check(`B5.1-terminal:${name} streams until cancellation`, async () => {
      const session = terminal([cli, 'native', '--', ...args], environment);
      try {
        await session.waitFor(expected);
        session.send({ signal: 'SIGTERM' });
        assert.equal(await session.closed, 143, session.output());
        assert.deepEqual(readdirSync(environment.TMPDIR!), []);
      } finally { session.close(); }
    });
    await check('B5.1-terminal:confirmed port forwarding reaches the selected port and cancellation removes its listener', async () => {
      const boundary = await portForwardBoundary(directory);
      portForwardFixture(boundary.upgrade);
      const prepared = terminal([cli, 'prepare', '--', 'port-forward', 'selected', '8080', '-n', 'synthetic-remote'], environment);
      assert.equal(await prepared.closed, 0, prepared.output());
      const { request } = decode(prepared.output()) as { request: string };
      const preview = await run(['preview', request]);
      const { digest } = decode(preview.stdout) as { digest: string };
      const session = terminal([cli, 'confirm', request, '--digest', digest], environment);
      try {
        await session.waitFor('Forwarding from 127.0.0.1:');
        const port = Number(/Forwarding from 127\.0\.0\.1:(\d+)/.exec(session.output())![1]);
        const client = createConnection({ host: '127.0.0.1', port });
        const bytes: Buffer[] = [];
        client.on('data', (chunk: Buffer) => bytes.push(chunk));
        const closed = once(client, 'close', { signal: AbortSignal.timeout(15000) });
        client.end('hello');
        await closed;
        assert.equal(Buffer.concat(bytes).toString(), '8080:hello:drained');
        session.send({ signal: 'SIGTERM' });
        assert.equal(await session.closed, 143, session.output());
        const denied = createConnection({ host: '127.0.0.1', port });
        await assert.rejects(once(denied, 'connect'), { code: 'ECONNREFUSED' });
        assert.deepEqual(readdirSync(environment.TMPDIR!), []);
      } finally { session.close(); portForwardFixture(undefined); await boundary.close(); }
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
    for (const spdy of [false, true]) await check(`R1-execution-display-redaction:${spdy ? 'SPDY fallback' : 'WebSocket GET'}`, async () => {
      const originalToken = environment.SYNTHETIC_TOKEN;
      environment.SYNTHETIC_TOKEN = executionToken;
      fallback = spdy; forwarded.length = 0;
      const commands = ['curl', '--oauth2-bearer', executionToken];
      try {
        const prepared = await run(['prepare', '--', 'exec', 'selected', '-n', 'synthetic-remote', '--', ...commands]);
        assert.equal(prepared.code, 0, prepared.stdout + prepared.stderr);
        const { request } = decode(prepared.stdout) as { request: string };
        delete environment.SYNTHETIC_TOKEN;
        const beforePreview = requests.length;
        const preview = await run(['preview', request]);
        assert.equal(preview.code, 0, preview.stdout + preview.stderr);
        assert.equal(requests.length, beforePreview);
        const value = decode(preview.stdout) as { digest: string; execution: { argv: string[]; query: string } };
        assert.equal(value.execution.argv.at(-1), '[REDACTED]');
        assert.deepEqual(new URLSearchParams(value.execution.query).getAll('command'), ['curl', '--oauth2-bearer', '[REDACTED]']);
        const saved = JSON.parse(readFileSync(join(directory, 'requests', request, 'request.json'), 'utf8'));
        assert.deepEqual(saved.plan.display.execution, value.execution);
        assert.equal(saved.plan.execution.argv.at(-1), executionToken);
        assert.deepEqual(new URLSearchParams(saved.plan.execution.query).getAll('command'), commands);
        environment.SYNTHETIC_TOKEN = executionToken;
        const result = await run(['confirm', request, '--digest', value.digest]);
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.deepEqual(new URLSearchParams(forwarded.at(-1)!.query).getAll('command'), commands);
        assert.equal(result.stderr, 'diagnostic\n');
        for (const output of [prepared, preview, result]) for (const secret of [executionToken, encodeURIComponent(executionToken), new URLSearchParams({ value: executionToken }).toString().slice('value='.length)]) {
          assert(!(output.stdout + output.stderr).includes(secret));
        }
      } finally { environment.SYNTHETIC_TOKEN = originalToken; }
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
