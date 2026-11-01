import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';

// Observe real filesystem writes without retaining a trace containing credentials.
export async function deliverCredential(cli: string, environment: NodeJS.ProcessEnv, args: string[], canary: string, started?: (cancel: () => void) => void) {
  const observer = process.env.KUBERNETES_AXI_TEST_WRITE_OBSERVER;
  if (observer) assert.equal(createHash('sha256').update(readFileSync(observer)).digest('hex'), process.env.KUBERNETES_AXI_TEST_WRITE_OBSERVER_SHA256, 'Use the verified write observer pin');
  const tracing = observer ? ['-f', '-yy', '-s', '65535', '-o', '|/bin/cat >&4', '-e', 'trace=%file,write,pwrite64,writev,pwritev,openat,rename,unlink', process.execPath] : [];
  const child = spawn(observer ?? process.execPath, [...tracing, cli, '--credential-fd', '3', ...args], { env: environment, stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  const streams: Buffer[][] = [[], [], [], []];
  for (const [index, fd] of [1, 2, 3, 4].entries()) (child.stdio[fd] as NodeJS.ReadableStream).on('data', (data: Buffer) => streams[index]!.push(data));
  const closed = once(child, 'close');
  started?.(() => {
    if (observer) {
      const children = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').trim().split(/\s+/);
      for (const pid of children) if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[1] === cli) process.kill(Number(pid), 'SIGTERM');
    } else child.kill('SIGTERM');
  });
  const [code] = await closed;
  const trace = Buffer.concat(streams[3]!).toString();
  let fileWrites = 0;
  if (observer) {
    assert.match(trace, /execve\(/, 'Native observer must cover the executed process tree');
    for (const line of trace.split('\n')) {
      if (/\b(?:write|pwrite64|writev|pwritev)\(\d+<\//.test(line)) {
        fileWrites++;
        for (const value of [canary, encodeURIComponent(canary), Buffer.from(canary).toString('base64')]) assert(!line.includes(value), 'Issued credential was written to a filesystem object');
      }
    }
    assert(fileWrites > 0, 'The observer must see the real configuration and outcome writes');
  }
  const stdout = Buffer.concat(streams[0]!).toString();
  const stderr = Buffer.concat(streams[1]!).toString();
  assert(!stdout.includes(canary) && !stderr.includes(canary), 'Public streams contain an issued credential');
  return { code, stdout, stderr, credential: Buffer.concat(streams[2]!).toString(), observation: observer ? { sha256: process.env.KUBERNETES_AXI_TEST_WRITE_OBSERVER_SHA256, fileWrites } : undefined };
}
