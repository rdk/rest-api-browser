import { describe, expect, it } from 'vitest';
import { createMatcher } from './routes';
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

describe('routes', () => {
  it('matches a full URL and returns values and query', () => {
    const r = m.match('http://host/jira/rest/api/2/issue/PROJ-42?fields=a&fields=b&expand=x%20y')!;
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
});
