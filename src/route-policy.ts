import { Failure } from './errors.js';

export function routeEffect(method: string, path: string): 'read' | 'clusterWrite' | 'execution' | 'connection' | 'credentials' {
  if (!path.startsWith('/') || /\.\.|\/\/|%2f|%2e|%5c|\\/i.test(path)) throw new Failure('EFFECT_UNCLASSIFIED', 'Use an unambiguous absolute Kubernetes API route.');
  const url = new URL(path, 'http://local');
  if (/\/(?:proxy|portforward)(?:\/|$)/.test(url.pathname)) return 'connection';
  if (/\/(?:exec|attach)(?:\/|$)/.test(url.pathname)) return 'execution';
  if (/\/token(?:\/|$)/.test(url.pathname)) return 'credentials';
  if (['watch', 'follow'].some(name => url.searchParams.has(name) && !/^(false|0)$/i.test(url.searchParams.get(name)!)) || /^\/api(?:s)?\/[^?]*\/watch\//.test(url.pathname)) return 'connection';
  if (!['GET', 'HEAD'].includes(method)) return 'clusterWrite';
  if (/^\/(?:version|api|apis)$/.test(url.pathname) || /^\/(?:api\/v[0-9]+|apis\/[a-z0-9.-]+\/v[0-9]+(?:(?:alpha|beta)[0-9]+)?)(?:\/(?:namespaces\/[a-z0-9.-]+\/)?[a-z0-9.-]+(?:\/[a-z0-9.-]+(?:\/(?:log|status|scale))?)?)?$/.test(url.pathname)) return 'read';
  throw new Failure('EFFECT_UNCLASSIFIED', 'The raw route has no reviewed effect classification.');
}
