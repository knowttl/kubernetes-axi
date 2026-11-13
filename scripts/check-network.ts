import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';

const allowed: Record<string, Record<string, string[]>> = {
  'transport.ts': { 'node:http': ['createServer', 'request'], 'node:https': ['request'] },
  'mutations.ts': { 'node:http': ['createServer'], 'node:child_process': ['execFile'] },
  'remote-session.ts': { 'node:http': ['createServer'] },
  'native.ts': { 'node:net': ['createServer'], 'node:child_process': ['execFile'] },
  'exec-shim.ts': { 'node:net': ['connect'] },
  'runner.ts': { 'node:child_process': ['execFile'] },
  'byte-process.ts': { 'node:child_process': ['spawn'] },
  'private-files.ts': { 'node:child_process': ['execFileSync'] },
};
for (const file of readdirSync(new URL('../src/', import.meta.url)).filter(file => file.endsWith('.ts'))) {
  const source = ts.createSourceFile(file, readFileSync(new URL('../src/' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
      const module = node.moduleSpecifier.text;
      assert(module.startsWith('.') || module.startsWith('node:') || ['ajv', '@toon-format/toon', 'protobufjs'].includes(module), file + ': audit new runtime dependencies for network paths');
      if (/^(node:)?(https?|http2|net|tls|dgram|dns|child_process)$/.test(module)) {
        const imports = node.importClause?.namedBindings;
        assert(imports && ts.isNamedImports(imports), file + ': network namespace imports bypass the transport inventory');
        for (const specifier of imports.elements.filter(specifier => !specifier.isTypeOnly)) {
          assert(allowed[file]?.[module]?.includes((specifier.propertyName ?? specifier.name).text), file + ': upstream networking must use ClusterTransport');
        }
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression;
      const name = ts.isPropertyAccessExpression(expression) ? expression.name.text : ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : expression.getText(source);
      assert(!['fetch', 'WebSocket', 'EventSource', 'require', 'getBuiltinModule', 'eval', 'Function'].includes(name), file + ': unowned network or module loader');
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments?.[0];
        assert(argument && ts.isStringLiteral(argument) && (argument.text.startsWith('./') || argument.text === 'node:os'), file + ': dynamic imports must stay in the audited module graph');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
console.log('Network route inventory passed');
