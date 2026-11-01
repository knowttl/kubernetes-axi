import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Failure } from './errors.js';
import { metadataSha256, executionLimit } from './metadata-pin.js';
import { routeEffect } from './route-policy.js';

export interface Flag { name: string; short: string; type: string; default: string; noOpt: string; usage: string; effect: string }
export interface Command { path: string; aliases: string[]; flags: Flag[]; use: string; description: string; effect: string; operations?: string[]; compatibilityLimit?: string }
const bytes = await readFile(new URL('../command-metadata.json', import.meta.url));
export const metadata = JSON.parse(bytes.toString()) as { version: string; commands: Command[] };

export interface Invocation {
  session?: boolean;
  inputSha256?: string;
  workflow?: { kind: 'prepare' | 'server-dry-run' } | { kind: 'preview' | 'confirm'; key: string; digest: string };
  native: boolean;
  config?: string;
  profile?: string;
  nativeConfig?: string;
  trustExec: boolean;
  credentialFd?: number;
  command: Command;
  argv: string[];
  positionals: string[];
  flags: Map<string, string>;
  help: boolean;
  home: boolean;
  versionProbe?: true;
}

const compactFlags: Record<string, string[]> = {
  '': ['namespace'], version: [], get: ['namespace', 'all-namespaces', 'selector', 'field-selector', 'output', 'continue'],
  'api-versions': [], 'api-resources': [],
  'top node': ['namespace', 'selector'], 'top pod': ['namespace', 'all-namespaces', 'selector'],
};

