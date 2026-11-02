import { Failure } from './errors.js';

export function routeEffect(method: string, path: string): 'read' | 'clusterWrite' | 'execution' | 'connection' | 'credentials' {
  if (!path.startsWith('/') || /\.\.|\/\/|%2f|%2e|%5c|\\/i.test(path)) throw new Failure('EFFECT_UNCLASSIFIED', 'Use an unambiguous absolute Kubernetes API route.');
  const url = new URL(path, 'http://local');
  const api = /^\/(?:api\/v[0-9]+|apis\/[a-z0-9.-]+\/v[0-9]+(?:(?:alpha|beta)[0-9]+)?)(?:\/(.*))?$/.exec(url.pathname);
  const segments = api?.[1]?.split('/') ?? [];
  // Namespace-scoped objects add a namespace selector before resource/name/subresource.
  const resource = segments[0] === 'namespaces' && segments.length >= 4 ? segments.slice(2) : segments;
  const subresource = resource[2];
  if (['proxy', 'portforward'].includes(subresource ?? '') || segments[0] === 'proxy' && segments.length > 1) return 'connection';
  if (['exec', 'attach'].includes(subresource ?? '')) return 'execution';
  if (subresource === 'token') return 'credentials';
  if (['watch', 'follow'].some(name => url.searchParams.has(name) && !/^(false|0)$/i.test(url.searchParams.get(name)!)) || segments[0] === 'watch' && segments.length > 1) return 'connection';
  if (!['GET', 'HEAD'].includes(method)) return 'clusterWrite';
  if (/^\/(?:version|api|apis)$/.test(url.pathname) || api && segments.every(segment => /^[a-z0-9.-]+$/.test(segment)) &&
    (resource.length <= 2 || resource.length === 3 && ['log', 'status', 'scale'].includes(subresource!) || segments[0] === 'namespaces' && segments.length === 3)) return 'read';
  throw new Failure('EFFECT_UNCLASSIFIED', 'The raw route has no reviewed effect classification.');
}
