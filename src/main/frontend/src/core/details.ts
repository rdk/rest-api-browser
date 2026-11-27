import { isLoginAnswer } from './catalog';
export { shortJava } from '../lib/java-source/javatypes';

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
  totalLines?: number;
  startLine?: number;
  endLine?: number;
  truncated?: boolean;
  methodLine?: number;
  decompileMs?: number;
  cached?: boolean;
  source: string;
  refs?: string[];
}

export interface ClassBundleSummary {
  id: number;
  symbolicName: string;
  version: string;
  state: string;
  location: string;
  lastModified: number;
  lastModifiedIso?: string;
  fragment?: boolean;
  headers: Record<string, string>;
  importCount?: number;
  exportCount?: number;
  packageExported?: boolean;
  packageExportUsers?: number;
}

export interface ClassPluginSummary {
  key: string;
  name: string;
  version?: string;
  vendor?: string;
  vendorUrl?: string;
  origin?: string;
  state: string;
  pluginsVersion: number;
  artifact?: string;
  installed?: string;
  loaded?: string;
  enabled?: string;
  moduleCount: number;
}

export interface ClassInfo {
  format: 1;
  name: string;
  simpleName: string;
  package: string;
  kind: string;
  modifiers: string;
  deprecated: boolean;
  superclass?: string;
  superclasses: string[];
  interfaces: string[];
  annotations: string[];
  enclosingClass?: string;
  innerClasses: string[];
  fieldCount: number;
  constructorCount: number;
  methodCount: number;
  methods: string[];
  bytecodeVersion?: string;
  bytecodeMajor?: number;
  bytecodeBytes: number;
  codeSource: string | null;
  classLoader: string;
  origin: string;
  bundleId: number;
  bundle?: ClassBundleSummary;
  plugin?: ClassPluginSummary;
  refCount: number;
  refs: string[];
  inspectMs?: number;
  cached?: boolean;
}

export interface PluginDetailInfo extends ClassPluginSummary {
  format: 1;
  description?: string;
  dependsOn: string[];
  optionallyDependsOn: string[];
  enabledModuleCount: number;
  bundle?: ClassBundleSummary;
  inspectMs?: number;
}

export interface ClassQuery {
  classCandidates: string[];
  fromBundle?: number;
  op?: string;
}

export interface SourceQuery {
  op?: string;
  classCandidates?: string[];
  fromBundle?: number;
  scope?: SourceScope;
  decompiler?: DecompilerId;
}

export interface SchemaPart {
  javaType?: string;
  typesVisited?: number;
  truncated?: boolean;
  schema?: unknown;
  example?: unknown;
}

export interface OperationSchemaInfo {
  format: number;
  key?: string;
  requestBody?: SchemaPart;
  responseBody?: SchemaPart;
}

export interface OperationDetails {
  format: 1; key: string;
  method: Section<JavaMethod>;
  definition?: Section<JavaMethod>;
  locators: Section<JavaMethod[]>;
  resourceClass: Section<JavaClass>;
  declaringClass?: Section<JavaClass>;
  types: Section<{ name: string; from: string }[]>;
  bundle: Section<BundleInfo | { none: string }>;
  plugin: Section<PluginInfo | null>;
  module: Section<RestModuleInfo>;
}

/** Whether a section object carries only `{ error: string }`. */
export function isError<T>(s: Section<T> | undefined): s is { error: string } {
  return !!s && typeof s === 'object' && !Array.isArray(s)
    && typeof (s as { error?: unknown }).error === 'string'
    && Object.keys(s as object).length === 1;
}

