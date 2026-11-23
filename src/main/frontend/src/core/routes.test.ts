import { describe, expect, it } from 'vitest';
import { createMatcher } from './routes';
import { splitSegments } from './template';
import { index, module, op, summary } from './fixtures';

const s = summary([module('jira:api2', 'api/2'), module('jira:api', 'api'), module('x:files', 'files/1')]);
const ops = [
  op('jira:api2', 'GET', 'issue/{issueIdOrKey}'),
  op('jira:api2', 'POST', 'issue/{issueIdOrKey}'),
  op('jira:api2', 'GET', 'issue/createmeta'),
  op('jira:api2', 'GET', 'issue/{issueIdOrKey}/comment/{id: [0-9]+}'),
  op('jira:api2', 'GET', 'issue/{issueIdOrKey}/comment/{name}'),
  op('jira:api', 'GET', 'thing'),
  op('x:files', 'GET', 'download/{path: .+}'),
  op('x:files', 'GET', 'list/{path:.*}'),
];
const m = createMatcher(s, index(ops));

describe('routes fallbacks', () => {
  it('matches without throwing when a template regex does not compile in combination', () => {
    // a group name that collides with the generated ones: valid alone, invalid combined
    const mm = createMatcher(summary([module('m', 'api')]), index([op('m', 'GET', 'a/{x: [0-9]+}-{y: (?<p0>z)}')]));
    expect(mm.match('/rest/api/a/1-z')?.values).toEqual({ x: '1', y: 'z' });
  });

  it('returns null instead of throwing for an unusable baseUrl', () => {
    const mm = createMatcher(summary([module('m', 'api')], { baseUrl: 'http://[bad' }), index([op('m', 'GET', 'a')]));
    expect(mm.match('/rest/api/a')).toBeNull();
  });
});

describe('routes robustness', () => {
  it('works with a relative, an empty and an absolute baseUrl', () => {
    for (const baseUrl of ['/jira', '', 'http://host/jira']) {
      const prefix = baseUrl.replace(/^https?:\/\/host/, '');
      const mm = createMatcher(summary([module('m', 'api/2')], { baseUrl }), index([op('m', 'GET', 'a/{k}')]));
      expect(mm.match(`${prefix}/rest/api/2/a/1`)?.values.k).toBe('1');
      expect(mm.match('rest/api/2/a/2')?.values.k).toBe('2');
      expect(mm.match('http://[bad')).toBeNull();
    }
  });

  it('survives Java-only regexes', () => {
    const mm = createMatcher(summary([module('m', 'api/2')]), index([
      op('m', 'GET', 'a/{x: (?i)abc}'),
      op('m', 'GET', 'b/{x: [a-z]++}'),
      op('m', 'GET', 'c/{x: \p{Alnum}+}/{y}'),
      op('m', 'GET', 'ok/{id}'),
    ]));
    expect(mm.match('/rest/api/2/ok/1')?.values.id).toBe('1');
    expect(mm.match('/rest/api/2/a/abc')?.values.x).toBe('abc');
    expect(mm.match('/rest/api/2/b/zz')?.values.x).toBe('zz');
  });

  it('matches an operation at the module root', () => {
    expect(splitSegments('')).toEqual([]);
    const mm = createMatcher(summary([module('m', 'api/2')]), index([op('m', 'GET', ''), op('m', 'GET', 'x')]));
    expect(mm.match('/jira/rest/api/2')?.op.path).toBe('');
    expect(mm.match('/jira/rest/api/2/')?.op.path).toBe('');
    expect(mm.match('/jira/rest/api/2/x')?.op.path).toBe('x');
  });
});

describe('routes', () => {
  it('matches a full URL and returns values and query', () => {
    const r = m.match('http://localhost/jira/rest/api/2/issue/PROJ-42?fields=a&fields=b&expand=x%20y')!;
    expect(r.op.method).toBe('GET');
    expect(r.op.path).toBe('issue/{issueIdOrKey}');
    expect(r.values).toEqual({ issueIdOrKey: 'PROJ-42' });
    expect(r.query).toEqual({ fields: ['a', 'b'], expand: ['x y'] });
  });

  it('matches base-relative and root-relative URLs', () => {
    expect(m.match('/rest/api/2/issue/A-1')?.values.issueIdOrKey).toBe('A-1');
    expect(m.match('rest/api/2/issue/A-1/')?.values.issueIdOrKey).toBe('A-1');
    expect(m.match('/jira/rest/api/2/issue/A-1')?.values.issueIdOrKey).toBe('A-1');
  });

  it('prefers literal segments over templates', () => {
    expect(m.match('/rest/api/2/issue/createmeta')!.op.path).toBe('issue/createmeta');
  });

  it('honours regex templates and falls back to the plain one', () => {
    expect(m.match('/rest/api/2/issue/A-1/comment/123')!.op.path).toContain('{id: [0-9]+}');
    expect(m.match('/rest/api/2/issue/A-1/comment/abc')!.op.path).toContain('{name}');
  });

  it('matches the rest of the path for .+ and .*', () => {
    expect(m.match('/rest/files/1/download/a/b%20c/d.txt')!.values.path).toBe('a/b c/d.txt');
    expect(m.match('/rest/files/1/download')).toBeNull();
    expect(m.match('/rest/files/1/list')!.values.path).toBe('');
    expect(m.match('/rest/files/1/list/x/y')!.values.path).toBe('x/y');
  });

  it('picks the module with the longest matching path', () => {
    expect(m.match('/rest/api/thing')!.op.module).toBe('jira:api');
    expect(m.match('/rest/api/2/thing')).toBeNull();
  });

  it('returns null for foreign URLs and unknown routes', () => {
    expect(m.match('http://other/jira/rest/api/2/issue/A-1')).toBeNull();
    expect(m.match('/secure/Dashboard.jspa')).toBeNull();
    expect(m.match('/rest/api/2/nope')).toBeNull();
  });

  it('ignores matrix parameters and fragments', () => {
    expect(m.match('/rest/api/2/issue/A-1;a=b#x')?.values.issueIdOrKey).toBe('A-1');
  });

  it('prefers GET when several methods share a path', () => {
    expect(m.match('/rest/api/2/issue/A-1')!.op.method).toBe('GET');
  });

  it('reads query and path names that Object.prototype also has', () => {
    const r = m.match('/rest/api/2/issue/A-1?toString=1&constructor=2&__proto__=3&toString=4')!;
    expect(Object.entries(r.query)).toEqual([['toString', ['1', '4']], ['constructor', ['2']], ['__proto__', ['3']]]);
    const mm = createMatcher(summary([module('m', 'api')]), index([op('m', 'GET', 'a/{__proto__}/{constructor}')]));
    expect(Object.entries(mm.match('/rest/api/a/x/y')!.values)).toEqual([['__proto__', 'x'], ['constructor', 'y']]);
  });
});
