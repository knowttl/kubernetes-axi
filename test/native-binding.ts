import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeConfig } from '../dist/native.js';
import { Redactor } from '../dist/redaction.js';

const directory = await mkdtemp(join(tmpdir(), 'kubernetes-native-binding-'));
try {
  const config = join(directory, 'config.json');
  const inspector = join(directory, 'inspector');
  const fixture = { clusters: [{ name: 'selected', cluster: { server: 'https://cluster.invalid:6443/prefix', 'certificate-authority-data': 'c3ludGhldGljLWNh' } }],
    users: [{ name: 'selected', user: { token: 'synthetic-token' } }], contexts: [{ name: 'selected', context: { cluster: 'selected', user: 'selected' } }], 'current-context': 'selected' };
  await writeFile(config, JSON.stringify(fixture), { mode: 0o600 });
  await writeFile(inspector, `#!/bin/sh\nprintf '%s' '${JSON.stringify(fixture)}'\n`, { mode: 0o700 });
  const loaded = await nativeConfig(inspector, config, undefined, directory, false, new Redactor(), new AbortController().signal, true);
  assert.equal(loaded.binding, '{"cluster":{"server":"https://cluster.invalid:6443/prefix","certificate-authority-data":"c3ludGhldGljLWNh"},"user":{"token":"synthetic-token"},"auth":"token","context":"selected","namespace":"default"}');
  await loaded.close();
} finally { await rm(directory, { recursive: true, force: true }); }