export function parse(args: string[], session = false): Invocation {
  if (createHash('sha256').update(bytes).digest('hex') !== metadataSha256 || metadata.version !== 'v1.32.2') {
    throw new Failure('METADATA_STALE', 'Rebuild reviewed command metadata for the installed kubectl pin.');
  }
  const own: { config?: string; profile?: string; nativeConfig?: string; trustExec: boolean; credentialFd?: number } = { trustExec: false };
  const argv: string[] = [];
  let native = session;
  let workflow: Invocation['workflow'];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--credential-fd' || arg.startsWith('--credential-fd=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++index] ?? '';
      if (!/^(?:[3-9]|[1-9][0-9]+)$/.test(value) || own.credentialFd !== undefined) throw new Failure('USAGE', 'Supply --credential-fd once with an inherited private pipe descriptor of at least 3.', 2);
      own.credentialFd = Number(value);
      continue;
    }
    if (argv.length === 0 && ['prepare', 'preview', 'confirm', 'server-dry-run'].includes(arg) && args[index + 1] === '--help' && index + 2 === args.length) {
      const uses: Record<string, string> = { prepare: 'prepare -- <Kubernetes mutation>', preview: 'preview <request-key>', confirm: 'confirm <request-key> --digest <preview-digest>', 'server-dry-run': 'server-dry-run -- <Kubernetes mutation>' };
      return { ...own, native: false, command: { path: arg, aliases: [], flags: [], use: uses[arg]!, description: 'Prepare frozen targets, preview them offline, confirm their exact digest, or explicitly request server dry run.', effect: arg === 'preview' ? 'localRead' : 'clusterWrite' }, argv: [], positionals: [], flags: new Map(), help: true, home: false };
    }
    if (argv.length === 0 && ['prepare', 'server-dry-run'].includes(arg)) {
      if (args[index + 1] !== '--') throw new Failure('USAGE', `Use ${arg} -- <Kubernetes command and arguments>.`, 2);
      workflow = { kind: arg as 'prepare' | 'server-dry-run' };
      argv.push(...args.slice(index + 2));
      break;
    }
    if (argv.length === 0 && ['preview', 'confirm'].includes(arg)) {
      const key = args[index + 1] ?? '';
      const tail = args.slice(index + 2);
      if (!/^[a-f0-9-]{36}$/.test(key) || (arg === 'preview' ? tail.length !== 0 : tail.length !== 2 || tail[0] !== '--digest' || !/^[a-f0-9]{64}$/.test(tail[1] ?? ''))) throw new Failure('USAGE', 'Use preview <request-key> or confirm <request-key> --digest <preview-digest>.', 2);
      workflow = { kind: arg as 'preview' | 'confirm', key, digest: tail[1] ?? '' };
      validateSelection(own);
      return { ...own, native: false, workflow, command: { path: arg, aliases: [], flags: [], use: arg, description: 'Inspect or confirm a frozen request.', effect: arg === 'preview' ? 'localRead' : 'clusterWrite' }, argv: [], positionals: [], flags: new Map(), help: false, home: false };
    }
    if (arg === 'native' && argv.length === 0) {
      if (args[index + 1] !== '--') throw new Failure('USAGE', 'Use kubernetes-axi [--profile <name>] native -- <kubectl arguments>.', 2);
      native = true;
      argv.push(...args.slice(index + 2));
      break;
    }
    if (arg === '--') { argv.push(...args.slice(index)); break; }
    const [name, ...valueParts] = arg.split('=');
    if (arg === '--trust-exec') { own.trustExec = true; continue; }
    if (name === '--config' || name === '--profile' || name === '--native-config') {
      const value = valueParts.length ? valueParts.join('=') : args[++index];
      if (!value || value.startsWith('-')) throw new Failure('USAGE', `${name} requires a value.`, 2);
      const key = name === '--config' ? 'config' : name === '--profile' ? 'profile' : 'nativeConfig';
      if (own[key] !== undefined) throw new Failure('USAGE', `Supply ${name} once.`, 2);
      own[key] = value;
    } else argv.push(arg);
  }
  if (own.credentialFd !== undefined) throw new Failure('USAGE', '--credential-fd is only available before confirm.', 2);
  const versionProbe = !native && !workflow && argv.length === 1 && ['--version', '-v', '-V'].includes(argv[0]!);
  if (versionProbe) argv.splice(0, 1, 'version');
  const localCommand = argv.filter(arg => !['--help', '-h'].includes(arg)).join(' ');
  if (['auth status', 'profile list', 'config path', 'doctor'].includes(localCommand)) {
    validateSelection(own);
    if (own.nativeConfig && localCommand === 'profile list') throw new Failure('USAGE', 'Profiles belong to standard configuration. Omit --native-config to list profiles; use doctor with --native-config to inspect the selected native identity.', 2);
    return { native: false, ...own, command: { path: localCommand, aliases: [], flags: ['config', 'profile', 'help'].map(name => ({ name, short: '', type: name === 'help' ? 'bool' : 'string', default: '', noOpt: name === 'help' ? 'true' : '', usage: '', effect: 'argument' })), use: localCommand, description: 'Inspect standard credential configuration without a cluster request.', effect: 'localRead' }, argv, positionals: [], flags: new Map(), help: argv.some(arg => ['--help', '-h'].includes(arg)), home: false };
  }
  // Resolve the longest command path while respecting values of inherited flags.
  let command = metadata.commands.find(item => item.path === '')!;
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const tokens = [...argv];
  let ended = false;
  for (let index = 0; index < tokens.length; index++) {
    const arg = tokens[index]!;
    if (arg === '--') { ended = true; continue; }
    if (ended || !arg.startsWith('-') || arg === '-') {
      const child = !ended && positionals.length === 0 ? metadata.commands.find(item => {
        const words = item.path.split(' ');
        const parent = words.slice(0, -1).join(' ');
        return item.path !== '' && parent === command.path && (words.at(-1) === arg || item.aliases.includes(arg));
      }) : undefined;
      if (child) command = child;
      else positionals.push(arg);
      continue;
    }
    const long = arg.startsWith('--');
    const name = long ? arg.slice(2).split('=')[0]! : arg.slice(1, 2);
    // Command flags may precede their command, as Cobra permits inherited options.
    const flag = !native && command.path === 'get' && long && name === 'continue'
      ? { name: 'continue', short: '', type: 'string', default: '', noOpt: '', usage: 'Continue the same bounded list with its opaque token.', effect: 'argument' }
      : command.flags.find(flag => long ? flag.name === name : flag.short === name);
    if (!flag) {
      const valid = !native && Object.hasOwn(compactFlags, command.path) ? compactFlags[command.path]! : command.flags.filter(flag => ['argument', 'presentation'].includes(flag.effect)).map(flag => flag.name);
      throw new Failure('USAGE', `Unknown flag ${long ? `--${name}` : `-${name}`} for ${command.path || 'kubernetes-axi'}. Valid flags: ${[...new Set([...valid, 'help'])].map(name => `--${name}`).join(', ')}.`, 2);
    }
    let value = long ? (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined) : arg.slice(2).replace(/^=/, '') || undefined;
    if (!long && flag.type === 'bool' && arg.length > 2 && arg[2] !== '=') {
      tokens.splice(index + 1, 0, `-${arg.slice(2)}`);
      value = flag.noOpt;
    }
    if (value === undefined) value = flag.noOpt || tokens[++index];
    if (value === undefined || (!flag.noOpt && value.startsWith('--'))) throw new Failure('USAGE', `--${flag.name} requires a ${flag.type} value.`, 2);
    if (flag.type === 'bool' && !/^(true|false|1|0|t|f|TRUE|FALSE|True|False|T|F)$/.test(value)) throw new Failure('USAGE', `--${flag.name} requires a boolean.`, 2);
    if (/^u?int(32|64)?$/.test(flag.type) && !/^-?\d+$/.test(value)) throw new Failure('USAGE', `--${flag.name} requires an integer.`, 2);
    if (session && (flag.effect === 'fileRead' || flag.name === 'kustomize')) {
      const workspace = join(process.env.TMPDIR ?? '', 'workspace');
      for (const path of value.split(',')) {
        const selected = relative(workspace, resolve(path));
        if (path !== '-' && (!process.env.TMPDIR || selected.startsWith('..') || isAbsolute(selected))) throw new Failure('WORKSPACE_REQUIRED', 'Session file inputs must come from the owned workspace.');
      }
    }
    flags.set(flag.name, flag.type === 'bool' ? (/^(true|1|t)$/i.test(value) ? 'true' : 'false') : value);
  }
  const help = flags.get('help') === 'true' || command.path === 'help';
  if (command.path === '' && positionals.length) throw new Failure('USAGE', 'Unknown command. Run kubernetes-axi --help.', 2);
  if (!command.effect) throw new Failure('EFFECT_UNCLASSIFIED', 'The command has no reviewed effect classification.');
  if (!help) {
    if (['exec', 'attach', 'debug'].includes(command.path) && (flags.get('tty') === 'true' || !session && flags.get('stdin') === 'true') || command.path === 'debug' && flags.get('attach') !== 'false' || !session && command.path === 'port-forward') throw new Failure('LOCAL_TERMINAL_REQUIRED', executionLimit);
    const guarded = ['exec', 'attach', 'create token', ...(session ? ['port-forward'] : [])].includes(command.path);
    if (flags.has('raw')) {
      const effect = routeEffect(command.path === 'get' ? 'GET' : command.path === 'delete' ? 'DELETE' : command.path === 'replace' ? 'PUT' : 'POST', flags.get('raw')!);
      if (effect !== 'read') requireWrites();
      if (!['read', 'clusterWrite'].includes(effect)) throw new Failure('CAPABILITY_UNAVAILABLE', `Raw ${effect} routes require the corresponding explicit guarded command.`);
      if (/\/secrets(?:\/|\?|$)/.test(flags.get('raw')!)) throw new Failure('CREDENTIAL_OUTPUT_REFUSED', 'Use compact get secrets for metadata.');
    }
    if (guarded) {
      requireWrites();
      if (!workflow || workflow.kind !== 'prepare') throw new Failure('PREVIEW_REQUIRED', 'Use prepare -- <command>, preview <request-key>, then confirm <request-key> --digest <digest>.');
      if (command.path === 'create token' && !/^(true|1)$/i.test(process.env.KUBERNETES_AXI_ACQUIRE_CREDENTIAL ?? '')) throw new Failure('CAPABILITY_UNAVAILABLE', 'Token issuance requires KUBERNETES_AXI_ACQUIRE_CREDENTIAL=true and a private delivery pipe on confirmation.');
    }
    if (native && ['get', 'describe'].includes(command.path) && positionals.some((value, index) => (index === 0 || value.includes('/')) && value.split(',').some(resource => /^secrets?(?:$|[/.])/i.test(resource)))) throw new Failure('CREDENTIAL_OUTPUT_REFUSED', 'Use compact get secrets for metadata; public native Secret output is unavailable.');
    if (own.nativeConfig && ['config set', 'config set-credentials', 'config view'].includes(command.path)) throw new Failure('USAGE', 'Raw native credential inspection and credential argv writes are unavailable.', 2);
    if (command.compatibilityLimit) throw new Failure('NOT_YET_SUPPORTED_STAGED', command.compatibilityLimit);
    for (const flag of command.flags) {
      if (!session && flag.effect === 'stream' && (flags.get(flag.name) ?? flag.default) !== 'false') throw new Failure('USAGE', `--${flag.name} must be false in standalone mode. ${executionLimit}`, 2);
    }
    for (const name of flags.keys()) {
      if (!native && command.path === 'get' && name === 'continue') continue;
      const flag = command.flags.find(flag => flag.name === name)!;
      if (!flag.effect) throw new Failure('EFFECT_UNCLASSIFIED', 'The flag has no reviewed effect classification.');
      if (flag.effect === 'stream') continue;
      const writeInput = workflow && ['prepare', 'server-dry-run'].includes(workflow.kind) && (flag.effect === 'fileRead' && ['filename', 'patch-file'].includes(flag.name) || session && flag.name === 'kustomize' || flag.effect === 'clusterWrite' && (['dry-run', 'server-side', 'force-conflicts', 'force', 'prune', 'prune-allowlist'].includes(flag.name) || command.path === 'debug' && flag.name === 'profile'));
      const boundedExecution = (guarded || command.path === 'debug') && ['stdin', 'tty', 'attach'].includes(name) && (flags.get(name) === 'false' || session && name === 'stdin');
      const raw = name === 'raw' && (command.path === 'get' || Boolean(workflow) && command.effect === 'clusterWrite');
      if (!(own.nativeConfig && flag.name === 'context') && !raw && !writeInput && !boundedExecution && !['argument', 'presentation'].includes(flag.effect)) throw new Failure('USAGE', `--${flag.name} is unavailable under the isolated bounded-read policy (${flag.effect}).`, 2);
      if (flag.name === 'output' && /file[=\s]|template-file/.test(flags.get(flag.name)!)) throw new Failure('USAGE', 'File templates require a later local-file capability.', 2);
    }
    if (command.effect === 'clusterWrite') {
      requireWrites();
      if (!workflow) throw new Failure('PREVIEW_REQUIRED', 'Use prepare -- <command>, preview <request-key>, then confirm <request-key> --digest <digest>.');
      if (flags.has('dry-run')) throw new Failure('USAGE', 'Use server-dry-run -- <command> for server validation, or prepare -- <command> for a frozen request.', 2);
    } else if (workflow && !guarded) throw new Failure('USAGE', 'Preparation and server dry run require a resource mutation command.', 2);
    if (!(own.nativeConfig && native && command.path.startsWith('config ')) && !(native && command.path === 'plugin list') && !guarded && !['read', 'local', 'clusterWrite', 'authorization'].includes(command.effect)) throw new Failure('CAPABILITY_UNAVAILABLE', `${command.path} is unavailable in 0.1.x. Run it outside kubernetes-axi.`);
    if (['wait', 'events'].includes(command.path)) throw new Failure('CAPABILITY_UNAVAILABLE', 'Bounded event reads use get events; wait and streaming sessions require a later capability.');
    if (!native) {
      if (Object.hasOwn(compactFlags, command.path)) {
        for (const name of flags.keys()) if (!compactFlags[command.path]!.includes(name)) throw new Failure('USAGE', `--${name} requires native -- ${command.path} for upstream semantics.`, 2);
      } else if (!guarded && !['logs', 'describe', 'explain', 'rollout history', 'rollout status'].includes(command.path) && !['clusterWrite', 'authorization'].includes(command.effect)) throw new Failure('CAPABILITY_UNAVAILABLE', 'Use native -- for this upstream read.');
      const maxArgs = command.path === 'get' ? 2 : command.path.startsWith('top ') ? 1 : command.path === '' || command.path === 'version' || command.path.startsWith('api-') ? 0 : undefined;
      if (maxArgs !== undefined && (positionals.length > maxArgs || (command.path === 'get' && positionals.length === 0))) throw new Failure('USAGE', 'Supply one resource type and at most one resource name.', 2);
      if (command.path === 'get' && flags.has('output') && flags.get('output') !== 'json') throw new Failure('USAGE', 'Compact reads support -o json; use native -- for other output formats.', 2);
      if (command.path === 'get' && (positionals[0] === 'all' || /[,/]/.test(positionals[0]!))) throw new Failure('USAGE', 'Compact get requires one resource type and a separate optional name: get <type> [name]. Use native -- get for TYPE/NAME, comma lists or all.', 2);
      if (command.path === 'get' && flags.has('continue') && (positionals.length !== 1 || !flags.get('continue'))) throw new Failure('USAGE', '--continue requires a nonempty token and a list without a resource name. Keep the original namespace and selectors.', 2);
    }
  }
  validateSelection(own);
  return { native, ...own, ...(session ? { session } : {}), ...(versionProbe ? { versionProbe: true } : {}), ...(workflow ? { workflow } : {}), command, argv, positionals, flags, help, home: command.path === '' && positionals.length === 0 };
}

