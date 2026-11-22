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
 * "Map<String, Thread.State>", "@jakarta.ws.rs.PathParam(\"id\")" gives "@PathParam(\"id\")". Text in quotes stays.
 */
export function shortJava(s: string): string {
  return s
    .split(/("(?:[^"\\]|\\.)*")/)
    .map((part, i) => (i % 2 ? part : part.replace(/\b(?:[a-z_][\w]*\.)+(?=[A-Z_$])/g, '').replace(/(\w)\$(?=[A-Z])/g, '$1.')))
    .join('');
}

export class DetailsError extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(reason);
  }
}

const cache = new Map<string, Promise<OperationDetails>>();
const CACHE_SIZE = 30;

/** The details of an operation, fetched once per page load (the Java behind an operation does not change while it runs). */
export function fetchDetails(baseUrl: string, key: string, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<OperationDetails> {
  const hit = cache.get(key);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetchFn(`${baseUrl}/rest/restbrowser/1/catalog/details?op=${encodeURIComponent(key)}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new DetailsError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`);
    return body as OperationDetails;
  })();
  cache.set(key, p);
  p.catch(() => cache.delete(key)); // a failure is asked again next time
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return p;
}

export function forgetDetails(key: string): void {
  cache.delete(key);
}
