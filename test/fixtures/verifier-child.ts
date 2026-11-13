import childProcess from 'node:child_process';
import type { SpawnSyncOptions } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const original = childProcess.spawnSync;
childProcess.spawnSync = ((binary: string, args: readonly string[], options: SpawnSyncOptions) => {
  if (!args[0]?.endsWith('/test/b2.ts')) return original(binary, args, options);
  const scenario = process.env.KUBERNETES_AXI_TEST_HOST_RESULT;
  const filter = new RegExp(args[args.indexOf('--case') + 1]!);
  const cases = ['B4.1-host:workspace', 'B4.2-host:execution', 'B4.3-host:tunnel']
    .filter(name => filter.test(name))
    .map(name => ({ case: name, outcome: scenario === 'failure' ? 'failure' : 'pass' }));
  const hosted = scenario === 'omitted' ? [] : cases;
  const report = scenario === 'missing-report' ? {} : {
    cases: hosted,
    artium: { outcome: hosted.length === 0 ? 'skipped' : scenario === 'failure' ? 'failure' : 'executed', cases: hosted },
  };
  return { status: 0, signal: null, stdout: JSON.stringify(report), stderr: '', pid: 0,
    output: [null, JSON.stringify(report), ''] };
}) as typeof original;
syncBuiltinESMExports();
