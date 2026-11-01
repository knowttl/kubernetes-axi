import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { request } from 'node:https';
import type { Duplex } from 'node:stream';
import { Failure } from './errors.js';

export interface RemoteConfig {
  'current-context'?: string;
  clusters: { cluster: { server: string; 'certificate-authority-data': string; 'tls-server-name'?: string } }[];
  users: { user: { token?: string; 'client-certificate-data'?: string; 'client-key-data'?: string; exec?: object } }[];
}

// Only the frozen pod and command can be reached, with credentials held by the parent.
export async function remoteSession(config: RemoteConfig, namespace: string, target: string, route: string, query: string, signal: AbortSignal): Promise<{ config: object; close: () => Promise<void> }> {
  const cluster = config.clusters[0]!.cluster;
  const user = config.users[0]!.user;
  if (user.exec) throw new Failure('CAPABILITY_UNAVAILABLE', 'Helper-backed execution requires a reviewed containment boundary.');
  const capability = randomBytes(32).toString('hex');
  const sockets = new Set<Duplex>();
  const server = createServer();
  server.on('upgrade', (incoming, downstream, head) => {
    const url = new URL(incoming.url!, 'http://local');
    const expected = new URLSearchParams(query);
    const actual = new URLSearchParams(url.search);
    expected.sort(); actual.sort();
    if (!['GET', 'POST'].includes(incoming.method!) || url.pathname !== `/${capability}${route}` || expected.toString() !== actual.toString()) {
      downstream.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    sockets.add(downstream);
    downstream.once('close', () => sockets.delete(downstream));
    const call = request(cluster.server.replace(/\/$/, '') + route + url.search, {
      method: incoming.method, signal, ca: Buffer.from(cluster['certificate-authority-data'], 'base64'),
      ...(cluster['tls-server-name'] ? { servername: cluster['tls-server-name'] } : {}),
      ...(user['client-certificate-data'] ? { cert: Buffer.from(user['client-certificate-data'], 'base64') } : {}),
      ...(user['client-key-data'] ? { key: Buffer.from(user['client-key-data'], 'base64') } : {}),
      headers: { ...incoming.headers, host: new URL(cluster.server).host, ...(user.token ? { authorization: `Bearer ${user.token}` } : {}) },
    });
    call.on('upgrade', (reply, upstream, upstreamHead) => {
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
      upstream.once('error', () => downstream.destroy());
      downstream.once('close', () => upstream.destroy());
      downstream.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers).map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`).join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length) downstream.write(upstreamHead);
      if (head.length) upstream.write(head);
      downstream.pipe(upstream).pipe(downstream);
    });
    call.on('response', reply => {
      // A rejected WebSocket handshake must reach kubectl so it can try SPDY.
      downstream.end(`HTTP/1.1 ${reply.statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      reply.resume();
    });
    call.on('error', () => downstream.destroy());
    downstream.once('close', () => call.destroy());
    call.setTimeout(5000, () => call.destroy());
    call.end();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Failure('CONFIG_INVALID', 'Cannot open the bounded execution channel.');
  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  signal.addEventListener('abort', () => { for (const socket of sockets) socket.destroy(); }, { once: true });
  // Native kubectl still reads its target pod before opening the stream.
  server.removeAllListeners('request');
  server.on('request', (incoming, response) => {
    const path = incoming.url?.startsWith(`/${capability}/`) ? incoming.url.slice(capability.length + 1) : '';
    const pathname = path.split('?')[0]!;
    const discovery = /^\/(?:api(?:\/v[0-9]+)?|apis(?:\/[a-z0-9.-]+\/v[0-9]+(?:(?:alpha|beta)[0-9]+)?)?)$/.test(pathname);
    if (incoming.method !== 'GET' || !(pathname === target || discovery)) { response.writeHead(403).end(); return; }
    const call = request(cluster.server.replace(/\/$/, '') + path, {
      ca: Buffer.from(cluster['certificate-authority-data'], 'base64'), signal,
      ...(cluster['tls-server-name'] ? { servername: cluster['tls-server-name'] } : {}),
      ...(user['client-certificate-data'] ? { cert: Buffer.from(user['client-certificate-data'], 'base64') } : {}),
      ...(user['client-key-data'] ? { key: Buffer.from(user['client-key-data'], 'base64') } : {}),
      headers: { accept: 'application/json', ...(user.token ? { authorization: `Bearer ${user.token}` } : {}) },
    }, reply => { response.writeHead(reply.statusCode ?? 502, { 'content-type': 'application/json' }); reply.pipe(response); });
    call.on('error', () => response.destroy());
    call.setTimeout(5000, () => call.destroy()); call.end();
  });
  return { config: { apiVersion: 'v1', kind: 'Config', clusters: [{ name: 'selected', cluster: { server: `http://127.0.0.1:${address.port}/${capability}` } }],
    users: [{ name: 'selected', user: {} }], contexts: [{ name: 'selected', context: { cluster: 'selected', user: 'selected', namespace } }], 'current-context': 'selected' }, close };
}
