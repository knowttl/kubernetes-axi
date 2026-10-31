import { encode } from '@toon-format/toon';
import { identity, configPath, profiles, validateEnvironment } from './credentials.js';
import { Failure } from './errors.js';
import { readCluster } from './runner.js';
import type { NativeOutput } from './runner.js';
import { parse, commandHelp } from './grammar.js';
import { guidance } from './metadata-pin.js';
import { Redactor } from './redaction.js';

const help = {
  description: guidance,
  commands: ['version', 'get <resource> [name]', 'api-versions', 'api-resources', 'logs <pod>', 'top node', 'top pod', 'describe <resource> <name>', 'explain <resource>', 'auth status', 'profile list', 'config path', 'doctor', 'native -- <arguments>'],
  flags: ['--config <absolute-path>', '--profile <name>', '--namespace <name>', '--native-config <absolute-path|ambient>', '--trust-exec', '--help'],
  examples: ['kubernetes-axi version --profile <name>', 'kubernetes-axi get pods --profile <name> --namespace <namespace>'],
};

export async function main(args: string[]): Promise<void> {
  const redactor = new Redactor();
  let native = false;
  let json = false;
  const output = (value: object): void => {
    if ('native' in value && value.native === true) {
      const result = value as NativeOutput;
      process.stdout.write(redactor.text(result.stdout));
      process.stderr.write(redactor.text(result.stderr));
      process.exitCode = result.exitCode;
    } else process.stdout.write(`${json ? JSON.stringify(redactor.value(value)) : encode(redactor.value(value))}\n`);
  };
  try {
    if (args.length === 1 && args[0] === '--help') {
      output(help);
      return;
    }
    const invocation = parse(args);
    validateEnvironment();
    native = invocation.native;
    json = invocation.flags.get('output') === 'json';
    if (invocation.help) { output(commandHelp(invocation.command)); return; }
    if (invocation.command.path === 'config path') { output({ path: configPath(invocation.config) }); return; }
    if (invocation.command.path === 'profile list') {
      const config = await profiles(invocation.config);
      output({ profiles: Object.keys(config.profiles).map(name => ({ name, default: name === config.defaultProfile })) });
      return;
    }
    const selected = invocation.nativeConfig ? undefined : await identity(invocation.config, invocation.profile, ['auth status', 'doctor'].includes(invocation.command.path));
    redactor.register(selected?.secret, selected?.profile.clientCertificate);
    if (selected && ['auth status', 'doctor'].includes(invocation.command.path)) {
      output({ source: selected.source, origin: selected.profile.origin, auth: selected.profile.auth, secretSource: selected.profile.token ?? selected.profile.privateKey ?? { env: `KUBERNETES_AXI_${selected.profile.auth === 'token' ? 'TOKEN' : 'PRIVATE_KEY'}` }, permissions: 'verified' });
      return;
    }
    output(await readCluster(selected, invocation, redactor));
  } catch (error) {
    const failure = error instanceof Failure ? error : new Failure('CONFIG_INVALID', 'Check the selected profile, protected files and installed package.');
    output({ error: { code: failure.code, message: failure.message, ...failure.details }, ...(native ? { native: false } : {}) });
    process.exitCode = failure.exitCode;
  }
}
