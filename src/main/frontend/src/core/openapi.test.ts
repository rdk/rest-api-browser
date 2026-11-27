import { describe, expect, it } from 'vitest';
import { fetchModuleOpenApi, moduleOpenApiFilename, moduleOpenApiUrl } from './openapi';

describe('core/openapi', () => {
  it('builds URLs and filenames cleanly', () => {
    expect(moduleOpenApiUrl('/jira', 'com.example:api-v2')).toBe('/jira/rest/restbrowser/1/catalog/openapi?module=com.example%3Aapi-v2');
    expect(moduleOpenApiFilename({ id: 'a:b', path: '/api/2/' })).toBe('openapi-api-2.json');
    expect(moduleOpenApiFilename({ id: 'fallback:mod', path: '' })).toBe('openapi-fallback-mod.json');
  });

  it('returns raw OpenAPI 3.1 JSON text and maps auth/server errors', async () => {
    const spec = '{"openapi":"3.1.0","info":{"title":"Demo"}}';
    const okFetch: typeof fetch = async () => new Response(spec, { status: 200 });
    await expect(fetchModuleOpenApi('/jira', 'a:b', okFetch)).resolves.toBe(spec);

    const errFetch: typeof fetch = async () => new Response('{"error":"unknown-module"}', { status: 404 });
    await expect(fetchModuleOpenApi('/jira', 'missing', errFetch)).rejects.toMatchObject({ status: 404, reason: 'unknown-module' });

    const expiredFetch: typeof fetch = async () => new Response('', { status: 401 });
    await expect(fetchModuleOpenApi('/jira', 'a:b', expiredFetch)).rejects.toMatchObject({ status: 401, reason: 'session-expired' });
  });
});
