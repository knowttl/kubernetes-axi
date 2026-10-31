import { readFileSync, chmodSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const pins = JSON.parse(readFileSync(new URL('kubectl-pins.json', root), 'utf8'));
for (const pin of Object.values(pins.binaries)) {
  const path = new URL(`vendor/${pin.file}`, root);
  let bytes;
  let missing = false;
  try { bytes = readFileSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    missing = true;
    const response = await fetch(pin.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Pinned binary download failed: ${pin.file} (HTTP ${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== pin.sha256) {
    if (missing) rmSync(path, { force: true });
    throw new Error(`Pinned binary digest mismatch: ${pin.file}`);
  }
  if (missing) {
    mkdirSync(new URL('vendor/', root), { recursive: true });
    writeFileSync(path, bytes, { mode: 0o755 });
  }
  if (process.platform !== 'win32') chmodSync(path, 0o755);
}
