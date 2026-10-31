import { encode } from '@toon-format/toon';
import { identity } from './credentials.js';
import { Failure } from './errors.js';
import { readCluster } from './runner.js';

const help = {
  description: 'Read Kubernetes server version or compact pods with isolated credentials and pinned kubectl.',
  commands: ['kubernetes-axi version', 'kubernetes-axi get pods'],
  flags: ['--config <absolute-path>', '--profile <name>', '--namespace <name> (get pods)', '--help'],
  examples: ['kubernetes-axi version --profile <name>', 'kubernetes-axi get pods --profile <name> --namespace <namespace>'],
};

export async function main(args: string[]): Promise<void> {
  let secret = '';
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
    process.stdout.write(`${encode(redact(value))}\n`);
  };
  try {
    if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
      output(help);
      return;
    }
    const flags = new Map<string, string>();
    const valid = ['--config', '--profile', '--namespace'];
    const positionals: string[] = [];
    let wantsHelp = false;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === '--help') { wantsHelp = true; continue; }
      if (!arg.startsWith('-')) { positionals.push(arg); continue; }
      const [flag, ...parts] = arg.split('=');
      if (!valid.includes(flag!)) {
        const label = /^--[a-zA-Z][a-zA-Z-]*$/.test(flag!) ? ` ${flag}` : '';
        throw new Failure('USAGE', `Unknown argument${label}. Valid flags: ${valid.join(', ')}, --help. Secret argv is prohibited.`, 2);
      }
      if (flags.has(flag!)) throw new Failure('USAGE', 'Supply each flag once.', 2);
      const value = parts.length ? parts.join('=') : args[++index];
      if (!value || value.startsWith('--')) throw new Failure('USAGE', 'Each selection flag requires a value; run kubernetes-axi --help.', 2);
      flags.set(flag!, value);
    }
    const command = positionals.join(' ');
    const operation = command === 'version' ? 'version' : command === 'get pods' ? 'pods' : undefined;
    if (!operation) throw new Failure('USAGE', 'Use kubernetes-axi version or kubernetes-axi get pods; --help lists the supported B1.1 surface.', 2);
    if (operation === 'version' && flags.has('--namespace')) throw new Failure('USAGE', 'Valid flags for version: --config, --profile, --help.', 2);
    if (wantsHelp) { output(help); return; }
    const namespace = flags.get('--namespace');
    if (namespace && (namespace.length > 63 || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(namespace))) {
      throw new Failure('USAGE', 'Use a valid Kubernetes namespace.', 2);
    }
    const selected = await identity(flags.get('--config'), flags.get('--profile'));
    secret = selected.secret;
    output(await readCluster(selected, operation, namespace));
  } catch (error) {
    const failure = error instanceof Failure ? error : new Failure('CONFIG_INVALID', 'Check the selected profile, protected files and installed package.');
    output({ error: { code: failure.code, message: failure.message } });
    process.exitCode = failure.exitCode;
  }
}
