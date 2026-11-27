import { describe, expect, it } from 'vitest';
import {
  fetchBundleResourceContent,
  fetchBundleResourceList,
  fetchBytecodeGrep,
  fetchCallers,
  fetchImplementations,
} from './codeintel';

describe('core/codeintel', () => {
  it('queries implementations, callers, grep, and bundle resources with proper parameters', async () => {
    const urls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ format: 1, results: [], entries: [], osgiServices: [], implementations: [] }), { status: 200 });
    };

    await fetchImplementations('/jira', { className: 'com.example.Svc', fromBundle: 12, includeAbstract: true, limit: 20 }, fetchFn);
    await fetchCallers('/jira', { className: 'com.example.Svc', method: 'run', packagePrefix: 'com.example', limit: 30 }, fetchFn);
    await fetchBytecodeGrep('/jira', { query: 'err.boom', bundleId: 12, caseSensitive: true, limit: 40 }, fetchFn);
    await fetchBundleResourceList('/jira', { bundleId: 12, prefix: 'templates/', limit: 50 }, fetchFn);
    await fetchBundleResourceContent('/jira', { bundleId: 12, path: 'atlassian-plugin.xml', maxLines: 200 }, fetchFn);

    expect(urls).toEqual([
      '/jira/rest/restbrowser/1/code/implementations?class=com.example.Svc&fromBundle=12&includeAbstract=true&limit=20',
      '/jira/rest/restbrowser/1/code/callers?class=com.example.Svc&method=run&packagePrefix=com.example&limit=30',
      '/jira/rest/restbrowser/1/code/grep?q=err.boom&bundleId=12&caseSensitive=true&limit=40',
      '/jira/rest/restbrowser/1/code/resource?bundleId=12&prefix=templates%2F&limit=50',
      '/jira/rest/restbrowser/1/code/resource?path=atlassian-plugin.xml&bundleId=12&maxLines=200',
    ]);
  });

  it('propagates HTTP error codes and hints cleanly', async () => {
    const errFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: 'binary-resource', hint: 'Binary entry cannot be decoded as UTF-8' }), { status: 415 });
    await expect(fetchBundleResourceContent('/jira', { bundleId: 1, path: 'icon.png' }, errFetch))
      .rejects.toMatchObject({ status: 415, reason: 'binary-resource', message: 'Binary entry cannot be decoded as UTF-8' });
  });
});
