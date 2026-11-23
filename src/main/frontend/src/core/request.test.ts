import { describe, expect, it } from 'vitest';
import { buildRequest, mediaChoices, setHeader, toCurl, urlParts, type RequestValues } from './request';
import { checkValue } from './validate';
import type { Param } from './types';
import { module, op, summary } from './fixtures';

const s = summary([module('jira:api2', 'api/2')]);
const empty: RequestValues = { path: {}, query: {}, header: {}, matrix: {} };
const vals = (v: Partial<RequestValues>): RequestValues => ({ ...empty, ...v });
const param = (name: string, where: Param['in'], extra: Partial<Param> = {}): Param => ({ name, in: where, type: 'string', required: false, ...extra });

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
    const params = [param('m', 'matrix'), param('skip', 'matrix'), param('x', 'query'), param('e', 'query'), param('y', 'query')];
    const o = op('jira:api2', 'GET', 'a/b', { params });
    const r = buildRequest(s, o, vals({ matrix: { m: '1 2', skip: '' }, query: { x: ['1', '2'], e: [''], y: ['a&b'] } }));
    expect(r.url).toBe('/jira/rest/api/2/a/b;m=1%202?x=1&x=2&y=a%26b');
  });

  it('puts header params into headers and picks Accept', () => {
    const o = op('jira:api2', 'GET', 'a', { produces: ['text/plain', 'application/json'], params: [param('X-A', 'header'), param('X-B', 'header')] });
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

  it('keeps the slash only when the regex can span segments, not for [^/]', () => {
    const o = op('jira:api2', 'GET', 'a/{id: [^/]+}/{path: .+}');
    expect(buildRequest(s, o, vals({ path: { id: 'p/q', path: 'r/s' } })).url).toBe('/jira/rest/api/2/a/p%2Fq/r/s');
  });

  it('wildcard defaults match the first mediaChoices entry', () => {
    const o = (extra = {}) => op('jira:api2', 'POST', 'a', extra);
    const h = (list: string[]) => buildRequest(s, o({ produces: list, consumes: list }), vals({ body: '{}' })).headers;
    for (const list of [['*/*', 'text/plain'], ['text/*', 'application/xml'], ['*/*'], []]) {
      expect(h(list).Accept).toBe(mediaChoices(list)[0]);
      expect(h(list)['Content-Type']).toBe(mediaChoices(list)[0]);
    }
    expect(h(['*/*', 'text/plain']).Accept).toBe('text/plain');
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
    const r = buildRequest(s, op('jira:api2', 'POST', 'a', { params: [param('q', 'query')] }), vals({ body: `{"a":"it's"}`, query: { q: ['1'] } }));
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


describe('request review fixes', () => {
  it('lets a declared Accept, Content-Type or X-Atlassian-Token header the user filled in win', () => {
    const o = op('jira:api2', 'POST', 'a', { params: ['Accept', 'content-type', 'X-Atlassian-Token'].map((n) => param(n, 'header')), consumes: ['application/json'] });
    const typed = buildRequest(s, o, vals({ header: { Accept: 'text/csv', 'content-type': 'text/x', 'X-Atlassian-Token': 'nocheck' }, body: '{}' }), { accept: 'application/json' });
    expect(typed.headers).toEqual({ Accept: 'text/csv', 'content-type': 'text/x', 'X-Atlassian-Token': 'nocheck' });
    const blank = buildRequest(s, o, vals({ header: { Accept: '', 'content-type': '  ' }, body: '{}' }));
    expect(blank.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' });
  });

  it('uses -I for HEAD and leaves out -u when the request has its own Authorization', () => {
    const head = toCurl(buildRequest(s, op('jira:api2', 'HEAD', 'a'), empty));
    expect(head.startsWith('curl -I ')).toBe(true);
    expect(head).not.toContain('-X');
    const r = buildRequest(s, op('jira:api2', 'GET', 'a'), empty);
    setHeader(r.headers, 'authorization', 'Bearer x');
    expect(toCurl(r)).not.toContain(' -u ');
    expect(toCurl(r)).toContain(`-H 'authorization: Bearer x'`);
  });

  it('builds no URL while the operation\'s module is missing from the summary', () => {
    const o = op('jira:gone', 'GET', 'issue/{key}');
    const u = urlParts(s, o, vals({ path: { key: 'A-1' } }));
    expect(u.error).toMatch(/module/i);
    expect(u.parts.map((p) => p.text).join('')).not.toContain('/jira/rest/issue/');
    expect(() => buildRequest(s, o, vals({ path: { key: 'A-1' } }))).toThrow(/module/i);
  });

  it('sends only the values of parameters the operation declares', () => {
    const o = op('jira:api2', 'GET', 'a/{id}', { params: [param('q', 'query'), param('m', 'matrix'), param('X-Declared', 'header')] });
    const r = buildRequest(s, o, vals({
      path: { id: '1', gone: 'x' }, query: { q: ['1'], stale: ['2'] }, matrix: { m: '3', old: '4' },
      header: { 'X-Declared': '5', 'X-Stale': '6' },
    }));
    expect(r.url).toBe('/jira/rest/api/2/a/1;m=3?q=1');
    expect(r.headers).toEqual({ 'X-Declared': '5', Accept: 'application/json' });
    expect(urlParts(s, o, vals({ path: { id: '1' }, query: { stale: ['2'] } })).parts.map((p) => p.text).join('')).toBe('/jira/rest/api/2/a/1');
  });

  it('counts a blank value as missing, as the form\'s check does', () => {
    const key = param('key', 'path', { required: true });
    const o = op('jira:api2', 'GET', 'issue/{key}', { params: [key, param('q', 'query'), param('m', 'matrix'), param('X-H', 'header')] });
    expect(checkValue(key, '   ')?.message).toBe('Required');
    expect(urlParts(s, o, vals({ path: { key: '   ' } })).missing).toEqual(['key']);
    expect(() => buildRequest(s, o, vals({ path: { key: '   ' } }))).toThrow(/key/);
    expect(() => buildRequest(s, op('jira:api2', 'GET', 'x/{t}'), vals({ path: { t: ' ' } }))).toThrow(/: t$/);
    const r = buildRequest(s, o, vals({ path: { key: 'A-1' }, query: { q: ['  '] }, matrix: { m: ' ' }, header: { 'X-H': ' ' } }));
    expect(r.url).toBe('/jira/rest/api/2/issue/A-1');
    expect(r.headers).toEqual({ Accept: 'application/json' });
  });
});

describe('request second review', () => {
  it('gives an operation on the module root no trailing slash, and its matrix params the module segment', () => {
    const o = op('jira:api2', 'GET', '', { params: [param('m', 'matrix'), param('q', 'query')] });
    expect(buildRequest(s, o, empty).url).toBe('/jira/rest/api/2');
    expect(buildRequest(s, o, vals({ matrix: { m: '1' }, query: { q: ['2'] } })).url).toBe('/jira/rest/api/2;m=1?q=2');
    expect(urlParts(s, o, empty).parts.map((p) => p.text).join('')).toBe('/jira/rest/api/2');
  });

  it('keeps one of two declared headers that differ only in case', () => {
    const o = op('jira:api2', 'GET', 'a', { params: [param('X-A', 'header'), param('x-a', 'header')] });
    const h = buildRequest(s, o, vals({ header: { 'X-A': '1', 'x-a': '2' } })).headers;
    expect(Object.keys(h).filter((k) => k.toLowerCase() === 'x-a')).toHaveLength(1);
  });

  it('falls back to the default types for a blank Accept or Content-Type choice', () => {
    const o = op('jira:api2', 'POST', 'a', { consumes: ['application/xml'], produces: ['text/plain'] });
    const r = buildRequest(s, o, vals({ body: '<a/>', accept: ' ', contentType: '' }), { accept: '' });
    expect(r.headers.Accept).toBe('text/plain');
    expect(r.headers['Content-Type']).toBe('application/xml');
  });
});
