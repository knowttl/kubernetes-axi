import { createHash } from 'node:crypto';

export function identityBinding(cluster: object, user: object, selection: { auth: string | undefined; namespace: string; context?: string | undefined }): string {
  return createHash('sha256').update(JSON.stringify({ cluster, user, ...selection })).digest('hex');
}
