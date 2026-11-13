import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
for (const [scenario, optIn, status, outcome, hostedOutcome, names] of [
  ['completed', true, 0, 'pass', 'executed', ['B4.1-host:workspace', 'B4.2-host:execution', 'B4.3-host:tunnel']],
  ['omitted', true, 2, 'pending', 'skipped', []],
  ['failure', true, 1, 'failure', 'failure', ['B4.1-host:workspace', 'B4.2-host:execution', 'B4.3-host:tunnel']],
  ['missing-report', true, 1, 'failure', 'failure', []],
  ['completed', false, 0, 'pass', 'skipped', []],
] as const) {
  const result = spawnSync(process.execPath, ['--import', join(root, 'test/fixtures/verifier-child.ts'),
    join(root, 'scripts/verify-b5.ts'), 'B5.1', join(root, 'evidence'), ...(optIn ? [join(root, 'synthetic-host')] : [])], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, KUBERNETES_AXI_TEST_HOST_RESULT: scenario },
  });
  assert.equal(result.status, status, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout) as { outcome: string; artium: { outcome: string; cases?: { case: string }[]; reason?: string } };
  assert.equal(report.outcome, outcome);
  assert.equal(report.artium.outcome, hostedOutcome);
  assert.deepEqual(report.artium.cases?.map(item => item.case) ?? [], names);
}
console.log('Optional B5 verifier reports completed, omitted, failed and absent hosted execution accurately.');
