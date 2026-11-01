import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const [task, packArgument, artiumArgument] = process.argv.slice(2);
assert(task === 'B5.1' || task === 'B5.2');
assert(packArgument);
const root = resolve(import.meta.dirname, '..');
const pack = resolve(packArgument);
const artium = artiumArgument ? resolve(artiumArgument) : undefined;
assert.equal(process.platform, 'linux', 'B5 currently records Linux evidence only');
assert.equal(readFileSync('/proc/net/route', 'utf8').trim().split('\n').length, 1, 'Offline checks require a loopback-only network namespace');
const checks: { command: string; outcome: string; exitCode: number | null; result?: unknown }[] = [];
let exitCode = 0;
const run = (binary: string, args: string[], cwd = root): string => {
  console.error(`Checking ${binary} ${args.join(' ')}`);
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8', timeout: 900000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GOPROXY: 'off', GOSUMDB: 'off', npm_config_offline: 'true', CI: 'true' } });
  const start = result.stdout.lastIndexOf('\n{\n');
  const json = start >= 0 ? result.stdout.slice(start + 1) : result.stdout;
  let report: unknown;
  if (json.startsWith('{')) {
    try { report = JSON.parse(json); } catch { /* The command's exit status remains authoritative for non-JSON output. */ }
  }
  checks.push({ command: [binary, ...args].join(' '), outcome: result.status === 0 ? 'pass' : result.status === 2 ? 'pending' : 'failure', exitCode: result.status, ...(report ? { result: report } : {}) });
  if (result.status !== 0) {
    exitCode = result.status === 2 && exitCode !== 1 ? 2 : 1;
    process.stderr.write(result.stdout + result.stderr + (result.error?.message ?? ''));
  }
  return result.stdout;
};

if (task === 'B5.2') {
  run('npm', ['run', 'lint', '--offline']);
  run(process.execPath, ['scripts/generate-metadata.ts', '--check']);
  run(process.execPath, ['scripts/generate-protobuf.ts', '--check']);
  run(process.execPath, ['test/private-files.ts']);
  run(process.env.KUBERNETES_AXI_VERIFY_PYTHON ?? 'python3', ['scripts/verify.py', 'task', artium ? 'B1.2' : 'B1.1', '--mode', 'offline', '--pack', pack, '--network-isolated', ...(artium ? ['--artium', artium] : [])]);
}
run(process.execPath, [join(root, 'test/b2.ts'), '--pack', pack, '--task', task,
  ...(task === 'B5.1' ? ['--case', '^B5\\.1|^AC-017:TTY|^AC-029|^CC-009'] : []),
  ...(artium ? ['--artium', artium] : [])], artium ?? root);

const pending = ['Native Windows terminal and live commissioning remain pending.'];
let host: object = { outcome: 'skipped', reason: 'Real Artium journeys are opt-in; supply --artium <frozen-checkout>.' };
if (artium) {
  const revision = spawnSync('git', ['-C', artium, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  assert.equal(revision.status, 0, revision.stderr);
  const archive = spawnSync('git', ['-C', artium, 'archive', revision.stdout.trim()], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(archive.status, 0, archive.stderr.toString());
  host = { outcome: 'executed', revision: revision.stdout.trim(), sourceArchiveSha256: createHash('sha256').update(archive.stdout).digest('hex') };
  if (task === 'B5.2') {
    run('pnpm', ['check'], artium);
    if (process.env.ARTIUM_AXI_HYGIENE_DENY_LIST_FILE) run('pnpm', ['hygiene:check'], artium);
    else {
      checks.push({ command: 'pnpm hygiene:check', outcome: 'pending', exitCode: null });
      pending.push('The owner must run Artium private hygiene with its external private deny list.');
      if (exitCode === 0) exitCode = 2;
    }
    pending.push('Artium container acceptance requires separate owner evidence bound to the frozen revision and input/output digests.');
    checks.push({ command: 'pnpm test:containers', outcome: 'pending', exitCode: null });
    if (exitCode === 0) exitCode = 2;
  }
} else console.error('Artium journeys skipped: supply --artium <frozen-checkout> to opt in.');
console.log(JSON.stringify({ task, outcome: exitCode === 0 ? 'pass' : exitCode === 2 ? 'pending' : 'failure',
  nativeOS: process.platform, mode: 'offline', networkIsolation: 'Linux network namespace; loopback only',
  localPrograms: '0.1.x refuses editors, plugins and external helpers before effects; submit external output through prepare/preview/confirm',
  artium: host, checks, pending }, null, 2));
process.exitCode = exitCode;
