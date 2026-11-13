import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';

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
console.log('Network route inventory passed');
