import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

// Only the Kubernetes boundary is synthetic. Upstream SPDY framing and the
// installed, digest-pinned kubectl both remain real.
const boundary = `package main
import (
 "fmt"
 "io"
 "net"
 "net/http"
 "sync"
 "k8s.io/apimachinery/pkg/util/httpstream"
 "k8s.io/apimachinery/pkg/util/httpstream/spdy"
)
func main() {
 listener, err := net.Listen("tcp", "127.0.0.1:0"); if err != nil { panic(err) }
 fmt.Println(listener.Addr().String())
 http.Serve(listener, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
  if r.Method != "POST" { http.Error(w, "SPDY required", 400); return }
  if _, err := httpstream.Handshake(r, w, []string{"portforward.k8s.io"}); err != nil { return }
  var lock sync.Mutex
  pairs := map[string]chan httpstream.Stream{}
  pair := func(id string) chan httpstream.Stream { lock.Lock(); defer lock.Unlock(); if pairs[id] == nil { pairs[id] = make(chan httpstream.Stream, 1) }; return pairs[id] }
  connection := spdy.NewResponseUpgrader().UpgradeResponse(w, r, func(stream httpstream.Stream, reply <-chan struct{}) error {
   port := stream.Headers().Get("port"); if port != "8080" && port != "9090" { return fmt.Errorf("unapproved synthetic port") }
   id := stream.Headers().Get("requestID")
   if stream.Headers().Get("streamType") == "error" { pair(id) <- stream; return nil }
   go func() {
    <-reply
    errors := <-pair(id); defer errors.Close(); defer stream.Close()
    stream.Write([]byte(port + ":"))
    buffer := make([]byte, 16384)
    for { n, err := stream.Read(buffer); if n > 0 { if _, failed := stream.Write(buffer[:n]); failed != nil { return } }; if err == io.EOF { stream.Write([]byte(":drained")); return }; if err != nil { return } }
   }()
   return nil
  })
  if connection != nil { <-connection.CloseChan() }
 }))
}
`;

export async function portForwardBoundary(directory: string): Promise<{
  upgrade: (incoming: IncomingMessage, socket: Duplex, head: Buffer) => void;
  close: () => Promise<void>;
}> {
  const root = join(directory, 'port-forward-boundary');
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, 'main.go'), boundary);
  await writeFile(join(root, 'go.mod'), 'module synthetic-port-forward\n\ngo 1.23.0\n\nrequire k8s.io/apimachinery v0.32.2\n');
  await writeFile(join(root, 'go.sum'), await readFile(new URL('../upstream-modules.sum', import.meta.url)));
  const executable = join(root, 'fake-port-forward');
  execFileSync('go', ['build', '-mod=mod', '-o', executable, '.'], { cwd: root, timeout: 120000,
    env: { ...process.env, GOFLAGS: '-p=2', GOPROXY: 'off', GOSUMDB: 'off' }, stdio: 'pipe' });
  const child = spawn(executable, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const [line] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(10000) }) as [Buffer];
  const origin = 'http://' + line.toString('utf8').trim();
  const sockets = new Set<Duplex>();
  return {
    upgrade: (incoming, downstream, head) => {
      if (incoming.method !== 'POST') { downstream.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
      const call = request(origin + incoming.url, { method: 'POST', headers: { ...incoming.headers, host: new URL(origin).host } });
      call.on('upgrade', (reply, upstream, upstreamHead) => {
        sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
        upstream.on('error', () => downstream.destroy());
        downstream.once('close', () => upstream.destroy());
        downstream.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers).map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`).join('\r\n')}\r\n\r\n`);
        if (head.length) upstream.write(head);
        if (upstreamHead.length) downstream.write(upstreamHead);
        downstream.pipe(upstream).pipe(downstream);
      });
      call.on('response', response => { response.resume(); downstream.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
      call.on('error', () => downstream.destroy());
      downstream.once('close', () => call.destroy());
      call.end();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
    },
  };
}
