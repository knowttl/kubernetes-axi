import { spawn } from 'node:child_process';
import { Failure } from './errors.js';
import type { Redactor } from './redaction.js';

export function localTerminal(): boolean {
  return process.platform === 'linux' && Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// script supplies kubectl with a real PTY for raw input and resize monitoring.
// Its transcript is disabled; all public bytes still pass through the redactor.
export async function terminalProcess(binary: string, args: string[], env: NodeJS.ProcessEnv,
  signal: AbortSignal, redactor: Redactor): Promise<number> {
  if (!localTerminal()) throw new Failure('LOCAL_TERMINAL_REQUIRED', 'Run this request in a local Linux terminal. Native Windows terminal support is pending.');
  if (signal.aborted) throw new Failure('CANCELLED', 'The terminal session was cancelled.');
  const command = [binary, ...args].map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
  const child = spawn('/usr/bin/script', ['--quiet', '--return', '--flush', '--command', `exec ${command}`, '/dev/null'], {
    env, detached: true, stdio: ['inherit', 'pipe', 'pipe'],
  });
  const resize = (): void => { child.kill('SIGWINCH'); };
  const cancel = (): void => { child.kill('SIGTERM'); };
  process.on('SIGWINCH', resize);
  signal.addEventListener('abort', cancel, { once: true });
  const exit = new Promise<number>((resolve, reject) => {
    child.once('error', () => reject(new Failure('LOCAL_TERMINAL_UNAVAILABLE', 'Install util-linux script at /usr/bin/script for local Linux terminal sessions.')));
    child.once('close', code => resolve(code ?? 1));
  });
  const channels = (['stdout', 'stderr'] as const).map(async channel => {
    const guard = redactor.terminalStream();
    try {
      for await (const chunk of child[channel]) {
        const safe = guard.push(Buffer.from(chunk));
        if (safe.length) await new Promise<void>((resolve, reject) => process[channel].write(safe, error => error ? reject(error) : resolve()));
      }
      const tail = guard.end();
      if (tail.length) await new Promise<void>((resolve, reject) => process[channel].write(tail, error => error ? reject(error) : resolve()));
    } catch {
      cancel();
      throw new Failure('CREDENTIAL_OUTPUT_REFUSED', 'The terminal output consumer disconnected.');
    }
  });
  try {
    const outcomes = await Promise.allSettled([exit, ...channels]);
    const failure = outcomes.find(outcome => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return signal.aborted ? signal.reason === 'SIGTERM' ? 143 : signal.reason === 'SIGHUP' ? 129 : 130 : (outcomes[0] as PromiseFulfilledResult<number>).value;
  } finally {
    cancel();
    process.removeListener('SIGWINCH', resize);
    signal.removeEventListener('abort', cancel);
  }
}
