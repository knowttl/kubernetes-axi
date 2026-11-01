import { spawn } from 'node:child_process';
import { Failure } from './errors.js';
import type { Redactor } from './redaction.js';

export interface ByteExecution {
  input: Buffer;
  signal: AbortSignal;
  timeoutMs: number;
  // Control stdout is parsed privately into bounded metadata and never exposed
  // as caller bytes. It must not wait for the binary secret suffix buffer.
  controlStdout?: boolean;
  output: (channel: 'stdout' | 'stderr', bytes: Buffer) => Promise<void>;
}

export async function byteProcess(binary: string, args: string[], env: NodeJS.ProcessEnv,
  execution: ByteExecution, redactor: Redactor): Promise<number> {
  if (execution.signal.aborted) throw new Failure('CANCELLED', 'The session was cancelled.');
  const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let killTimer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const stop = (): void => {
    child.kill('SIGTERM');
    killTimer ??= setTimeout(() => { child.kill('SIGKILL'); }, 1000);
  };
  execution.signal.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => { timedOut = true; stop(); }, execution.timeoutMs);
  child.stdin.on('error', () => {});
  child.stdin.end(execution.input);
  const exit = new Promise<number>((resolve, reject) => {
    child.once('error', () => reject(new Failure('UPSTREAM_FAILED', 'The bounded process could not start.')));
    child.once('close', code => resolve(code ?? 1));
  });
  const channels = (['stdout', 'stderr'] as const).map(async channel => {
    const guard = redactor.byteStream();
    try {
      for await (const chunk of child[channel]) {
        const safe = channel === 'stdout' && execution.controlStdout ? Buffer.from(chunk) : guard.push(Buffer.from(chunk));
        if (safe.length) await execution.output(channel, safe);
      }
      const tail = guard.end();
      if (tail.length) await execution.output(channel, tail);
    } catch (error) {
      stop();
      if (error instanceof Failure) throw error;
      throw new Failure('CREDENTIAL_OUTPUT_REFUSED', 'Binary output was withheld or its consumer disconnected.');
    }
  });
  try {
    const outcomes = await Promise.allSettled([exit, ...channels]);
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    if (execution.signal.aborted) throw new Failure('CANCELLED', 'The session was cancelled.');
    if (timedOut) throw new Failure('UPSTREAM_TIMEOUT', 'The session reached its time limit.');
    return (outcomes[0] as PromiseFulfilledResult<number>).value;
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    execution.signal.removeEventListener('abort', stop);
  }
}
