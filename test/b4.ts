import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import type { Server } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConnection } from 'node:net';
import type { Duplex } from 'node:stream';
import { portForwardBoundary } from './port-forward.ts';
import { copyFixtureVariant, portForwardFixture } from './remote.ts';

export async function checkB4Host(context: {
  artium: string; directory: string; cli: string; environment: NodeJS.ProcessEnv; server: Server;
  check: (name: string, action: () => Promise<void>) => Promise<void>;
  run: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}): Promise<void> {
  const { artium, directory, cli, environment, server, check, run } = context;
  const host = (path: string): Promise<any> => import(pathToFileURL(join(artium, path)).href);
  const [{ createApp }, { Runner }, { Audit }, { openStore, createCredentialStore }, { EnvironmentKeyProvider },
    { EmbeddedSecretSource }, { SharedIdentityResolver }, { createKubernetesAdapter }, { seedToolUser }] = await Promise.all([
    host('dist/src/server/app.js'), host('dist/src/server/runner/runner.js'), host('dist/src/server/audit/audit.js'),
    host('dist/src/server/store/db.js'), host('dist/src/server/store/key-provider.js'), host('dist/src/server/store/secret-source.js'),
    host('dist/src/server/policy/identity-resolver.js'), host('dist/src/server/adapters/kubernetes.js'), host('dist/test/fixtures/tokens.js'),
  ]);
  const temporary = join(directory, 'host-sessions');
  await mkdir(temporary, { mode: 0o700 });
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = temporary;
  const provider = new EnvironmentKeyProvider({ ARTIUM_AXI_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') });
  const db = openStore(join(directory, 'host-data', 'artium.db'), provider);
  await seedToolUser(db);
  const user = 'synthetic-development-user';
  db.exec(`UPDATE tools SET enabled=1 WHERE name='kubernetes-axi';
    UPDATE users SET administrator=1 WHERE id='${user}';
    INSERT INTO users (id, username, display_name, password_hash, must_change)
    SELECT 'synthetic-other', 'synthetic-other', 'Other', password_hash, 0 FROM users WHERE id='${user}';
    INSERT INTO user_roles (user_id, role_id) VALUES ('synthetic-other', 'synthetic-role')`);
  const store = createCredentialStore(db, provider);
  const { profiles } = JSON.parse(await readFile(environment.KUBERNETES_AXI_CONFIG!, 'utf8'));
  store.replaceCredential('kubernetes-axi', { ...profiles.selected, token: environment.SYNTHETIC_TOKEN }, 0, user, Date.now());
  const adapter = createKubernetesAdapter(new EmbeddedSecretSource(store), join(directory, 'host-writes.log'));
  adapter.executable = cli;
  const app = createApp({ db, audit: new Audit(db), runner: await Runner.create(join(directory, 'host-calls')),
    resolver: new SharedIdentityResolver(store), adapters: [adapter], credentialStore: store, environment: {} });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const login = async (username: string): Promise<Record<string, string>> => {
    const result = await fetch(url + '/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'CANARY-local-password' }) });
    assert.equal(result.status, 200, await result.clone().text());
    const { accessToken } = await result.json() as { accessToken: string };
    return { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
  };
  const headers = await login('synthetic-user');
  const other = await login('synthetic-other');
  const prefix = '/v1/tools/kubernetes-axi/sessions';
  const call = async (path: string, method = 'GET', body?: unknown, selected = headers): Promise<Response> => {
    const { 'content-type': _contentType, ...withoutBody } = selected;
    return fetch(url + path, { method, headers: body === undefined ? withoutBody : selected,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  };
  const grants = (operations: string[]): void => {
    db.prepare('UPDATE tools SET native_settings=? WHERE name=?').run(JSON.stringify({ sessions: { grants: { [user]: operations, 'synthetic-other': operations } } }), 'kubernetes-axi');
  };
  const replaceCredential = (): void => {
    const { revision } = store.findCredential('kubernetes-axi');
    store.replaceCredential('kubernetes-axi', { ...profiles.selected, token: environment.SYNTHETIC_TOKEN }, revision, user, Date.now());
  };
  const revoke = async (): Promise<void> => {
    const response = await call('/v1/auth/reauth', 'POST', { password: 'CANARY-local-password' });
    assert.equal(response.status, 200, await response.clone().text());
    const { ticket } = await response.json() as { ticket: string };
    const proof = { ...headers, 'x-artium-reauth-ticket': ticket };
    const selected = await call('/v1/admin/tools/kubernetes-axi', 'GET', undefined, proof);
    assert.equal(selected.status, 200, await selected.clone().text());
    const current = await selected.json() as { revision: number };
    const mutation = await call('/v1/admin/tools/kubernetes-axi', 'PATCH', { expectedRevision: current.revision,
      nativeSettings: { sessions: { grants: { [user]: [] } } } }, proof);
    assert.equal(mutation.status, 200, await mutation.clone().text());
  };
  const start = async (command: string, input = Buffer.alloc(0), limits: { lifetimeSeconds?: number; outputBytes?: number } = {}): Promise<{ id: string; preview: { digest: string } }> => {
    const response = await call(prefix, 'POST', { kind: 'exec', argv: ['prepare', '--', 'exec', 'selected', '-n', 'synthetic-remote', '-i', '--', command], stdinBase64: input.toString('base64'), limits });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as { id: string; preview: { digest: string } };
  };
  const clean = async (): Promise<void> => {
    for (const root of await readdir(temporary)) assert.deepEqual(await readdir(join(temporary, root)), [], root);
  };
  const uploadTree = async (files: { path: string; bytes: Buffer }[]): Promise<string> => {
    const response = await call('/v1/tools/kubernetes-axi/workspaces', 'POST', { files: files.map(file => ({ path: file.path,
      bytes: file.bytes.length, sha256: createHash('sha256').update(file.bytes).digest('hex') })) });
    assert.equal(response.status, 200, await response.clone().text());
    const workspace = await response.json() as { id: string };
    for (const file of files) {
      const result = await fetch(`${url}/v1/tools/kubernetes-axi/workspaces/${workspace.id}/files/${file.path}`, { method: 'PUT',
        headers: { authorization: headers.authorization!, 'content-type': 'application/octet-stream' }, body: new Uint8Array(file.bytes) });
      assert.equal(result.status, 200, await result.text());
    }
    return workspace.id;
  };
  let boundary: Awaited<ReturnType<typeof portForwardBoundary>> | undefined;
  const forward = async (limits: { lifetimeSeconds?: number } = {}): Promise<{ id: string; stopped: Promise<unknown> }> => {
    boundary ??= await portForwardBoundary(directory);
    let upstream: Duplex | undefined;
    portForwardFixture((incoming, socket, head) => {
      if (incoming.method === 'POST') upstream = socket;
      boundary!.upgrade(incoming, socket, head);
    });
    const response = await call(prefix, 'POST', { kind: 'port-forward', argv: ['prepare', '--', 'port-forward', 'selected', '0:8080', '0:9090', '-n', 'synthetic-remote'], limits });
    assert.equal(response.status, 200, await response.clone().text());
    const session = await response.json() as { id: string; preview: { digest: string } };
    assert.equal((await call(`${prefix}/${session.id}/confirm`, 'POST', { digest: session.preview.digest })).status, 200);
    const readiness = await call(`${prefix}/${session.id}?wait=ready`);
    assert.equal(readiness.status, 200, await readiness.clone().text());
    const ready = await readiness.json() as { state: string; tunnelReady: boolean };
    assert.equal(ready.state, 'running'); assert.equal(ready.tunnelReady, true);
    assert(upstream);
    const signal = AbortSignal.timeout(15000);
    return { ...session, stopped: Promise.race([once(upstream, 'end', { signal }), once(upstream, 'close', { signal })]) };
  };
  try {
    await check('B4.2-host:ungranted exec is denied before dispatch', async () => {
      const response = await call(prefix, 'POST', { kind: 'exec', argv: ['prepare', '--', 'exec', 'selected', '--', 'true'] });
      assert.equal(response.status, 403);
    });
    grants(['exec']);
    await check('B4.2-host:owned binary output and independent EOF survive the real API', async () => {
      const input = Buffer.from([0, 255, 254, 128, 10, 13, 0]);
      const workspace = await uploadTree([{ path: 'stdin.bin', bytes: input }]);
      const created = await call(prefix, 'POST', { kind: 'exec', argv: ['prepare', '--', 'exec', 'selected', '-n', 'synthetic-remote', '-i', '--', 'echo-bytes'],
        inputArtifact: { workspace, path: 'stdin.bin' } });
      assert.equal(created.status, 200, await created.clone().text());
      const session = await created.json() as { id: string; preview: { digest: string } };
      for (const [path, method] of [[`/${session.id}`, 'GET'], [`/${session.id}/output`, 'GET'], [`/${session.id}`, 'DELETE']]) {
        assert.equal((await call(prefix + path, method, undefined, other)).status, 404);
      }
      assert.equal((await call(`${prefix}/${session.id}/confirm`, 'POST', { digest: '0'.repeat(64) })).status, 400);
      assert.equal((await call(`${prefix}/${session.id}/confirm`, 'POST', { digest: session.preview.digest })).status, 200);
      const done = await call(`${prefix}/${session.id}?wait=true`);
      assert.equal(done.status, 200, await done.clone().text());
      const status = await done.json() as { state: string; stdoutEOF: boolean; stderrEOF: boolean; exitCode: number };
      assert.equal(status.state, 'exited'); assert.equal(status.exitCode, 0);
      assert.equal(status.stdoutEOF, true); assert.equal(status.stderrEOF, true);
      const output = await (await call(`${prefix}/${session.id}/output`)).json() as { chunks: { channel: string; sequence: number; offset: number; length: number; base64: string }[]; gap: boolean };
      assert.equal(output.gap, false);
      assert.deepEqual(Buffer.concat(output.chunks.filter(chunk => chunk.channel === 'stdout').map(chunk => Buffer.from(chunk.base64, 'base64'))), input);
      assert.deepEqual(Buffer.concat(output.chunks.filter(chunk => chunk.channel === 'stderr').map(chunk => Buffer.from(chunk.base64, 'base64'))), Buffer.from([255, 0, 128]));
      assert.equal((await call(`/v1/tools/kubernetes-axi/workspaces/${workspace}`, 'DELETE')).status, 204);
      await clean();
    });
    await check('B4.2-host:nonzero remote exit remains distinct from channel EOF', async () => {
      grants(['exec']);
      const session = await start('fail');
      await call(`${prefix}/${session.id}/confirm`, 'POST', { digest: session.preview.digest });
      const response = await call(`${prefix}/${session.id}?wait=true`);
      const result = await response.json() as { state: string; exitCode: number; stdoutEOF: boolean; stderrEOF: boolean };
      assert.equal(result.state, 'failed'); assert.equal(result.exitCode, 17);
      assert.equal(result.stdoutEOF, true); assert.equal(result.stderrEOF, true);
      await clean();
    });
    await check('B4.2-host:non-interactive attach retains separate channels and EOF', async () => {
      grants(['attach']);
      const response = await call(prefix, 'POST', { kind: 'attach', argv: ['prepare', '--', 'attach', 'selected', '-n', 'synthetic-remote', '--quiet'] });
      assert.equal(response.status, 200, await response.clone().text());
      const session = await response.json() as { id: string; preview: { digest: string } };
      await call(`${prefix}/${session.id}/confirm`, 'POST', { digest: session.preview.digest });
      const status = await (await call(`${prefix}/${session.id}?wait=true`)).json() as { exitCode: number; stdoutEOF: boolean; stderrEOF: boolean };
      assert.equal(status.exitCode, 0); assert.equal(status.stdoutEOF, true); assert.equal(status.stderrEOF, true);
      const output = await (await call(`${prefix}/${session.id}/output`)).json() as { chunks: { channel: string; base64: string }[] };
      assert.equal(Buffer.concat(output.chunks.filter(chunk => chunk.channel === 'stdout').map(chunk => Buffer.from(chunk.base64, 'base64'))).toString(), '[]');
      assert.equal(Buffer.concat(output.chunks.filter(chunk => chunk.channel === 'stderr').map(chunk => Buffer.from(chunk.base64, 'base64'))).toString(), 'diagnostic\n');
      await clean();
    });
    await check('B4.2-host:cancellation terminates the child and removes its private files', async () => {
      grants(['exec']);
      const session = await start('hold');
      const connected = once(server, 'upgrade', { signal: AbortSignal.timeout(10000) });
      await call(`${prefix}/${session.id}/confirm`, 'POST', { digest: session.preview.digest });
      await connected;
      const result = await call(`${prefix}/${session.id}`, 'DELETE');
      assert.equal(result.status, 200);
      assert.equal((await result.json() as { state: string }).state, 'cancelled');
      assert.equal((await call(`${prefix}/${session.id}`, 'DELETE')).status, 200);
      await clean();
    });
    for (const [reason, status] of [['operation revocation', 403], ['credential revision change', 409]] as const) await check(`B4.2-host:${reason} denies retained output and cancels execution`, async () => {
      grants(['exec']);
      const session = await start('hold');
      try {
        const connected = once(server, 'upgrade', { signal: AbortSignal.timeout(10000) });
        await call(`${prefix}/${session.id}/confirm`, 'POST', { digest: session.preview.digest });
        const [, peer] = await connected as [IncomingMessage, Duplex];
        const signal = AbortSignal.timeout(10000);
        const stopped = Promise.race([once(peer, 'end', { signal }), once(peer, 'close', { signal })]);
        if (reason === 'operation revocation') await revoke();
        else replaceCredential();
        const denied = await call(`${prefix}/${session.id}/output`);
        assert.equal(denied.status, status);
        assert.equal((await call(`${prefix}/${session.id}`)).status, status);
        await stopped;
        await clean();
      } finally { await call(`${prefix}/${session.id}`, 'DELETE'); }
    });
    await check('B4.2-host:expiry terminates the child and marks the incomplete channels', async () => {
      grants(['exec']);
      const session = await start('hold', Buffer.alloc(0), { lifetimeSeconds: 1 });
      assert.equal((await call(`${prefix}/${session.id}/confirm`, 'POST', { digest: session.preview.digest })).status, 200);
      const response = await call(`${prefix}/${session.id}?wait=true`);
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json() as { state: string; stdoutEOF: boolean; stderrEOF: boolean };
      assert.equal(result.state, 'expired');
      assert.equal(result.stdoutEOF, false); assert.equal(result.stderrEOF, false);
      await clean();
    });
    await check('B4.2-host:bounded retained output exposes its gap and byte counts', async () => {
      grants(['exec']);
      const session = await start('echo-bytes', Buffer.alloc(1024, 173), { outputBytes: 32 });
      await call(`${prefix}/${session.id}/confirm`, 'POST', { digest: session.preview.digest });
      await call(`${prefix}/${session.id}?wait=true`);
      const result = await (await call(`${prefix}/${session.id}/output`)).json() as { gap: boolean; truncated: boolean; chunks: { length: number; base64: string }[] };
      assert.equal(result.gap, true); assert.equal(result.truncated, true);
      assert.equal(result.chunks.reduce((sum, chunk) => sum + Buffer.from(chunk.base64, 'base64').length, 0), 32);
      await clean();
    });
    for (const [kind, argv, expected] of [
      ['logs', ['logs', 'selected', '-n', 'synthetic-remote', '-c', 'selected-container', '--follow'], 'synthetic followed log line'],
      ['watch', ['get', 'pods', '-n', 'synthetic-remote', '--watch-only', '-o', 'json'], 'selected'],
    ] as const) await check(`B4.2-host:${kind} streams output until cancellation`, async () => {
      grants([kind]);
      const created = await call(prefix, 'POST', { kind, argv });
      assert.equal(created.status, 200, await created.clone().text());
      const session = await created.json() as { id: string };
      const response = await call(`${prefix}/${session.id}/output?waitMs=10000`);
      assert.equal(response.status, 200, await response.clone().text());
      const output = await response.json() as { chunks: { channel: string; base64: string }[]; stdoutEOF: boolean };
      assert.match(Buffer.concat(output.chunks.filter(chunk => chunk.channel === 'stdout').map(chunk => Buffer.from(chunk.base64, 'base64'))).toString('utf8'), new RegExp(expected), JSON.stringify(output));
      assert.equal(output.stdoutEOF, false);
      assert.equal((await call(`${prefix}/${session.id}`, 'DELETE')).status, 200);
      await clean();
    });
    grants(['cp']);
    await check('B4.1-host:workspace upload container copy and artifact return preserve binary bytes', async () => {
      const binary = Buffer.from([0, 255, 254, 128, 10, 13, 0]);
      const manifest = Buffer.from('{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"synthetic"}}');
      const files = [{ path: 'nested/binary.bin', bytes: binary }, { path: 'manifests/config.json', bytes: manifest }];
      const workspace = await uploadTree(files);
      const copy = async (argv: string[], selectedWorkspace?: string): Promise<string> => {
        const created = await call(prefix, 'POST', { kind: 'cp', argv: ['prepare', '--', 'cp', ...argv], ...(selectedWorkspace ? { workspace: selectedWorkspace } : {}) });
        assert.equal(created.status, 200, await created.clone().text());
        const session = await created.json() as { id: string; preview: { digest: string } };
        assert.equal((await call(`${prefix}/${session.id}/confirm`, 'POST', { digest: session.preview.digest })).status, 200);
        const finished = await call(`${prefix}/${session.id}?wait=true`);
        assert.equal(finished.status, 200, await finished.clone().text());
        const value = await finished.json() as { exitCode: number; state: string };
        assert.equal(value.state, 'exited', JSON.stringify(value));
        assert.equal(value.exitCode, 0);
        return session.id;
      };
      await copy(['workspace:nested/binary.bin', 'synthetic-remote/selected:/files/binary.bin'], workspace);
      assert.deepEqual(await readFile(join(directory, 'container', 'files', 'binary.bin')), binary);
      const download = await copy(['synthetic-remote/selected:/files/binary.bin', 'artifact:download.bin']);
      const artifact = await call(`${prefix}/${download}/artifacts/download.bin`);
      assert.equal(artifact.status, 200, await artifact.clone().text());
      assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), binary);
      assert.equal(artifact.headers.get('x-artium-content-sha256'), createHash('sha256').update(binary).digest('hex'));
      assert.equal((await call(`${prefix}/${download}/artifacts/download.bin`, 'GET', undefined, other)).status, 404);
      assert.equal((await call(`${prefix}/${download}`, 'DELETE')).status, 200);
      assert.equal((await call(`${prefix}/${download}/artifacts/download.bin`)).status, 400);
    });
    for (const [variant, fileArgs] of [
      ['stdin', ['-f', '-']],
      ['recursive', ['--filename=workspace:manifests', '--recursive']],
      ['kustomize', ['-k', 'workspace:kustomize']],
    ] as const) await check(`B4.1-host:${variant} manifests are frozen and confirmed from the caller workspace`, async () => {
      grants(['apply']);
      const name = `b4-${variant}`;
      const bytes = Buffer.from(JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: 'synthetic-b3' }, data: { value: variant } }));
      const workspace = await uploadTree([
        { path: 'manifests/nested/config.json', bytes }, { path: 'kustomize/config.json', bytes },
        { path: 'kustomize/kustomization.yaml', bytes: Buffer.from('resources:\n- config.json\n') },
      ]);
      let mutations = 0;
      const observe = (request: IncomingMessage): void => { if (!['GET', 'HEAD'].includes(request.method!)) mutations++; };
      server.on('request', observe);
      try {
        const response = await call(prefix, 'POST', { kind: 'apply', argv: ['prepare', '--', 'apply', '-n', 'synthetic-b3', '--validate=false', ...fileArgs], workspace,
          stdin: bytes.toString('utf8') });
        assert.equal(response.status, 200, await response.clone().text());
        const session = await response.json() as { id: string; preview: { digest: string } };
        assert(session.preview, JSON.stringify(session));
        assert.equal(mutations, 0);
        assert.equal((await call(`${prefix}/${session.id}/confirm`, 'POST', { digest: session.preview.digest })).status, 200);
        const finished = await (await call(`${prefix}/${session.id}?wait=true`)).json() as { state: string; result?: unknown };
        assert.equal(finished.state, 'exited', JSON.stringify(finished));
        assert.equal(mutations, 1);
        const selected = await run(['native', '--', 'get', 'configmap', name, '-n', 'synthetic-b3', '-o', 'json']);
        assert.equal(selected.code, 0, selected.stdout + selected.stderr);
        assert.equal(JSON.parse(selected.stdout).data.value, variant);
      } finally { server.off('request', observe); }
    });
    for (const [variant, expected] of [['traversal', 'PATH_REFUSED'], ['link', 'PATH_REFUSED'], ['oversize', 'TRANSFER_LIMIT'], ['credential', 'CREDENTIAL_OUTPUT_REFUSED']] as const) {
      await check(`B4.1-host:${variant} container archives fail before artifact materialization`, async () => {
        grants(['cp']);
        await writeFile(join(directory, 'container', 'files', 'binary.bin'), variant === 'credential' ? Buffer.from(environment.SYNTHETIC_TOKEN!) : Buffer.from([0, 255, 128]));
        copyFixtureVariant(variant === 'credential' ? 'safe' : variant);
        try {
          const created = await call(prefix, 'POST', { kind: 'cp', argv: ['prepare', '--', 'cp', 'synthetic-remote/selected:/files/binary.bin', 'artifact:download.bin'] });
          assert.equal(created.status, 200, await created.clone().text());
          const session = await created.json() as { id: string; preview: { digest: string } };
          await call(`${prefix}/${session.id}/confirm`, 'POST', { digest: session.preview.digest });
          const status = await (await call(`${prefix}/${session.id}?wait=true`)).json() as { state: string; code: string; artifacts?: unknown };
          assert.equal(status.state, 'failed'); assert.equal(status.code, expected);
          assert.equal(status.artifacts, undefined);
          assert.equal((await call(`${prefix}/${session.id}/artifacts/download.bin`)).status, 400);
        } finally { copyFixtureVariant('safe'); }
      });
    }
    for (const file of [
      { path: '../escape.bin', bytes: 1, sha256: '0'.repeat(64) },
      { path: 'link', bytes: 0, sha256: '0'.repeat(64), link: '/outside' },
      { path: 'huge.bin', bytes: 100 * 1024 * 1024 + 1, sha256: '0'.repeat(64) },
    ]) await check(`B4.1-host:unsafe workspace declaration ${file.path} is refused before upload`, async () => {
      assert.equal((await call('/v1/tools/kubernetes-axi/workspaces', 'POST', { files: [file] })).status, 400);
    });
    grants(['port-forward']);
    await check('B4.3-host:two ports concurrent streams and half-close drain through authenticated loopback', async () => {
      const session = await forward();
      const { openKubernetesTunnel } = await host('dist/src/cli/kubernetes-tunnel.js');
      const controller = new AbortController();
      const token = headers.authorization!.slice('Bearer '.length);
      const tunnel = await openKubernetesTunnel({ serverUrl: url, session: session.id, ports: [8080, 9090], accessToken: token, signal: controller.signal });
      const exchange = async (local: number, remote: number, payload: Buffer): Promise<void> => {
        const connection = createConnection({ host: '127.0.0.1', port: local, allowHalfOpen: true });
        const chunks: Buffer[] = [];
        connection.on('data', bytes => chunks.push(bytes));
        const complete = once(connection, 'end', { signal: AbortSignal.timeout(15000) });
        connection.end(payload);
        await complete;
        connection.destroy();
        assert.deepEqual(Buffer.concat(chunks), Buffer.concat([Buffer.from(`${remote}:`), payload, Buffer.from(':drained')]));
      };
      try {
        await assert.rejects(openKubernetesTunnel({ serverUrl: url, session: session.id, ports: [8080], accessToken: other.authorization!.slice('Bearer '.length), signal: controller.signal }));
        await assert.rejects(openKubernetesTunnel({ serverUrl: url, session: session.id, ports: [7777], accessToken: token, signal: controller.signal }));
        await Promise.all([
          exchange(tunnel.ports[0].local, 8080, Buffer.from([0, 255, 128, 1])),
          exchange(tunnel.ports[1].local, 9090, Buffer.from('selected-second-port')),
          exchange(tunnel.ports[0].local, 8080, Buffer.alloc(256 * 1024, 173)),
        ]);
        const cancelled = await call(`${prefix}/${session.id}`, 'DELETE');
        assert.equal(cancelled.status, 200);
        await tunnel.closed;
        await session.stopped;
        await assert.rejects(new Promise<void>((resolve, reject) => {
          const socket = createConnection({ host: '127.0.0.1', port: tunnel.ports[0].local });
          socket.once('error', reject); socket.once('connect', () => { socket.destroy(); resolve(); });
        }));
      } finally { controller.abort(); await tunnel.close(); }
    });
    for (const [reason, status] of [['revocation', 403], ['credential revision change', 409], ['expiry', 200]] as const) await check(`B4.3-host:${reason} removes loopback listeners and denies reconnection`, async () => {
      grants(['port-forward']);
      const session = await forward(reason === 'expiry' ? { lifetimeSeconds: 3 } : {});
      try {
        const { openKubernetesTunnel } = await host('dist/src/cli/kubernetes-tunnel.js');
        const controller = new AbortController();
        const options = { serverUrl: url, session: session.id, ports: [8080, 9090], accessToken: headers.authorization!.slice('Bearer '.length), signal: controller.signal };
        const tunnel = await openKubernetesTunnel(options);
        const clients: Duplex[] = [];
        const disconnected: Promise<unknown>[] = [];
        try {
          for (const port of tunnel.ports) {
            const socket = createConnection({ host: '127.0.0.1', port: port.local });
            clients.push(socket);
            const signal = AbortSignal.timeout(15000);
            disconnected.push(once(socket, 'close', { signal }));
            const [bytes] = await once(socket, 'data', { signal }) as [Buffer];
            assert(bytes.length > 0);
          }
          if (reason === 'revocation') await revoke();
          else if (reason === 'credential revision change') replaceCredential();
          else {
            const response = await call(`${prefix}/${session.id}?wait=true`);
            assert.equal(response.status, status, await response.clone().text());
            assert.equal((await response.json() as { state: string }).state, 'expired');
          }
          if (reason !== 'expiry') {
            assert.equal((await call(`${prefix}/${session.id}/output`)).status, status);
            assert.equal((await call(`${prefix}/${session.id}`)).status, status);
          }
          await tunnel.closed;
          await session.stopped;
          await Promise.all(disconnected);
          await assert.rejects(openKubernetesTunnel(options));
          for (const port of tunnel.ports) await assert.rejects(new Promise<void>((resolve, reject) => {
            const socket = createConnection({ host: '127.0.0.1', port: port.local });
            socket.once('error', reject); socket.once('connect', () => { socket.destroy(); resolve(); });
          }));
          await clean();
        } finally { for (const socket of clients) socket.destroy(); controller.abort(); await tunnel.close(); }
      } finally { await call(`${prefix}/${session.id}`, 'DELETE'); }
    });
    await check('B4.3-host:ungranted raw and nested proxy effects are denied before forwarding', async () => {
      let upstream = 0;
      const observe = (): void => { upstream++; };
      server.on('request', observe);
      try {
        for (const argv of [
          ['get', '--raw=/api/v1/namespaces/synthetic-b3/configmaps/selected'],
          ['create', '--raw=/api/v1/namespaces/synthetic-b3/configmaps', '-f', '-'],
          ['replace', '--raw=/api/v1/namespaces/synthetic-b3/configmaps/selected', '-f', '-'],
          ['patch', 'configmap', 'selected', '-n', 'synthetic-b3', '--type=merge', '-p', '{"data":{"value":"denied"}}'],
          ['delete', '--raw=/api/v1/namespaces/synthetic-b3/configmaps/selected'],
          ['get', '--raw=/api/v1/namespaces/synthetic-remote/pods/selected/proxy/exec'],
        ]) {
          const response = await call('/v1/tools/kubernetes-axi/run', 'POST', { args: ['native', '--', ...argv] });
          assert.equal(response.status, 400, await response.clone().text());
          assert.equal((await response.json() as { error: { code: string } }).error.code, 'FLAG_BLOCKED');
        }
        assert.equal(upstream, 0);
      } finally { server.off('request', observe); }
    });
    await check('B4.2-host:shutdown removes the process and session state before restart', async () => {
      grants(['exec']);
      const session = await start('hold');
      const connected = once(server, 'upgrade', { signal: AbortSignal.timeout(10000) });
      await call(`${prefix}/${session.id}/confirm`, 'POST', { digest: session.preview.digest });
      await connected;
      await app.close();
      assert.deepEqual(await readdir(temporary), []);
      const restarted = createApp({ db, audit: new Audit(db), runner: await Runner.create(join(directory, 'restarted-calls')),
        resolver: new SharedIdentityResolver(store), adapters: [adapter], credentialStore: store, environment: {} });
      try {
        const restartedUrl = await restarted.listen({ host: '127.0.0.1', port: 0 });
        const response = await fetch(`${restartedUrl}${prefix}/${session.id}`, { headers: { authorization: headers.authorization! }, signal: AbortSignal.timeout(10000) });
        assert.equal(response.status, 404);
      } finally { await restarted.close(); }
      assert.deepEqual(await readdir(temporary), []);
    });
  } finally {
    portForwardFixture(undefined);
    await boundary?.close();
    await app.close(); db.close();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
}
