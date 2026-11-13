import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type ClientRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isAbsolute } from 'node:path';
import { Failure } from './errors.js';
import type { Redactor } from './redaction.js';

export interface HostTransport { socketPath: string }
export interface TransportConfig {
  clusters: { cluster: { server: string; 'tls-server-name'?: string } }[];
  users: { user: { token?: string; exec?: object; 'client-certificate-data'?: string; 'client-key-data'?: string } }[];
}

export class ClusterTransport {
  constructor(private readonly host?: HostTransport) {
    if (host && (typeof host.socketPath !== 'string' || !isAbsolute(host.socketPath) || host.socketPath.includes('\0'))) throw new Failure('CONFIG_INVALID', 'Host transport requires an absolute Unix socket path.');
  }

  refuseSession(): void {
    if (this.host) throw new Failure('HOST_TRANSPORT_UNAVAILABLE', 'Host transport does not support hosted byte sessions or upgrade connections (exec, attach, port-forward).');
  }

  validate(config: TransportConfig): void {
    if (!this.host) return;
    const user = config.users[0]!.user;
    if (!user.token || user.exec || user['client-certificate-data'] || user['client-key-data'] || config.clusters[0]!.cluster['tls-server-name']) {
      throw new Failure('HOST_TRANSPORT_UNAVAILABLE', 'Host transport supports static tokens only; client certificates, credential helpers and TLS server-name overrides are unavailable.');
    }
  }

  request(target: string | URL, options: RequestOptions, callback?: (response: IncomingMessage) => void): ClientRequest {
    if (!this.host) return httpsRequest(target, options, callback);
    const url = new URL(target);
    if (url.protocol !== 'https:') throw new Failure('CONFIG_INVALID', 'Host transport requires the original HTTPS cluster URL.');
    return httpRequest({ socketPath: this.host.socketPath, path: url.pathname + url.search, method: options.method,
      signal: options.signal, agent: false, headers: { ...options.headers, host: url.host } }, callback);
  }

  async kubectl<T extends TransportConfig>(config: T, signal: AbortSignal, redactor: Redactor): Promise<{ config: T; prefix?: string; close: () => Promise<void> }> {
    if (!this.host) return { config, close: async () => {} };
    this.validate(config);
    const cluster = config.clusters[0]!.cluster;
    const capability = randomBytes(32).toString('hex');
    const authorization = `Basic ${Buffer.from(`axi:${capability}`).toString('base64')}`;
    redactor.register(capability, authorization);
    const origin = new URL(cluster.server);
    const proxyOrigin = `http://${origin.host}`;
    const calls = new Set<ClientRequest>();
    const server = createServer((incoming, response) => {
      const supplied = Buffer.from(incoming.headers['proxy-authorization'] ?? '');
      const expected = Buffer.from(authorization);
      if (incoming.method !== 'GET' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || !incoming.url?.startsWith(proxyOrigin + '/')) { response.writeHead(403).end(); return; }
      const path = incoming.url.slice(proxyOrigin.length);
      const target = new URL(cluster.server);
      target.pathname = path.split('?')[0]!;
      target.search = path.includes('?') ? path.slice(path.indexOf('?')) : '';
      const headers = { ...incoming.headers, authorization: `Bearer ${config.users[0]!.user.token}` };
      delete headers['proxy-authorization'];
      const call = this.request(target, { signal, headers }, reply => {
        if (reply.statusCode && reply.statusCode >= 300 && reply.statusCode < 400) { reply.resume(); response.writeHead(502).end(); return; }
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.on('error', () => response.destroy());
        reply.pipe(response);
      });
      calls.add(call);
      call.once('close', () => calls.delete(call));
      call.on('error', () => { if (response.headersSent) response.destroy(); else response.writeHead(502).end(); });
      response.once('close', () => call.destroy());
      incoming.on('error', () => call.destroy());
      incoming.pipe(call);
    });
    server.on('connect', (_request, socket) => socket.destroy());
    server.on('upgrade', (_request, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Failure('CONFIG_INVALID', 'Cannot establish the host transport bridge.');
    const prefix = origin.pathname.replace(/\/$/, '');
    return { config: { ...config, clusters: [{ ...config.clusters[0], cluster: { server: proxyOrigin + prefix, 'proxy-url': `http://axi:${capability}@127.0.0.1:${address.port}` } }], users: [{ ...config.users[0], user: {} }] }, prefix,
      close: async () => {
        for (const call of calls) call.destroy();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      } };
  }
}
