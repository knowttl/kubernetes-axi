import { readFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const pins = JSON.parse(readFileSync(new URL('kubectl-pins.json', root), 'utf8'));
for (const pin of Object.values(pins.binaries)) {
  const path = new URL(`vendor/${pin.file}`, root);
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (actual !== pin.sha256) throw new Error(`Pinned binary digest mismatch: ${pin.file}`);
  if (process.platform !== 'win32') chmodSync(path, 0o755);
}
