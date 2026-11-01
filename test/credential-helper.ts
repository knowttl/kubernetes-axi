import { readFileSync, writeFileSync } from 'node:fs';

const counter = process.env.SYNTHETIC_HELPER_COUNTER!;
const tokens = ['synthetic-helper-first&+/=', 'synthetic-helper-renewed&+/='];
let count = 0;
try { count = Number(readFileSync(counter, 'utf8')); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
writeFileSync(counter, String(count + 1), { mode: 0o600 });
if (process.env.SYNTHETIC_HELPER_FAILURE) {
  process.stdout.write(tokens[0]!);
  process.stderr.write(tokens[0]!);
  process.exitCode = 1;
} else {
  const info = JSON.parse(process.env.KUBERNETES_EXEC_INFO!);
  if (!info.spec.cluster || info.spec.interactive !== false) throw new Error('Expected native cluster information and noninteractive execution');
  console.log(JSON.stringify({ apiVersion: info.apiVersion, kind: 'ExecCredential', status: {
    token: count === 0 ? tokens[0] : tokens[1],
    // Renew once, then cache the renewed identity instead of spawning a helper
    // for every discovery request and exhausting the bounded read deadline.
    expirationTimestamp: count === 0 ? '2000-01-01T00:00:00Z' : '2100-01-01T00:00:00Z',
  } }));
}
