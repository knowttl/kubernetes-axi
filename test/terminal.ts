import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';

// A real controlling Linux PTY. Only the test driver uses Python; the product
// uses util-linux script and the installed, digest-verified kubectl.
const driver = `import os, pty, sys, json, select, fcntl, termios, struct, signal
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
pid = os.fork()
if pid == 0:
 os.setsid()
 fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
 for fd in (0, 1, 2): os.dup2(slave, fd)
 os.close(master)
 os.close(slave)
 os.execv(sys.argv[1], sys.argv[1:])
os.close(slave)
def emit(value):
 print(json.dumps(value), flush=True)
try:
 pending = b''
 while True:
  ready, _, _ = select.select([master, 0], [], [])
  if master in ready:
   try: data = os.read(master, 65536)
   except OSError: break
   if not data: break
   emit({'output': data.hex()})
  if 0 in ready:
   data = os.read(0, 65536)
   if not data:
    try: os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError: pass
    break
   pending += data
   while b'\\n' in pending:
    line, pending = pending.split(b'\\n', 1)
    action = json.loads(line)
    if 'input' in action: os.write(master, bytes.fromhex(action['input']))
    if 'resize' in action:
     rows, cols = action['resize']
     fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    if 'signal' in action: os.kill(pid, getattr(signal, action['signal']))
 _, status = os.waitpid(pid, 0)
 emit({'exit': os.waitstatus_to_exitcode(status)})
finally:
 try: os.killpg(pid, signal.SIGKILL)
 except ProcessLookupError: pass
 os.close(master)
`;

export function terminal(args: string[], env: NodeJS.ProcessEnv): {
  output: () => string; waitFor: (text: string) => Promise<void>;
  send: (action: object) => void; closed: Promise<number>; close: () => void;
} {
  const child = spawn('python3', ['-c', driver, process.execPath, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const events = new EventEmitter();
  let pending = '';
  let output = '';
  let exit: number | undefined;
  child.stderr.on('data', bytes => { output += String(bytes); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (bytes: string) => {
    pending += bytes;
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      const message = JSON.parse(pending.slice(0, end)) as { output?: string; exit?: number };
      pending = pending.slice(end + 1);
      if (message.output) output += Buffer.from(message.output, 'hex').toString();
      if (message.exit !== undefined) exit = message.exit;
      events.emit('output');
    }
  });
  return {
    output: () => output,
    waitFor: async text => {
      const signal = AbortSignal.timeout(20000);
      try {
        while (!output.includes(text)) {
          if (exit !== undefined) throw new Error(`Terminal exited with ${exit}`);
          await once(events, 'output', { signal });
        }
      }
      catch (cause) { throw new Error(`Terminal did not produce ${text}: ${output}`, { cause }); }
    },
    send: action => child.stdin.write(JSON.stringify(action) + '\n'),
    closed: once(child, 'close', { signal: AbortSignal.timeout(30000) }).then(([code]) => { assert.equal(code, 0, output); assert.notEqual(exit, undefined, output); return exit!; }),
    close: () => child.stdin.end(),
  };
}
