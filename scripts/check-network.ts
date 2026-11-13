import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { ClusterTransport } from '../dist/transport.js';

for (const file of readdirSync(new URL('../src/', import.meta.url)).filter(file => file.endsWith('.ts') && file !== 'transport.ts')) {
  const source = ts.createSourceFile(file, readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression;
      const name = ts.isPropertyAccessExpression(expression) ? expression.name.text : ts.isIdentifier(expression) ? expression.text : '';
      if (['request', 'get', 'connect', 'fetch', 'WebSocket', 'EventSource'].includes(name) && expression.getText(source) !== 'transport.request') {
        let usesClusterServer = false;
        const check = (child: ts.Node): void => {
          if (ts.isPropertyAccessExpression(child) && child.getText(source) === 'cluster.server') usesClusterServer = true;
          ts.forEachChild(child, check);
        };
        node.arguments?.forEach(check);
        assert(!usesClusterServer, file + ': upstream networking must use ClusterTransport');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
for (const identity of ['token', 'managed-certificate', 'native-certificate', 'exec']) {
  for (const clientCertificate of [false, true]) for (const serverName of [false, true]) {
    for (const override of [false, true]) {
      const transport = new ClusterTransport({ socketPath: '/synthetic/relay.sock', endpoint: 'https://cluster.invalid',
        capabilities: { clientCertificate, serverName }, serverName: 'override.invalid' }, identity === 'managed-certificate');
      const config = { clusters: [{ cluster: { server: 'https://cluster.invalid/prefix', ...(override ? { 'tls-server-name': 'override.invalid' } : {}) } }],
        users: [{ user: identity === 'token' ? { token: 'synthetic-token' } : identity === 'exec' ? { exec: {} } : { 'client-certificate-data': 'Y2VydA==', 'client-key-data': 'a2V5' } }] };
      const allowed = (identity === 'token' || identity === 'managed-certificate' && clientCertificate) && (!override || serverName);
      if (allowed) transport.validate(config);
      else assert.throws(() => transport.validate(config), { code: 'HOST_TRANSPORT_UNAVAILABLE', message: 'Host transport supports static tokens only; client certificates, credential helpers and TLS server-name overrides are unavailable.' });
      assert.throws(() => transport.refuseSession(), { code: 'HOST_TRANSPORT_UNAVAILABLE' });
    }
  }
}
console.log('Network route inventory passed');
