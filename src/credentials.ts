import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Ajv } from 'ajv';
import { Failure } from './errors.js';
import { readPrivate } from './private-files.js';

type SecretRef = { env: string } | { file: string };
export interface Profile {
  origin: string;
  auth: 'token' | 'certificate';
  namespace?: string;
  certificateAuthority: string;
  token?: SecretRef;
  clientCertificate?: string;
  privateKey?: SecretRef;
}
export interface Identity {
  profile: Profile;
  source: string;
  secret: string;
}

const ajv = new Ajv({ strict: true, strictRequired: false });
ajv.addKeyword('x-secret');
const schema = JSON.parse(await readFile(new URL('../axi-credential.schema.json', import.meta.url), 'utf8')) as object;
const validateProfile = ajv.compile<Profile>(schema);
const validateConfig = ajv.compile<{ version: 1; defaultProfile?: string; profiles: Record<string, Profile> }>({
  type: 'object', additionalProperties: false, required: ['version', 'profiles'],
  properties: {
    version: { const: 1 },
    defaultProfile: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' },
    profiles: {
      type: 'object', propertyNames: { pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' },
      additionalProperties: { $ref: 'urn:kubernetes-axi:credential-profile' },
    },
  },
});

export function configPath(explicit?: string): string {
  const base = process.platform === 'win32'
    ? process.env.APPDATA
    : (process.env.XDG_CONFIG_HOME && isAbsolute(process.env.XDG_CONFIG_HOME) ? process.env.XDG_CONFIG_HOME : join(homedir(), '.config'));
  if (!base) throw new Failure('CONFIG_INVALID', 'Set APPDATA to an absolute directory.');
  const path = explicit ?? process.env.KUBERNETES_AXI_CONFIG ?? join(base, 'kubernetes-axi', 'config.json');
  if (!isAbsolute(path)) throw new Failure('CONFIG_INVALID', 'Use an absolute config path.');
  return path;
}

async function resolveSecret(ref: SecretRef): Promise<string> {
  let value: string | undefined;
  if ('env' in ref) value = process.env[ref.env];
  else {
    if (!isAbsolute(ref.file) || (process.platform === 'win32' && !/^[A-Za-z]:\\/.test(ref.file))) {
      throw new Failure('CONFIG_INVALID', 'Secret file must use an absolute local path.');
    }
    value = (await readPrivate(ref.file, true)).replace(/^\uFEFF/, '').trimEnd();
  }
  if (!value) throw new Failure('AUTH_REQUIRED', 'Supply the selected secret through its environment or protected-file reference.');
  return value;
}

export async function identity(config?: string, selected?: string): Promise<Identity> {
  const readOnly = process.env.KUBERNETES_AXI_READ_ONLY;
  if (readOnly !== undefined && !/^(true|false|0|1)$/i.test(readOnly)) {
    throw new Failure('CONFIG_INVALID', 'KUBERNETES_AXI_READ_ONLY must be true, false, 1 or 0.');
  }
  const name = selected ?? process.env.KUBERNETES_AXI_PROFILE;
  const fields = ['ORIGIN', 'AUTH', 'NAMESPACE', 'CERTIFICATE_AUTHORITY', 'TOKEN', 'CLIENT_CERTIFICATE', 'PRIVATE_KEY'] as const;
  let profile: unknown;
  let source: string;
  if (!name && fields.some(field => process.env[`KUBERNETES_AXI_${field}`] !== undefined)) {
    const env = process.env;
    profile = Object.fromEntries([
      ['origin', env.KUBERNETES_AXI_ORIGIN], ['auth', env.KUBERNETES_AXI_AUTH],
      ['namespace', env.KUBERNETES_AXI_NAMESPACE], ['certificateAuthority', env.KUBERNETES_AXI_CERTIFICATE_AUTHORITY],
      ['clientCertificate', env.KUBERNETES_AXI_CLIENT_CERTIFICATE],
      ['token', env.KUBERNETES_AXI_TOKEN === undefined ? undefined : { env: 'KUBERNETES_AXI_TOKEN' }],
      ['privateKey', env.KUBERNETES_AXI_PRIVATE_KEY === undefined ? undefined : { env: 'KUBERNETES_AXI_PRIVATE_KEY' }],
    ].filter(([, value]) => value !== undefined));
    source = 'environment';
  } else {
    let contents: string;
    try {
      contents = await readPrivate(configPath(config), false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Failure('AUTH_REQUIRED', 'Supply a complete environment profile or select a configured profile.');
      }
      throw error;
    }
    const file: unknown = JSON.parse(contents);
    if (!validateConfig(file)) throw new Failure('CONFIG_INVALID', 'Use a version 1 config with strict profiles and SecretRefs.');
    const names = Object.keys(file.profiles);
    const chosen = name ?? file.defaultProfile ?? (names.length === 1 ? names[0] : undefined);
    if (!chosen) throw new Failure(names.length ? 'PROFILE_AMBIGUOUS' : 'PROFILE_REQUIRED', 'Select a profile with --profile <name>.');
    if (!Object.hasOwn(file.profiles, chosen)) throw new Failure('PROFILE_NOT_FOUND', 'Select a profile present in the config file.');
    profile = file.profiles[chosen];
    source = `file:${chosen}`;
  }
  if (!validateProfile(profile)) throw new Failure('CONFIG_INVALID', 'Supply a complete profile; token and privateKey must be valid SecretRefs.');
  const origin = new URL(profile.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Failure('CONFIG_INVALID', 'origin must be an HTTPS origin without credentials, path, query or fragment.');
  }
  const secret = await resolveSecret(profile.auth === 'token'
    ? profile.token ?? { env: 'KUBERNETES_AXI_TOKEN' }
    : profile.privateKey ?? { env: 'KUBERNETES_AXI_PRIVATE_KEY' });
  return { profile, source, secret };
}
