import { isLoginAnswer } from './catalog';

// The Java behind one operation: GET /rest/restbrowser/1/catalog/details?op=<key> (system administrators only).
// Every section may instead be { error }, when the server could not read it; the others are still there.

export type Section<T> = T | { error: string };

export interface JavaMethod {
  class: string; name: string; signature: string; modifiers: string; returns: string;
  throws: string[]; annotations: string[]; deprecated: boolean;
  parameters: { name: string | null; type: string; annotations: string[] }[];
}
export interface JavaClass {
  name: string; kind: string; modifiers: string; superclasses: string[]; interfaces: string[]; annotations: string[];
  package: string; packageAnnotations: string[]; codeSource: string | null; classLoader: string;
}
export interface BundleInfo {
  id: number; symbolicName: string; version: string; state: string; location: string; lastModified: number;
  headers: Record<string, string>;
  importCount?: number; imports?: { package: string; version: string; from: string; fromId: string }[];
  exportCount?: number; exports?: { package: string; version: string; users: number }[];
  /** false when the bundle has no wiring (not resolved, or no longer in use): its imports and exports are unknown. */
  wiring?: boolean;
}
export interface PluginInfo {
  key: string; name: string; version?: string; vendor?: string; vendorUrl?: string; description?: string;
  origin: string; state: string; pluginsVersion: number; artifact?: string;
  installed?: string; loaded?: string; enabled?: string;
  dependsOn: string[]; optionallyDependsOn: string[];
  moduleCount: number; modules: { key: string; type: string; name?: string; enabled: boolean }[];
}
export interface RestModuleInfo {
  key: string; path: string; basePath: string; version: string; rest: string; description?: string; descriptor?: string;
}
export type DecompilerId = 'cfr' | 'vineflower';
export type SourceScope = 'method' | 'class';

export interface OperationSource {
  format: 1;
  key?: string;
  class: string;
  method?: string;
  scope?: SourceScope;
  decompilerId?: DecompilerId;
  decompiler: string;
  bundleId?: number;
  source: string;
  refs?: string[];
}

export interface SourceQuery {
  op?: string;
  classCandidates?: string[];
  fromBundle?: number;
  scope?: SourceScope;
  decompiler?: DecompilerId;
}

export interface OperationDetails {
  format: 1; key: string;
  method: Section<JavaMethod>;
  /** Where the JAX-RS annotations are, when that is another method (an interface's). */
  definition?: Section<JavaMethod>;
  /** The sub-resource locators from the root resource down. */
  locators: Section<JavaMethod[]>;
  resourceClass: Section<JavaClass>;
  /** The class that declares the method, when it is not the resource class. */
  declaringClass?: Section<JavaClass>;
  types: Section<{ name: string; from: string }[]>;
  /** { none } when the class is not in an OSGi bundle (the product's own, the JDK's). */
  bundle: Section<BundleInfo | { none: string }>;
  plugin: Section<PluginInfo | null>;
  module: Section<RestModuleInfo>;
}

export function isError<T>(s: Section<T> | undefined): s is { error: string } {
  return !!s && typeof s === 'object' && !Array.isArray(s) && 'error' in (s as object) && Object.keys(s as object).length === 1;
}

/**
 * Java names without their packages: "java.util.Map<java.lang.String, x.y.Thread$State>" gives
 * "Map<String, Thread.State>", "@jakarta.ws.rs.PathParam(\"id\")" gives "@PathParam(\"id\")". Text in quotes stays:
 * strings, char literals ('"' is no string), and a string clipped before its closing quote.
 */