export class DetailsError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string = reason) {
    super(message);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const section = (v: unknown, holds: (x: unknown) => boolean) => isError(v as Section<unknown>) || holds(v);

function isDetails(b: unknown): b is OperationDetails {
  return isObject(b)
    && section(b.method, isObject) && section(b.resourceClass, isObject) && section(b.module, isObject)
    && section(b.bundle, isObject) && section(b.plugin, (x) => x === null || isObject(x))
    && section(b.types, Array.isArray) && section(b.locators, Array.isArray)
    && (b.definition === undefined || section(b.definition, isObject))
    && (b.declaringClass === undefined || section(b.declaringClass, isObject));
}

function lruTouch<K, V>(map: Map<K, V>, key: K, val: V, max: number): void {
  map.delete(key);
  map.set(key, val);
  while (map.size > max) map.delete(map.keys().next().value!);
}

const CACHE_SIZE = 30;
const CLASS_INFO_CACHE_SIZE = 200;

const cache = new Map<string, Promise<OperationDetails>>();
const resolvedDetails = new Map<string, OperationDetails>();
const sourceCache = new Map<string, Promise<OperationSource>>();
const resolvedSources = new Map<string, OperationSource>();
const classInfoCache = new Map<string, Promise<ClassInfo>>();
const pluginInfoCache = new Map<string, Promise<PluginDetailInfo>>();
const schemaCache = new Map<string, Promise<OperationSchemaInfo>>();
let lastBaseUrl = '';

const scoped = (baseUrl: string, key: string) => `${baseUrl}\0${key}`;

function findResolved<T>(map: Map<string, T>, rawKey: string, baseUrl?: string): T | null {
  if (baseUrl !== undefined) {
    return map.get(scoped(baseUrl, rawKey)) ?? null;
  }
  const direct = map.get(scoped(lastBaseUrl, rawKey));
  if (direct !== undefined) return direct;
  for (const [k, v] of map) {
    const sep = k.indexOf('\0');
    if (k.slice(sep + 1) === rawKey) return v;
  }
  return null;
}

/** Synchronous LRU cache read for already-loaded operation details. */
export function peekDetails(key: string, baseUrl?: string): OperationDetails | null {
  return findResolved(resolvedDetails, key, baseUrl);
}

/** Synchronous LRU cache read for already-decompiled source. */
export function peekSource(keyOrQuery: string | SourceQuery, baseUrl?: string): OperationSource | null {
  const q: SourceQuery = typeof keyOrQuery === 'string' ? { op: keyOrQuery } : keyOrQuery;
  return findResolved(resolvedSources, sourceCacheKey(q), baseUrl);
}

function isPluginDetailInfo(b: unknown): b is PluginDetailInfo {
  return isObject(b) && typeof b.key === 'string' && typeof b.name === 'string' && typeof b.state === 'string';
}

/** Rich plugin & OSGi bundle metadata for an app lozenge tooltip, cached per baseUrl & page load. */
export function fetchPluginInfo(
  baseUrl: string,
  pluginKey: string,
  fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<PluginDetailInfo> {
  lastBaseUrl = baseUrl;
  const cacheKey = scoped(baseUrl, pluginKey);
  const hit = pluginInfoCache.get(cacheKey);
  if (hit) {
    lruTouch(pluginInfoCache, cacheKey, hit, CACHE_SIZE * 2);
    return hit;
  }
  const p = (async () => {
    const res = await fetchFn(`${baseUrl}/rest/restbrowser/1/code/plugin?key=${encodeURIComponent(pluginKey)}`, {
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
    if (!isPluginDetailInfo(body)) {
      throw new DetailsError(res.status, 'not-plugin-info', 'The server answered with something other than plugin metadata.');
    }
    return body;
  })();
  lruTouch(pluginInfoCache, cacheKey, p, CACHE_SIZE * 2);
  p.catch(() => pluginInfoCache.get(cacheKey) === p && pluginInfoCache.delete(cacheKey));
  return p;
}

function isClassInfo(b: unknown): b is ClassInfo {
  return isObject(b) && typeof b.name === 'string' && typeof b.kind === 'string' && typeof b.origin === 'string';
}

function classInfoCacheKey(q: ClassQuery): string {
  return JSON.stringify([q.classCandidates, q.fromBundle ?? -1, q.op ?? '']);
}

/** Rich class metadata (reflection, bytecode, OSGi bundle, plugin ownership, timestamps), LRU cached. */
export function fetchClassInfo(
  baseUrl: string,
  q: ClassQuery,
  fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<ClassInfo> {
  lastBaseUrl = baseUrl;
  const cacheKey = scoped(baseUrl, classInfoCacheKey(q));
  const hit = classInfoCache.get(cacheKey);
  if (hit) {
    lruTouch(classInfoCache, cacheKey, hit, CLASS_INFO_CACHE_SIZE);
    return hit;
  }
  const params = new URLSearchParams();
  if (q.classCandidates.length) params.set('class', q.classCandidates.join(','));
  if (q.fromBundle !== undefined && q.fromBundle >= 0) params.set('fromBundle', String(q.fromBundle));
  if (q.op) params.set('op', q.op);
  const p = (async () => {
    const res = await fetchFn(`${baseUrl}/rest/restbrowser/1/code/class?${params.toString()}`, {
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
    if (!isClassInfo(body)) {
      throw new DetailsError(res.status, 'not-class-info', 'The server answered with something other than class metadata.');
    }
    return body;
  })();
  lruTouch(classInfoCache, cacheKey, p, CLASS_INFO_CACHE_SIZE);
  p.catch(() => classInfoCache.get(cacheKey) === p && classInfoCache.delete(cacheKey));
  return p;
}

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
    q.decompiler ?? 'vineflower',
  ]);
}

/** Decompiled source of an operation's method/class or of any referenced Java class, LRU cached per baseUrl. */
export function fetchSource(
  baseUrl: string,
  keyOrQuery: string | SourceQuery,
  fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<OperationSource> {
  lastBaseUrl = baseUrl;
  const q: SourceQuery = typeof keyOrQuery === 'string' ? { op: keyOrQuery } : keyOrQuery;
  const cacheKey = scoped(baseUrl, sourceCacheKey(q));
  const hit = sourceCache.get(cacheKey);
  if (hit) {
    lruTouch(sourceCache, cacheKey, hit, CACHE_SIZE * 2);
    return hit;
  }
  const params = new URLSearchParams();
  if (q.op) params.set('op', q.op);
  if (q.classCandidates?.length) params.set('class', q.classCandidates.join(','));
  if (q.fromBundle !== undefined && q.fromBundle >= 0) params.set('fromBundle', String(q.fromBundle));
  if (q.scope) params.set('scope', q.scope);
  if (q.decompiler) params.set('decompiler', q.decompiler);
  let p!: Promise<OperationSource>;
  p = (async () => {
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
    if (sourceCache.get(cacheKey) === p) {
      lruTouch(resolvedSources, cacheKey, body, CACHE_SIZE * 2);
      if (body.class) {
        const canonicalKey = scoped(baseUrl, sourceCacheKey({ ...q, classCandidates: [body.class] }));
        if (canonicalKey !== cacheKey && !sourceCache.has(canonicalKey)) {
          lruTouch(sourceCache, canonicalKey, p, CACHE_SIZE * 2);
          lruTouch(resolvedSources, canonicalKey, body, CACHE_SIZE * 2);
        }
      }
    }
    return body;
  })();
  lruTouch(sourceCache, cacheKey, p, CACHE_SIZE * 2);
  p.catch(() => sourceCache.get(cacheKey) === p && sourceCache.delete(cacheKey));
  return p;
}

export function forgetSource(keyOrQuery: string | SourceQuery, baseUrl?: string): void {
  if (typeof keyOrQuery === 'string') {
    const prefix = JSON.stringify([keyOrQuery]).slice(0, -1);
    const dropPrefix = <T>(m: Map<string, T>) => {
      for (const k of [...m.keys()]) {
        const sep = k.indexOf('\0');
        const b = k.slice(0, sep);
        const raw = k.slice(sep + 1);
        if ((baseUrl === undefined || b === baseUrl) && raw.startsWith(prefix)) {
          m.delete(k);
        }
      }
    };
    dropPrefix(sourceCache);
    dropPrefix(resolvedSources);
    return;
  }
  const rawKey = sourceCacheKey(keyOrQuery);
  const wantScope = keyOrQuery.scope ?? 'class';
  const wantDecompiler = keyOrQuery.decompiler ?? 'cfr';
  const cands = new Set(keyOrQuery.classCandidates ?? []);
  const aliasRawKeys = new Set<string>([rawKey]);
  for (const [k, v] of resolvedSources.entries()) {
    const sep = k.indexOf('\0');
    const b = k.slice(0, sep);
    const raw = k.slice(sep + 1);
    if (baseUrl !== undefined && b !== baseUrl) continue;
    const entryScope = v.scope ?? 'class';
    const entryDecompiler = v.decompilerId ?? 'cfr';
    if (raw === rawKey || (v.class && cands.has(v.class) && entryScope === wantScope && entryDecompiler === wantDecompiler)) {
      aliasRawKeys.add(raw);
      if (v.class) {
        aliasRawKeys.add(sourceCacheKey({ ...keyOrQuery, classCandidates: [v.class] }));
      }
    }
  }
  const dropExact = <T>(m: Map<string, T>) => {
    for (const k of [...m.keys()]) {
      const sep = k.indexOf('\0');
      if ((baseUrl === undefined || k.slice(0, sep) === baseUrl) && aliasRawKeys.has(k.slice(sep + 1))) {
        m.delete(k);
      }
    }
  };
  dropExact(sourceCache);
  dropExact(resolvedSources);
}

/** The details of an operation, LRU cached per baseUrl & page load. */
export function fetchDetails(baseUrl: string, key: string, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<OperationDetails> {
  lastBaseUrl = baseUrl;
  const cacheKey = scoped(baseUrl, key);
  const hit = cache.get(cacheKey);
  if (hit) {
    lruTouch(cache, cacheKey, hit, CACHE_SIZE);
    return hit;
  }
  let p!: Promise<OperationDetails>;
  p = (async () => {
    const res = await fetchFn(`${baseUrl}/rest/restbrowser/1/catalog/details?op=${encodeURIComponent(key)}`, {
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
    if (!isDetails(body)) {
      throw new DetailsError(res.status, 'not-details', 'The server answered with something other than the details of the operation.');
    }
    if (cache.get(cacheKey) === p) {
      lruTouch(resolvedDetails, cacheKey, body, CACHE_SIZE);
    }
    return body;
  })();
  lruTouch(cache, cacheKey, p, CACHE_SIZE);
  p.catch(() => cache.get(cacheKey) === p && cache.delete(cacheKey));
  return p;
}

export function forgetDetails(key: string, baseUrl?: string): void {
  const dropExact = <T>(m: Map<string, T>) => {
    for (const k of [...m.keys()]) {
      const sep = k.indexOf('\0');
      if ((baseUrl === undefined || k.slice(0, sep) === baseUrl) && k.slice(sep + 1) === key) {
        m.delete(k);
      }
    }
  };
  dropExact(cache);
  dropExact(resolvedDetails);
  forgetSource(key, baseUrl);
}

/** Synthesizes request/response DTO JSON Schemas and representative example payloads for an operation (sysadmin only). */
export function fetchOperationSchema(
  baseUrl: string,
  opKey: string,
  depth = 3,
  fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<OperationSchemaInfo> {
  lastBaseUrl = baseUrl;
  const cacheKey = scoped(baseUrl, `${opKey}\0${depth}`);
  const hit = schemaCache.get(cacheKey);
  if (hit) {
    lruTouch(schemaCache, cacheKey, hit, CACHE_SIZE);
    return hit;
  }
  const params = new URLSearchParams({ op: opKey, depth: String(depth), includeExample: 'true' });
  const p = (async () => {
    const res = await fetchFn(`${baseUrl}/rest/restbrowser/1/code/schema?${params.toString()}`, {
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
    if (!isObject(body) || typeof body.format !== 'number') {
      throw new DetailsError(res.status, 'not-schema', 'The server answered with something other than a DTO schema.');
    }
    return body as unknown as OperationSchemaInfo;
  })();
  lruTouch(schemaCache, cacheKey, p, CACHE_SIZE);
  p.catch(() => schemaCache.get(cacheKey) === p && schemaCache.delete(cacheKey));
  return p;
}

/** Forgets every operation's details, e.g. when the catalog was rebuilt and the Java behind it may have changed. */
export function clearDetails(): void {
  cache.clear();
  resolvedDetails.clear();
  sourceCache.clear();
  resolvedSources.clear();
  classInfoCache.clear();
  pluginInfoCache.clear();
  schemaCache.clear();
}
