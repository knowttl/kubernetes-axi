import { encode } from '@toon-format/toon';
import { identity } from './credentials.js';
import { Failure } from './errors.js';
import { readCluster } from './runner.js';
import type { NativeOutput } from './runner.js';
import { parse, commandHelp } from './grammar.js';
import { guidance } from './metadata-pin.js';

const help = {
  description: guidance,
  commands: ['version', 'get <resource> [name]', 'api-versions', 'api-resources', 'logs <pod>', 'top node', 'top pod', 'describe <resource> <name>', 'explain <resource>', 'native -- <arguments>'],
  flags: ['--config <absolute-path>', '--profile <name>', '--namespace <name>', '--help'],
  examples: ['kubernetes-axi version --profile <name>', 'kubernetes-axi get pods --profile <name> --namespace <namespace>'],
};

export async function main(args: string[]): Promise<void> {
  let secret = '';
  let native = false;
  let json = false;
  const output = (value: object): void => {
    const redact = (data: unknown): unknown => {
      if (typeof data === 'string') {
        let text = data;
        if (secret) {
          for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString('base64')])) {
            text = text.split(form).join('[REDACTED]');
          }
        }
        return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
          .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]');
      }
      if (Array.isArray(data)) return data.map(redact);
      if (data !== null && typeof data === 'object') {
        return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, redact(value)]));
      }
      return data;
    };
    if ('native' in value && value.native === true) {
      const result = value as NativeOutput;
      process.stdout.write(redact(result.stdout) as string);
      process.stderr.write(redact(result.stderr) as string);
      process.exitCode = result.exitCode;
    } else process.stdout.write(`${json ? JSON.stringify(redact(value)) : encode(redact(value))}\n`);
  };
  try {
    if (args.length === 1 && args[0] === '--help') {
      output(help);
      return;
    }
    const invocation = parse(args);
    native = invocation.native;
    json = invocation.flags.get('output') === 'json';
    if (invocation.help) { output(commandHelp(invocation.command)); return; }
    const selected = await identity(invocation.config, invocation.profile);
    secret = selected.secret;
    output(await readCluster(selected, invocation));
  } catch (error) {
    const failure = error instanceof Failure ? error : new Failure('CONFIG_INVALID', 'Check the selected profile, protected files and installed package.');
    output({ error: { code: failure.code, message: failure.message, ...failure.details }, ...(native ? { native: false } : {}) });
    process.exitCode = failure.exitCode;
  }
}
