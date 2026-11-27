import { isLoginAnswer } from './catalog';
import { DetailsError } from './details';

export interface OsgiServiceHit {
  serviceId: number;
  bundleId: number;
  bundle?: string;
  plugin?: string;
  beanName?: string;
  ranking: number;
  objectClass: string[];
}

export interface ImplHit {
  class: string;
  simpleName: string;
  kind: string;
  abstract: boolean;
  bundleId: number;
  bundle?: string;
  plugin?: string;
  via: string;
}

export interface ImplementationsResponse {
  format: number;
  target: string;
  kind: string;
  bundleId: number;
  scannedBundles: number;
  truncated: boolean;
  elapsedMs: number;
  serviceCount: number;
  osgiServices: OsgiServiceHit[];
  implementationCount: number;
  implementations: ImplHit[];
}

export interface CallerHit {
  class: string;
  simpleName: string;
  bundleId: number;
  bundle?: string;
  plugin?: string;
  calls: string[];
}

export interface CallersResponse {
  format: number;
  target: string;
  method?: string;
  bundleId: number;
  count: number;
  scannedClasses: number;
  scannedBundles: number;
  truncated: boolean;
  elapsedMs: number;
  results: CallerHit[];
}

export interface GrepHit {
  class: string;
  simpleName: string;
  bundleId: number;
  bundle?: string;
  plugin?: string;
  matches: string[];
}

export interface GrepResponse {
  format: number;
  query: string;
  caseSensitive: boolean;
  includeUtf8: boolean;
  count: number;
  scannedClasses: number;
  scannedBundles: number;
  truncated: boolean;
  elapsedMs: number;
  hint?: string;
  results: GrepHit[];
}

export interface BundleResourceEntry {
  path: string;
  kind: string;
}

export interface BundleResourceListResponse {
  format: number;
  bundleId: number;
  bundle?: string;
  plugin?: string;
  prefix?: string;
  count: number;
  truncated: boolean;
  entries: BundleResourceEntry[];
}

export interface BundleResourceContentResponse {
  format: number;
  bundleId: number;
  bundle?: string;
  plugin?: string;
  path: string;
  kind: string;
  bytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  lineNumbers?: boolean;
  content: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

async function fetchCodeJson<T>(url: string, fetchFn: typeof fetch): Promise<T> {
  const res = await fetchFn(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (isLoginAnswer(res, true)) {
    throw new DetailsError(401, 'session-expired', 'Your session has expired: reload the page to log in again.');
  }
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const reason = isObj(body) && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    const msg = isObj(body) && typeof body.hint === 'string' ? body.hint : reason;
    throw new DetailsError(res.status, reason, msg);
  }
  if (!isObj(body)) {
    throw new DetailsError(res.status, 'invalid-response', 'The server answered with unexpected data.');
  }
  return body as unknown as T;
}

function appendTarget(params: URLSearchParams, q: { className?: string; fromBundle?: number; opKey?: string }) {
  if (q.className) params.set('class', q.className);
  if (q.fromBundle !== undefined && q.fromBundle >= 0) params.set('fromBundle', String(q.fromBundle));
  if (q.opKey) params.set('op', q.opKey);
}

export function fetchImplementations(
  baseUrl: string,
  q: { className?: string; fromBundle?: number; opKey?: string; includeAbstract?: boolean; limit?: number },
  fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<ImplementationsResponse> {
  const params = new URLSearchParams();
  appendTarget(params, q);
  if (q.includeAbstract) params.set('includeAbstract', 'true');
  if (q.limit) params.set('limit', String(q.limit));
  return fetchCodeJson(`${baseUrl}/rest/restbrowser/1/code/implementations?${params.toString()}`, fetchFn);
}

export function fetchCallers(
  baseUrl: string,
  q: { className?: string; method?: string; fromBundle?: number; opKey?: string; packagePrefix?: string; limit?: number },
  fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<CallersResponse> {
  const params = new URLSearchParams();
  appendTarget(params, q);
  if (q.method?.trim()) params.set('method', q.method.trim());
  if (q.packagePrefix?.trim()) params.set('packagePrefix', q.packagePrefix.trim());
  if (q.limit) params.set('limit', String(q.limit));
  return fetchCodeJson(`${baseUrl}/rest/restbrowser/1/code/callers?${params.toString()}`, fetchFn);
}

export function fetchBytecodeGrep(
  baseUrl: string,
  q: { query: string; bundleId?: number; caseSensitive?: boolean; includeUtf8?: boolean; limit?: number },
  fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<GrepResponse> {
  const params = new URLSearchParams({ q: q.query });
  if (q.bundleId !== undefined && q.bundleId >= 0) params.set('bundleId', String(q.bundleId));
  if (q.caseSensitive) params.set('caseSensitive', 'true');
  if (q.includeUtf8 === false) params.set('includeUtf8', 'false');
  if (q.limit) params.set('limit', String(q.limit));
  return fetchCodeJson(`${baseUrl}/rest/restbrowser/1/code/grep?${params.toString()}`, fetchFn);
}

export function fetchBundleResourceList(
  baseUrl: string,
  q: { bundleId?: number; pluginKey?: string; prefix?: string; limit?: number },
  fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<BundleResourceListResponse> {
  const params = new URLSearchParams();
  if (q.bundleId !== undefined && q.bundleId >= 0) params.set('bundleId', String(q.bundleId));
  else if (q.pluginKey) params.set('plugin', q.pluginKey);
  if (q.prefix?.trim()) params.set('prefix', q.prefix.trim());
  if (q.limit) params.set('limit', String(q.limit));
  return fetchCodeJson(`${baseUrl}/rest/restbrowser/1/code/resource?${params.toString()}`, fetchFn);
}

export function fetchBundleResourceContent(
  baseUrl: string,
  q: { bundleId?: number; pluginKey?: string; path: string; startLine?: number; maxLines?: number },
  fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<BundleResourceContentResponse> {
  const params = new URLSearchParams({ path: q.path });
  if (q.bundleId !== undefined && q.bundleId >= 0) params.set('bundleId', String(q.bundleId));
  else if (q.pluginKey) params.set('plugin', q.pluginKey);
  if (q.startLine) params.set('startLine', String(q.startLine));
  if (q.maxLines) params.set('maxLines', String(q.maxLines));
  return fetchCodeJson(`${baseUrl}/rest/restbrowser/1/code/resource?${params.toString()}`, fetchFn);
}
