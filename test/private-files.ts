import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, chmod, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writePrivate, readPrivate } from '../dist/private-files.js';

const directory = await mkdtemp(join(tmpdir(), 'kubernetes-private-'));
const path = join(directory, 'config.json');
try {
  await writePrivate(path, 'previous valid config');
  execFileSync('prlimit', ['--fsize=1024:1024', process.execPath, join(import.meta.dirname, 'private-write.ts'), path], { stdio: 'pipe' });
  assert.equal(await readPrivate(path, true), 'previous valid config');
  assert.deepEqual(await readdir(directory), ['config.json']);
  await writePrivate(path, 'replacement config');
  assert.equal(await readFile(path, 'utf8'), 'replacement config');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await chmod(path, 0o400);
  assert.equal(await readPrivate(path, true), 'replacement config');
  await chmod(path, 0o640);
  await assert.rejects(readPrivate(path, true), { code: 'CONFIG_INSECURE' });
  const redirected = join(directory, 'redirected');
  await symlink(directory, redirected);
  await assert.rejects(readPrivate(join(redirected, 'config.json'), false), { code: 'CONFIG_INSECURE' });
  const protectedPaths: string[] = [];
  const options = { platform: 'win32' as const, restrictAcl: (path: string) => { protectedPaths.push(path); } };
  await writePrivate(path, 'Windows branch', options);
  assert.equal(protectedPaths.length, 2, 'Both containing directory and temporary file must receive the protected ACL');
  let verified = '';
  assert.equal(await readPrivate(path, true, { ...options, diagnostic: true, verifyAcl: path => { verified = path; } }), 'Windows branch');
  assert.equal(verified, path);
  await assert.rejects(readPrivate(path, true, { ...options, diagnostic: true, verifyAcl: () => { throw new Error('insecure DACL'); } }), /insecure DACL/);
  console.log('CC-004/005: atomic failure preservation, redirected paths and private modes passed; Windows ACL branches exercised with injected boundary; native Windows remains pending');
} finally { await rm(directory, { recursive: true, force: true }); }
