import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'kubernetes-package-'));
const started = performance.now();
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
  name: string; version: string; bin: Record<string, string>;
};
// Published source paths pinned by the admission inventory.
const admissionFiles = [
  'package.json', 'bin/kubernetes-axi.js', 'dist/cli.js', 'dist/credentials.js',
  'dist/runner.js', 'dist/errors.js', 'dist/private-files.js',
  'kubectl-pins.json', 'axi-credential.schema.json',
];
const requiredFiles = [...admissionFiles, 'README.md', 'THIRD_PARTY_NOTICES.md', 'third-party/kubectl-LICENSE.txt'];
if (existsSync(join(root, 'LICENSE'))) requiredFiles.push('LICENSE');

function run(command: string, args: string[], cwd = root): string {
  return execFileSync(command, args, {
    cwd, encoding: 'utf8', timeout: 25_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' },
  });
}

try {
  run('npm', ['pack', '--offline', '--loglevel=error', '--pack-destination', directory]);
  const archives = (await readdir(directory)).filter(file => file.endsWith('.tgz'));
  assert.equal(archives.length, 1, 'npm pack must produce one tarball');
  const archive = join(directory, archives[0]!);
  const entries = run('tar', ['-tzf', archive]).trim().split('\n');
  const files = entries.map(entry => {
    assert.ok(entry.startsWith('package/'), `Unexpected archive root: ${entry}`);
    const file = entry.slice('package/'.length);
    assert.ok(!file.split('/').includes('..'), `Unsafe archive path: ${entry}`);
    assert.doesNotMatch(file, /(?:^|[/.\-])(?:tests?|spec)(?:[/.\-]|$)/, `Test file published: ${file}`);
    assert.match(file, /^(?:package\.json|README\.md|LICENSE|THIRD_PARTY_NOTICES\.md|axi-credential\.schema\.json|kubectl-pins\.json|command-metadata\.json|bin\/kubernetes-axi\.js|dist\/[a-z-]+\.(?:js|d\.ts)|vendor\/kubectl-(?:linux-amd64|windows-amd64\.exe)|third-party\/kubectl-LICENSE\.txt|skills\/kubernetes-axi\/SKILL\.md|docs\/hooks\.md)$/, `Unexpected published file: ${file}`);
    return file;
  });
  for (const file of requiredFiles) assert.ok(files.includes(file), `Missing published contract file: ${file}`);
  assert.equal(manifest.name, '@knowttl/kubernetes-axi');
  assert.deepEqual(manifest.bin, { 'kubernetes-axi': 'bin/kubernetes-axi.js' });
  for (const target of Object.values(manifest.bin)) assert.ok(files.includes(target), `Missing bin target: ${target}`);

  const prefix = join(directory, 'install');
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, archive], directory);
  const require = createRequire(join(prefix, 'package.json'));
  const installedRoot = join(prefix, 'node_modules', manifest.name);
  assert.equal(await realpath(require.resolve(`${manifest.name}/package.json`)), join(installedRoot, 'package.json'));
  const installed = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8')) as typeof manifest;
  assert.equal(installed.name, manifest.name);
  assert.equal(installed.version, manifest.version);
  assert.deepEqual(installed.bin, manifest.bin);
  for (const file of files) {
    if (file.startsWith('vendor/')) continue;
    const content = await readFile(join(installedRoot, file), 'utf8');
    assert.ok(!content.includes(root) && !content.includes(directory), `Local path leaked in ${file}`);
    assert.doesNotMatch(content, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, `Private key leaked in ${file}`);
  }
  const bin = join(prefix, 'node_modules', '.bin', 'kubernetes-axi');
  assert.equal(run(bin, ['--version'], directory).trim(), manifest.version);
  assert.match(run(bin, ['--help'], directory), /kubernetes-axi get pods/);
  const exports: Record<string, string[]> = {
    'dist/cli.js': ['main'],
    'dist/credentials.js': ['identity', 'profiles', 'configPath', 'validateEnvironment'],
    'dist/runner.js': ['readCluster'],
    'dist/errors.js': ['Failure'],
    'dist/private-files.js': ['readPrivate', 'writePrivate', 'privateDirectory'],
  };
  for (const [file, names] of Object.entries(exports)) {
    const resolved: string = require.resolve(`${manifest.name}/${file}`);
    assert.equal(await realpath(resolved), join(installedRoot, file));
    const module = await import(pathToFileURL(resolved).href) as Record<string, unknown>;
    for (const name of names) assert.equal(typeof module[name], 'function', `Missing export ${file}:${name}`);
  }
  for (const file of ['kubectl-pins.json', 'axi-credential.schema.json']) {
    assert.equal(require.resolve(`${manifest.name}/${file}`), join(installedRoot, file));
    JSON.parse(await readFile(join(installedRoot, file), 'utf8'));
  }
  console.log(`Package contract passed (${((performance.now() - started) / 1000).toFixed(1)}s): packed files, offline install, bin smoke and admission exports`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