function validateSelection(own: { config?: string; profile?: string; nativeConfig?: string; trustExec: boolean }): void {
  if (own.trustExec && !own.nativeConfig) throw new Failure('USAGE', '--trust-exec requires --native-config.', 2);
  if (own.nativeConfig && own.nativeConfig !== 'ambient' && !isAbsolute(own.nativeConfig)) throw new Failure('CONFIG_INVALID', 'Select an absolute native kubeconfig path or ambient.');
  if (own.nativeConfig && (own.config || own.profile || ['CONFIG', 'PROFILE', 'ORIGIN', 'AUTH', 'NAMESPACE', 'CERTIFICATE_AUTHORITY', 'TOKEN', 'CLIENT_CERTIFICATE', 'PRIVATE_KEY'].some(field => process.env[`KUBERNETES_AXI_${field}`] !== undefined))) throw new Failure('CONFIG_INVALID', 'Native selection cannot override a standard or hosted profile.');
}

export function requireWrites(): void {
  if (!/^(false|0)$/i.test(process.env.KUBERNETES_AXI_READ_ONLY ?? '')) throw new Failure('READ_ONLY', 'Writes require KUBERNETES_AXI_READ_ONLY=false and explicit confirmation.');
}

export function clientOnly(invocation: Invocation): boolean {
  return invocation.native && (['completion', 'options', 'plugin list'].includes(invocation.command.path) || invocation.command.path === 'version' && invocation.flags.get('client') === 'true');
}

