import { isLoginAnswer } from './catalog';
import { DetailsError } from './details';
import type { Module } from './types';

/** URL of the on-demand OpenAPI 3.1.0 document for a single catalog REST module. */
export function moduleOpenApiUrl(baseUrl: string, moduleId: string): string {
  return `${baseUrl}/rest/restbrowser/1/catalog/openapi?module=${encodeURIComponent(moduleId)}`;
}

/** Clean `.json` download filename derived from a module's path or id. */
export function moduleOpenApiFilename(module: Pick<Module, 'id' | 'path'>): string {
  const raw = (module.path || module.id || 'module').trim().replace(/^\/+|\/+$/g, '');
  const slug = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `openapi-${slug || 'module'}.json`;
}

/** Downloads an OpenAPI 3.1.0 specification string for one indexed REST module. */
export async function fetchModuleOpenApi(
  baseUrl: string,
  moduleId: string,
  fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<string> {
  const res = await fetchFn(moduleOpenApiUrl(baseUrl, moduleId), {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (isLoginAnswer(res, true)) {
    throw new DetailsError(401, 'session-expired', 'Your session has expired: reload the page to log in again.');
  }
  const text = await res.text();
  if (!res.ok) {
    let reason = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (parsed && typeof parsed.error === 'string') reason = parsed.error;
    } catch {
      // Keep HTTP status reason
    }
    throw new DetailsError(res.status, reason);
  }
  return text;
}
