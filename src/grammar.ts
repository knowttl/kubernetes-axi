import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Failure } from './errors.js';
import { metadataSha256 } from './metadata-pin.js';

export interface Flag { name: string; short: string; type: string; default: string; noOpt: string; usage: string; effect: string }
export interface Command { path: string; aliases: string[]; flags: Flag[]; use: string; description: string; effect: string; compatibilityLimit?: string }
const bytes = await readFile(new URL('../command-metadata.json', import.meta.url));
export const metadata = JSON.parse(bytes.toString()) as { version: string; commands: Command[] };

export interface Invocation {
  native: boolean;
  config?: string;
  profile?: string;
  command: Command;
  argv: string[];
  positionals: string[];
  flags: Map<string, string>;
  help: boolean;
  home: boolean;
}

export function parse(args: string[]): Invocation {
  if (createHash('sha256').update(bytes).digest('hex') !== metadataSha256 || metadata.version !== 'v1.32.2') {
    throw new Failure('METADATA_STALE', 'Rebuild reviewed command metadata for the installed kubectl pin.');
  }
  const own: { config?: string; profile?: string } = {};
  const argv: string[] = [];
  let native = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === 'native' && argv.length === 0) {
      if (args[index + 1] !== '--') throw new Failure('USAGE', 'Use kubernetes-axi [--profile <name>] native -- <kubectl arguments>.', 2);
      native = true;
      argv.push(...args.slice(index + 2));
      break;
    }
    if (arg === '--') { argv.push(...args.slice(index)); break; }
    const [name, ...valueParts] = arg.split('=');
    if (name === '--config' || name === '--profile') {
      const value = valueParts.length ? valueParts.join('=') : args[++index];
      if (!value || value.startsWith('-')) throw new Failure('USAGE', `${name} requires a value.`, 2);
      const key = name === '--config' ? 'config' : 'profile';
      if (own[key] !== undefined) throw new Failure('USAGE', `Supply ${name} once.`, 2);
      own[key] = value;
    } else argv.push(arg);
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
    const flag = command.flags.find(flag => long ? flag.name === name : flag.short === name);
    if (!flag) {
      throw new Failure('USAGE', `Unknown flag for ${command.path || 'home'}. Valid flags: ${command.flags.map(flag => `--${flag.name}`).join(', ')}.`, 2);
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
    flags.set(flag.name, flag.type === 'bool' ? (/^(true|1|t)$/i.test(value) ? 'true' : 'false') : value);
  }
  const help = flags.get('help') === 'true' || command.path === 'help';
  if (command.path === '' && positionals.length) throw new Failure('USAGE', 'Unknown command. Run kubernetes-axi --help.', 2);
  if (!command.effect) throw new Failure('EFFECT_UNCLASSIFIED', 'The command has no reviewed effect classification.');
  if (!help) {
    if (command.compatibilityLimit) throw new Failure('NOT_YET_SUPPORTED_STAGED', command.compatibilityLimit);
    for (const flag of command.flags) {
      if (flag.effect === 'stream' && (flags.get(flag.name) ?? flag.default) !== 'false') throw new Failure('USAGE', `--${flag.name} must be false under the isolated bounded-read policy.`, 2);
    }
    for (const name of flags.keys()) {
      const flag = command.flags.find(flag => flag.name === name)!;
      if (!flag.effect) throw new Failure('EFFECT_UNCLASSIFIED', 'The flag has no reviewed effect classification.');
      if (flag.effect === 'stream') continue;
      if (!['argument', 'presentation'].includes(flag.effect)) throw new Failure('USAGE', `--${flag.name} is unavailable under the isolated bounded-read policy (${flag.effect}).`, 2);
      if (flag.name === 'output' && /file[=\s]|template-file/.test(flags.get(flag.name)!)) throw new Failure('USAGE', 'File templates require a later local-file capability.', 2);
    }
    if (!['read', 'local'].includes(command.effect)) throw new Failure('CAPABILITY_UNAVAILABLE', `The ${command.effect} capability is not available in this milestone.`);
    if (['wait', 'events'].includes(command.path)) throw new Failure('CAPABILITY_UNAVAILABLE', 'Bounded event reads use get events; wait and streaming sessions require a later capability.');
    if (!native) {
      const allowed: Record<string, string[]> = {
        '': ['namespace'], version: [], get: ['namespace', 'all-namespaces', 'selector', 'field-selector', 'output'],
        'api-versions': [], 'api-resources': [],
        'top node': ['namespace', 'selector'], 'top pod': ['namespace', 'all-namespaces', 'selector'],
      };
      if (Object.hasOwn(allowed, command.path)) {
        for (const name of flags.keys()) if (!allowed[command.path]!.includes(name)) throw new Failure('USAGE', `--${name} requires native -- ${command.path} for upstream semantics.`, 2);
      } else if (!['logs', 'describe', 'explain'].includes(command.path)) throw new Failure('CAPABILITY_UNAVAILABLE', 'Use native -- for this upstream read.');
      const maxArgs = command.path === 'get' ? 2 : command.path.startsWith('top ') ? 1 : command.path === '' || command.path === 'version' || command.path.startsWith('api-') ? 0 : undefined;
      if (maxArgs !== undefined && (positionals.length > maxArgs || (command.path === 'get' && positionals.length === 0))) throw new Failure('USAGE', 'Supply one resource type and at most one resource name.', 2);
      if (command.path === 'get' && flags.has('output') && flags.get('output') !== 'json') throw new Failure('USAGE', 'Compact reads support -o json; use native -- for other output formats.', 2);
    }
  }
  return { native, ...own, command, argv, positionals, flags, help, home: command.path === '' && positionals.length === 0 };
}

export function commandHelp(command: Command): object {
  return {
    command: command.path || 'kubernetes-axi', description: command.description,
    usage: command.use, effect: command.effect,
    ...(command.compatibilityLimit ? { compatibilityLimit: command.compatibilityLimit } : {}),
    flags: command.flags.map(flag => ({ name: `--${flag.name}`, short: flag.short ? `-${flag.short}` : '', type: flag.type, default: flag.default })),
    examples: ['kubernetes-axi --profile <name> get pods -n <namespace>', 'kubernetes-axi --profile <name> native -- get pods -n <namespace> -o json'],
  };
}