export function commandHelp(command: Command): object {
  return {
    command: command.path || 'kubernetes-axi', description: command.description,
    usage: command.use, effect: command.effect,
    ...(['exec', 'attach', 'debug', 'get', 'logs', 'port-forward'].includes(command.path) ? { capabilityBoundary: executionLimit } : {}),
    ...(command.operations ? { operations: command.operations } : {}),
    ...(command.compatibilityLimit ? { compatibilityLimit: command.compatibilityLimit } : {}),
    flags: [...command.flags.map(flag => ({ name: `--${flag.name}`, short: flag.short ? `-${flag.short}` : '', type: flag.type, default: flag.default })), ...(command.path === 'get' ? [{ name: '--continue', short: '', type: 'string (compact lists only)', default: '' }] : [])],
    examples: ['prepare', 'preview', 'confirm', 'server-dry-run'].includes(command.path) ?
      ['kubernetes-axi --profile <name> prepare -- patch deployment <name> --type=merge -p \'{"spec":{"replicas":3}}\'', 'kubernetes-axi --profile <name> preview <request-key>', 'kubernetes-axi --profile <name> confirm <request-key> --digest <preview-digest>'] :
      ['kubernetes-axi --profile <name> get pods -n <namespace>', 'kubernetes-axi --profile <name> native -- get pods -n <namespace> -o json'],
  };
}
