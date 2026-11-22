import { describe, expect, it } from 'vitest';
import { buildRequest, mediaChoices, setHeader, toCurl, type RequestValues } from './request';
import { module, op, summary } from './fixtures';

const s = summary([module('jira:api2', 'api/2')]);
const empty: RequestValues = { path: {}, query: {}, header: {}, matrix: {} };
const vals = (v: Partial<RequestValues>): RequestValues => ({ ...empty, ...v });

describe('buildRequest', () => {
  it('builds the URL, encoding each path segment', () => {
    const o = op('jira:api2', 'GET', 'issue/{issueIdOrKey}');
    const r = buildRequest(s, o, vals({ path: { issueIdOrKey: 'a b/c$&' } }));
    expect(r.url).toBe('/jira/rest/api/2/issue/a%20b%2Fc%24%26');
  });

  it('does not treat $ in values as a replacement pattern', () => {
    const o = op('jira:api2', 'GET', 'x/{a}');
    expect(buildRequest(s, o, vals({ path: { a: "$&$1$'" } })).url).toContain('%24%26%241%24\'');
  });

  it('replaces templates with regexes', () => {
    const o = op('jira:api2', 'GET', 'f/{id: [0-9]{3}}/{path: .+}');
    expect(buildRequest(s, o, vals({ path: { id: '123', path: 'a/b c' } })).url).toBe('/jira/rest/api/2/f/123/a/b%20c');
  });

  it('throws for a missing required path value, naming it', () => {
    const o = op('jira:api2', 'GET', 'issue/{key}', { params: [{ name: 'key', in: 'path', type: 'string', required: true }] });
    expect(() => buildRequest(s, o, empty)).toThrow(/key/);
  });

  it('adds matrix params to the last segment and query params in order', () => {
    const o = op('jira:api2', 'GET', 'a/b');
    const r = buildRequest(s, o, vals({ matrix: { m: '1 2', skip: '' }, query: { x: ['1', '2'], e: [''], y: ['a&b'] } }));
    expect(r.url).toBe('/jira/rest/api/2/a/b;m=1%202?x=1&x=2&y=a%26b');
  });

  it('puts header params into headers and picks Accept', () => {
    const o = op('jira:api2', 'GET', 'a', { produces: ['text/plain', 'application/json'] });
    expect(buildRequest(s, o, vals({ header: { 'X-A': '1', 'X-B': '' } })).headers).toEqual({ 'X-A': '1', Accept: 'text/plain' });
    expect(buildRequest(s, o, empty, { accept: 'x/y' }).headers.Accept).toBe('x/y');
    expect(buildRequest(s, op('jira:api2', 'GET', 'a', { produces: [] }), empty).headers.Accept).toBe('application/json');
  });

  it('sends a body and Content-Type only where it makes sense', () => {
    const post = buildRequest(s, op('jira:api2', 'POST', 'a', { consumes: ['application/xml'] }), vals({ body: '<a/>' }));
    expect(post.body).toBe('<a/>');
    expect(post.headers['Content-Type']).toBe('application/xml');
    expect(buildRequest(s, op('jira:api2', 'GET', 'a'), vals({ body: 'x' })).body).toBeUndefined();
    expect(buildRequest(s, op('jira:api2', 'DELETE', 'a'), empty).body).toBeUndefined();
    expect(buildRequest(s, op('jira:api2', 'DELETE', 'a'), vals({ body: '{}' })).body).toBe('{}');
    expect(buildRequest(s, op('jira:api2', 'POST', 'a'), vals({ body: '{}', contentType: 'text/x' })).headers['Content-Type']).toBe('text/x');
  });

  it('adds X-Atlassian-Token for writes only, unless disabled', () => {
    const t = (m: string, o = {}) => buildRequest(s, op('jira:api2', m, 'a'), empty, o).headers['X-Atlassian-Token'];
    expect(t('GET')).toBeUndefined();
    expect(t('HEAD')).toBeUndefined();
    expect(t('OPTIONS')).toBeUndefined();
    expect(t('POST')).toBe('no-check');
    expect(t('DELETE')).toBe('no-check');
    expect(t('POST', { noXsrfHeader: true })).toBeUndefined();
  });
});

describe('request details', () => {
  it('encodes slashes unless the regex spans segments', () => {
    const plain = op('jira:api2', 'GET', 'a/{x}/{y: [a-z/]+}/{z: .*}');
    expect(buildRequest(s, plain, vals({ path: { x: 'p/q', y: 'r/s', z: 't/u' } })).url).toBe('/jira/rest/api/2/a/p%2Fq/r/s/t/u');
  });

  it('defaults wildcard media types to JSON', () => {
    const o = (extra = {}) => op('jira:api2', 'POST', 'a', extra);
    expect(buildRequest(s, o({ produces: ['*/*'], consumes: ['*/*'] }), vals({ body: '{}' })).headers).toMatchObject({ Accept: 'application/json', 'Content-Type': 'application/json' });
    expect(buildRequest(s, o({ produces: ['text/*'], consumes: [] }), vals({ body: '{}' })).headers['Content-Type']).toBe('application/json');
  });

  it('mediaChoices lists concrete types plus defaults for wildcards', () => {
    expect(mediaChoices(['text/plain'])).toEqual(['text/plain']);
    expect(mediaChoices([])).toEqual(['application/json', 'application/xml', 'text/plain']);
    expect(mediaChoices(['text/plain', '*/*'])).toEqual(['text/plain', 'application/json', 'application/xml']);
  });

  it('setHeader replaces a key whatever its case', () => {
    const h = { accept: 'x', Other: '1' };
    setHeader(h, 'Accept', 'y');
    expect(h).toEqual({ Accept: 'y', Other: '1' });
    const r = buildRequest(s, op('jira:api2', 'POST', 'a'), vals({ header: { 'content-type': 'z', 'x-atlassian-token': 'q', ACCEPT: 'w' }, body: '1' }));
    expect(Object.keys(r.headers).map((k) => k.toLowerCase()).sort()).toEqual(['accept', 'content-type', 'x-atlassian-token']);
  });
});

describe('toCurl', () => {
  it('builds a one-line command with quoting and placeholder auth', () => {
    const r = buildRequest(s, op('jira:api2', 'POST', 'a'), vals({ body: `{"a":"it's"}`, query: { q: ['1'] } }));
    const c = toCurl(r);
    expect(c).not.toContain('\n');
    expect(c).toContain('-X POST');
    expect(c).toContain('-u "$USER:$PASSWORD"');
    expect(c).toContain(`--data-raw '{"a":"it'\\''s"}'`);
    expect(c).toContain(`-H 'X-Atlassian-Token: no-check'`);
    expect(c.endsWith(`'/jira/rest/api/2/a?q=1'`)).toBe(true);
    expect(c.toLowerCase()).not.toContain('cookie');
  });

  it('omits -X for GET', () => {
    expect(toCurl(buildRequest(s, op('jira:api2', 'GET', 'a'), empty))).not.toContain('-X');
  });
});
