import protobuf from 'protobufjs';
import type { Message, Type } from 'protobufjs';
import { protobufSchema } from './protobuf-schema.js';
import { Failure } from './errors.js';

const root = protobuf.Root.fromJSON(protobufSchema).resolveAll();
const envelopeType = root.lookupType('k8s.io.apimachinery.pkg.runtime.Unknown');
const groups: Record<string, string> = { v1: 'core.v1', 'apps/v1': 'apps.v1', 'certificates.k8s.io/v1': 'certificates.v1', 'authorization.k8s.io/v1': 'authorization.v1',
  'authentication.k8s.io/v1': 'authentication.v1', 'autoscaling/v1': 'autoscaling.v1', 'autoscaling/v2': 'autoscaling.v2', 'policy/v1': 'policy.v1',
  'rbac.authorization.k8s.io/v1': 'rbac.v1', 'batch/v1': 'batch.v1', 'networking.k8s.io/v1': 'networking.v1', 'scheduling.k8s.io/v1': 'scheduling.v1' };

function normalize(type: Type, message: Message): unknown {
  const value = type.toObject(message, { longs: Number, bytes: String }) as Record<string, unknown>;
  const name = type.fullName.split('.').at(-1);
  if (name === 'Quantity' || name === 'QuantityValue') return value.string ?? '0';
  if (name === 'IntOrString') return Number(value.type ?? 0) === 0 ? value.intVal ?? 0 : value.strVal ?? '';
  if (name === 'Time' || name === 'MicroTime') {
    if (!Object.hasOwn(value, 'seconds')) return null;
    const seconds = Number(value.seconds);
    const nanos = Number(value.nanos ?? 0).toString().padStart(9, '0').replace(/0+$/, '');
    return new Date(seconds * 1000).toISOString().replace('.000Z', `${nanos ? `.${nanos}` : ''}Z`);
  }
  if (name === 'RawExtension' || name === 'FieldsV1') return value.raw ? JSON.parse(Buffer.from(String(value.raw), 'base64').toString()) as unknown : {};
  if (name === 'ExtraValue') return value.items ?? [];
  for (const field of type.fieldsArray) {
    if (!Object.hasOwn(value, field.name)) continue;
    const original = (message as unknown as Record<string, unknown>)[field.name];
    if (field.resolvedType instanceof protobuf.Type) {
      const nested = field.resolvedType;
      value[field.name] = field.map ? Object.fromEntries(Object.entries(original as Record<string, Message>).map(([key, item]) => [key, normalize(nested, item)])) :
        field.repeated ? (original as Message[]).map(item => normalize(nested, item)) : normalize(nested, original as Message);
    } else if (typeof value[field.name] === 'number' && !Number.isSafeInteger(value[field.name])) throw new Failure('UPSTREAM_INVALID', 'The protobuf body contains an integer outside the exact JSON range.');
  }
  return value;
}

export function decodeKubernetes(bytes: Buffer): unknown {
  if (!bytes.subarray(0, 4).equals(Buffer.from('k8s\0'))) throw new Failure('PROTOBUF_INVALID', 'Expected the Kubernetes protobuf envelope.');
  const envelope = envelopeType.decode(bytes.subarray(4)) as unknown as { typeMeta?: { apiVersion?: string; kind?: string }; raw?: Uint8Array; contentEncoding?: string; contentType?: string };
  const version = envelope.typeMeta?.apiVersion ?? '';
  const kind = envelope.typeMeta?.kind ?? '';
  if (!groups[version] || !/^[A-Z][A-Za-z0-9]+$/.test(kind) || !envelope.raw || envelope.contentEncoding || envelope.contentType && envelope.contentType !== 'application/vnd.kubernetes.protobuf') throw new Failure('PROTOBUF_UNSUPPORTED', 'The protobuf type or encoding is outside the pinned schemas; no request was forwarded.');
  let type: Type;
  try { type = root.lookupType(`k8s.io.api.${groups[version]}.${kind}`); }
  catch { throw new Failure('PROTOBUF_UNSUPPORTED', 'Unknown Kubernetes protobuf type; no request was forwarded.'); }
  return { ...(normalize(type, type.decode(envelope.raw)) as object), apiVersion: version, kind };
}