export function shortJava(s: string): string {
  return s
    .split(/("(?:[^"\\]|\\.)*(?:"|\\?$)|'(?:[^'\\]|\\.)*(?:'|\\?$))/)
    .map((part, i) => (i % 2 ? part : part.replace(/\b(?:[a-z_][\w]*\.)+(?=[A-Z_$])/g, '').replace(/(\w)\$(?=[A-Z])/g, '$1.')))
    .join('');
}

/**
 * A failed fetch: the HTTP status and the server's reason ("system-admin-only", "unknown-operation", ...), or ours:
 * "session-expired" (the answer was the login page; the status is then 401) and "not-details" (a 200 that is not
 * the details). The message is the reason, or a sentence for ours.
 */
export class DetailsError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string = reason) {
    super(message);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
// a section is { error } or what it holds; `holds` checks the latter
const section = (v: unknown, holds: (x: unknown) => boolean) => isError(v as Section<unknown>) || holds(v);

/** Whether a body has the sections the Java tab reads, each { error } or of the right kind. */
function isDetails(b: unknown): b is OperationDetails {
  return isObject(b)
    && section(b.method, isObject) && section(b.resourceClass, isObject) && section(b.module, isObject)
    && section(b.bundle, isObject) && section(b.plugin, (x) => x === null || isObject(x))
    && section(b.types, Array.isArray) && section(b.locators, Array.isArray)
    && (b.definition === undefined || section(b.definition, isObject))
    && (b.declaringClass === undefined || section(b.declaringClass, isObject));
}

const cache = new Map<string, Promise<OperationDetails>>();
const sourceCache = new Map<string, Promise<OperationSource>>();
const CACHE_SIZE = 30;

function isSource(b: unknown): b is OperationSource {
  return isObject(b) && typeof b.source === 'string' && typeof b.decompiler === 'string'
    && typeof b.class === 'string'
    && (b.refs === undefined || (Array.isArray(b.refs) && b.refs.every((x) => typeof x === 'string')));
}

function sourceCacheKey(q: SourceQuery): string {
  return JSON.stringify([
    q.op ?? '',
    q.classCandidates ?? [],
    q.fromBundle ?? -1,
    q.scope ?? (q.classCandidates?.length ? 'class' : 'method'),
    q.decompiler ?? 'cfr',
  ]);
}

/** Decompiled source of an operation's method/class or of any referenced Java class, cached per query for the page load. */
export function fetchSource(
  baseUrl: string,
  keyOrQuery: string | SourceQuery,
  fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<OperationSource> {
  const q: SourceQuery = typeof keyOrQuery === 'string' ? { op: keyOrQuery } : keyOrQuery;
  const cacheKey = sourceCacheKey(q);
  const hit = sourceCache.get(cacheKey);
  if (hit) return hit;
  const params = new URLSearchParams();
  if (q.op) params.set('op', q.op);
  if (q.classCandidates?.length) params.set('class', q.classCandidates.join(','));
  if (q.fromBundle !== undefined && q.fromBundle >= 0) params.set('fromBundle', String(q.fromBundle));
  if (q.scope) params.set('scope', q.scope);
  if (q.decompiler) params.set('decompiler', q.decompiler);
  const p = (async () => {
    const res = await fetchFn(`${baseUrl}/rest/restbrowser/1/catalog/details/source?${params.toString()}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
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
      const reason = isObject(body) && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
      throw new DetailsError(res.status, reason);
    }
    if (!isSource(body)) {
      throw new DetailsError(res.status, 'not-source', 'The server answered with something other than the decompiled source.');
    }
    return body;
  })();
  sourceCache.set(cacheKey, p);
  p.catch(() => sourceCache.get(cacheKey) === p && sourceCache.delete(cacheKey));
  while (sourceCache.size > CACHE_SIZE * 2) sourceCache.delete(sourceCache.keys().next().value!);
  return p;
}

export function forgetSource(keyOrQuery: string | SourceQuery): void {
  if (typeof keyOrQuery === 'string') {
    for (const k of [...sourceCache.keys()]) {
      if (k.startsWith(JSON.stringify([keyOrQuery]).slice(0, -1))) sourceCache.delete(k);
    }
    return;
  }
  sourceCache.delete(sourceCacheKey(keyOrQuery));
}

/** The details of an operation, fetched once per page load (the Java behind an operation does not change while it runs). */
export function fetchDetails(baseUrl: string, key: string, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<OperationDetails> {
  const hit = cache.get(key);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetchFn(`${baseUrl}/rest/restbrowser/1/catalog/details?op=${encodeURIComponent(key)}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (isLoginAnswer(res, true)) {
      // 401 whatever the login page came with: a 200 would read as a success
      throw new DetailsError(401, 'session-expired', 'Your session has expired: reload the page to log in again.');
    }
    let body: unknown;
    try {
      body = JSON.parse(await res.text());
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const reason = isObject(body) && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
      throw new DetailsError(res.status, reason);
    }
    if (!isDetails(body)) {
      throw new DetailsError(res.status, 'not-details', 'The server answered with something other than the details of the operation.');
    }
    return body;
  })();
  cache.set(key, p);
  p.catch(() => cache.get(key) === p && cache.delete(key)); // a failure is asked again next time
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return p;
}

export function forgetDetails(key: string): void {
  cache.delete(key);
  sourceCache.delete(key);
}

/** Forgets every operation's details, e.g. when the catalog was rebuilt and the Java behind it may have changed. */
export function clearDetails(): void {
  cache.clear();
  sourceCache.clear();
}
