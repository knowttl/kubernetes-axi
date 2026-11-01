import { Ajv } from 'ajv';
import { createHash } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { identity, validateEnvironment } from './credentials.js';
import { Failure } from './errors.js';
import { parse, type Invocation } from './grammar.js';
import { preview } from './mutations.js';
import { Redactor } from './redaction.js';
import { readCluster, type NativeOutput } from './runner.js';
import { readWorkspaceTar, relativeFile, workspaceTar } from './workspace-tar.js';

interface Message { action: 'start' | 'confirm'; args?: string[]; digest?: string; stdinBase64?: string; inputFile?: 'stdin.bin'; timeoutMs?: number }
const valid = new Ajv().compile<Message>({ type: 'object', additionalProperties: false, required: ['action'], properties: {
  action: { enum: ['start', 'confirm'] },
  args: { type: 'array', maxItems: 256, items: { type: 'string', maxLength: 8192 } },
  digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  stdinBase64: { type: 'string', maxLength: 4 * Math.ceil(100 * 1024 * 1024 / 3), pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' },
  inputFile: { const: 'stdin.bin' },
  timeoutMs: { type: 'integer', minimum: 1, maximum: 1800000 },
} });

// A host-owned IPC worker keeps preview state and injected identity in one
// private call directory. It has no network listener or ambient identity route.
if (!process.send) throw new Failure('PRIVATE_CHANNEL_REQUIRED', 'Launch bounded sessions through the authenticated host.');
const send = async (message: object): Promise<void> => new Promise((resolve, reject) => {
  if (!process.connected) { reject(new Failure('CANCELLED', 'The host disconnected.')); return; }
  process.send!(message, undefined, undefined, (error: Error | null) => error ? reject(error) : resolve());
});
const redactor = new Redactor();
const controller = new AbortController();
let busy = false;
let started = false;
let request: string | undefined;
let expectedDigest: string | undefined;
let input: Buffer = Buffer.alloc(0);
let timeoutMs = 300000;
let selection: Awaited<ReturnType<typeof identity>>;
let copying: 'upload' | 'download' | undefined;
let downloadPath = '';
let remoteName = '';
let forwarding = false;
let forwardingOutput = '';
const forwards = new Map<number, number>();
const artifact: Buffer[] = [];
let artifactBytes = 0;
const run = async (invocation: Invocation): Promise<void> => {
  await send({ event: 'running' });
  const output = await readCluster(selection, invocation, redactor, { input, signal: controller.signal, timeoutMs,
    ...(forwarding ? { controlStdout: true } : {}),
    output: async (channel, bytes) => {
      if (forwarding && channel === 'stdout') {
        forwardingOutput += bytes.toString('utf8');
        if (Buffer.byteLength(forwardingOutput) > 65536) throw new Failure('OUTPUT_LIMIT', 'Port forwarding diagnostics exceeded their bound.');
        let newline: number;
        while ((newline = forwardingOutput.indexOf('\n')) >= 0) {
          const line = forwardingOutput.slice(0, newline); forwardingOutput = forwardingOutput.slice(newline + 1);
          const match = /^Forwarding from 127\.0\.0\.1:([0-9]+) -> ([0-9]+)$/.exec(line);
          if (match) {
            forwards.set(Number(match[2]), Number(match[1]));
            await send({ event: 'ports', ports: [...forwards].map(([remote, local]) => ({ remote, local })) });
          }
        }
        return;
      }
      if (copying === 'download' && channel === 'stdout') {
        artifactBytes += bytes.length;
        if (artifactBytes > 250 * 1024 * 1024 + 102400) throw new Failure('TRANSFER_LIMIT', 'The artifact exceeds the workspace byte limit.');
        artifact.push(bytes);
      } else await send({ event: 'output', channel, base64: bytes.toString('base64') });
    },
  });
  const native = output as Partial<NativeOutput>;
  if (copying === 'download' && native.exitCode === 0) {
    const files = readWorkspaceTar(Buffer.concat(artifact));
    const manifest: { path: string; bytes: number; sha256: string }[] = [];
    for (const file of files) {
      if (file.path !== remoteName && !file.path.startsWith(remoteName + '/')) throw new Failure('PATH_REFUSED', 'The archive does not match the selected container path.');
      const name = downloadPath + file.path.slice(remoteName.length);
      const path = join(process.env.TMPDIR!, 'artifacts', name);
      await mkdir(posix.dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, file.bytes, { mode: 0o600, flag: 'wx' });
      manifest.push({ path: name, bytes: file.bytes.length, sha256: createHash('sha256').update(file.bytes).digest('hex') });
    }
    await send({ event: 'artifacts', files: manifest });
  }
  if (!native.native) await send({ event: 'result', value: redactor.value(output) });
  await send({ event: 'exit', exitCode: native.exitCode ?? Number(process.exitCode ?? 0), stdoutEOF: true, stderrEOF: true });
  process.disconnect();
};
process.on('disconnect', () => { controller.abort(); });
process.on('SIGTERM', () => { controller.abort(); });
process.on('SIGINT', () => { controller.abort(); });
process.on('message', (raw: unknown) => {
  void (async () => {
    if (!valid(raw)) throw new Failure('USAGE', 'The session message is invalid.', 2);
    if (busy) throw new Failure('USAGE', 'Wait for the current session operation.', 2);
    busy = true;
    if (raw.action === 'start') {
      if (started || !raw.args) throw new Failure('USAGE', 'Start a session once with ordered arguments.', 2);
      started = true;
      validateEnvironment();
      timeoutMs = raw.timeoutMs ?? timeoutMs;
      input = Buffer.from(raw.stdinBase64 ?? '', 'base64');
      if (raw.inputFile) {
        if (raw.stdinBase64 !== undefined) throw new Failure('USAGE', 'Select one session input channel.', 2);
        const file = await open(join(process.env.TMPDIR!, raw.inputFile), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size > 100 * 1024 * 1024) throw new Failure('TRANSFER_LIMIT', 'The input artifact exceeds the regular-file limit.');
          input = await file.readFile();
        } finally { await file.close(); }
      }
      let args = raw.args;
      if (args[0] === 'prepare' && args[1] === '--' && args[2] === 'cp') {
        const cp = args.slice(3);
        if (cp.length !== 2) throw new Failure('USAGE', 'Use cp <workspace-path> <pod:/absolute-path> or cp <pod:/absolute-path> <workspace-path>.', 2);
        const from = cp[0]!; const to = cp[1]!;
        const remote = /^(?:([a-z0-9][a-z0-9.-]*)\/)?([a-z0-9][a-z0-9.-]*):\/(.+)$/;
        const source = remote.exec(from); const destination = remote.exec(to);
        if (Boolean(source) === Boolean(destination)) throw new Failure('USAGE', 'Copy between one workspace path and one named container path.', 2);
        const selected = source ?? destination!;
        const path = relativeFile(selected[3]!);
        copying = source ? 'download' : 'upload';
        const workspace = join(process.env.TMPDIR!, 'workspace');
        const local = source && to.startsWith('artifact:') ? to.slice('artifact:'.length) : relative(workspace, source ? to : from).split(posix.sep).join('/');
        relativeFile(local);
        remoteName = posix.basename(path);
        downloadPath = local;
        if (copying === 'upload') input = await workspaceTar(workspace, local, remoteName);
        else if (input.length) throw new Failure('USAGE', 'A copy download accepts no stdin.', 2);
        args = ['prepare', '--', 'exec', selected[2]!, ...(selected[1] ? ['--namespace', selected[1]] : []), ...(copying === 'upload' ? ['-i'] : []), '--', 'tar', copying === 'upload' ? 'xf' : 'cf', '-', '-C', '/' + posix.dirname(path), ...(copying === 'download' ? ['--', posix.basename(path)] : [])];
      }
      const invocation = parse(args, true);
      forwarding = invocation.command.path === 'port-forward';
      if (input.length) invocation.inputSha256 = createHash('sha256').update(input).digest('hex');
      if (invocation.nativeConfig || invocation.trustExec || invocation.config || invocation.profile || invocation.help) throw new Failure('USAGE', 'Sessions use only the host-selected profile.', 2);
      if (!['exec', 'attach', 'logs', 'get', 'port-forward'].includes(invocation.command.path) && invocation.command.effect !== 'clusterWrite') throw new Failure('CAPABILITY_UNAVAILABLE', 'This command is outside the bounded session contract.');
      selection = await identity();
      redactor.register(selection.secret, selection.profile.clientCertificate);
      if (invocation.workflow?.kind === 'prepare') {
        const prepared = await readCluster(selection, invocation, redactor, { input, signal: controller.signal,
          timeoutMs: 15000, output: async () => {},
        }) as { request: string };
        request = prepared.request;
        const displayed = await preview(parse(['preview', request]));
        expectedDigest = (displayed as { digest: string }).digest;
        await send({ event: 'prepared', preview: redactor.value(displayed) });
      } else {
        if (invocation.workflow) throw new Failure('USAGE', 'Start with prepare or a bounded read.', 2);
        invocation.native = true;
        await run(invocation);
      }
    } else {
      if (!request || !raw.digest || raw.digest !== expectedDigest) throw new Failure('PREVIEW_MISMATCH', 'Confirm the exact session preview digest.');
      const invocation = parse(['confirm', request, '--digest', raw.digest]);
      request = undefined;
      await run(invocation);
    }
    busy = false;
  })().catch(async (error: unknown) => {
    controller.abort();
    const failure = error instanceof Failure ? error : new Failure('UPSTREAM_FAILED', 'The bounded session failed.');
    if (process.connected) {
      await send({ event: 'failed', code: failure.code, message: failure.message }).catch(() => {});
      if (process.connected) process.disconnect();
    }
    process.exitCode = 1;
  });
});
