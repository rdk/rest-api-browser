import { describe, expect, it } from 'vitest';
import { pathParts, searchWords } from './pathparts';
import { buildRequest, urlParts, type RequestValues } from './request';
import type { Operation, Summary } from './types';

const show = (parts: { text: string; kind: string; hit?: boolean }[]) =>
  parts.map((p) => (p.hit ? `[${p.kind}:${p.text}]!` : `[${p.kind}:${p.text}]`)).join('');

describe('pathParts', () => {
  it('tells separators, templates and versions apart; the first resource word leads, the second follows', () => {
    expect(show(pathParts('/issue/{issueIdOrKey}/comment/{id}/properties'))).toBe(
      '[sep:/][lead:issue][sep:/][param:{issueIdOrKey}][sep:/][sub:comment][sep:/][param:{id}][sep:/][text:properties]');
    expect(show(pathParts('api/2/serverInfo', { prefix: 5 }))).toBe('[mod:api][sep:/][ver:2][sep:/][lead:serverInfo]');
    expect(show(pathParts('activities/1.0', { rank: false }))).toBe('[text:activities][sep:/][ver:1.0]');
    expect(show(pathParts('x/latest/v3/v3a'))).toBe('[lead:x][sep:/][ver:latest][sep:/][ver:v3][sep:/][sub:v3a]');
    expect(show(pathParts('/{activityId}'))).toBe('[sep:/][param:{activityId}]');
  });

  it('keeps a slash inside a template regex in the template', () => {
    expect(show(pathParts('file/{path: .+/x}'))).toBe('[lead:file][sep:/][param:{path: .+/x}]');
  });

  it('marks the search words, case-insensitively, also inside templates', () => {
    expect(show(pathParts('/issue/{issueIdOrKey}', { words: ['ISSUE'] }))).toBe(
      '[sep:/][lead:issue]![sep:/][param:{][param:issue]![param:IdOrKey}]');
    // punctuation alone marks nothing
    expect(show(pathParts('/a/b', { words: ['/'], rank: false }))).toBe('[sep:/][text:a][sep:/][text:b]');
    expect(searchWords('  post  Issue ')).toEqual(['post', 'issue']);
  });

  it('gives back the path unchanged', () => {
    for (const p of ['', '/', 'a//b', '{x}', 'x/{a}{b}/1.0/', 'api/2/issue/{issueIdOrKey}/properties/{propertyKey}']) {
      expect(pathParts(p, { prefix: 3, words: ['a', 'pro'] }).map((x) => x.text).join('')).toBe(p);
    }
  });
});

const summary = {
  baseUrl: '/jira',
  modules: [{ id: 'm', path: 'api/2' }],
} as unknown as Summary;
const op: Operation = {
  key: 'k', module: 'm', method: 'GET', path: 'issue/{issueIdOrKey}/comment', consumes: [], produces: [],
  params: [{ name: 'issueIdOrKey', in: 'path', type: 'string', required: true }, { name: 'expand', in: 'query', type: 'string', required: false }],
};
const values = (path: Record<string, string>, query: Record<string, string[]> = {}): RequestValues =>
  ({ path, query, header: {}, matrix: {} });

describe('urlParts', () => {
  it('marks a missing path value as the template, and names it', () => {
    const { parts, missing } = urlParts(summary, op, values({}));
    expect(show(parts)).toBe('[base:/jira/rest/][mod:api][sep:/][ver:2][sep:/][lead:issue][sep:/][param:{issueIdOrKey}][sep:/][sub:comment]');
    expect(missing).toEqual(['issueIdOrKey']);
  });

  it('marks the filled values, path and query, and joins into the URL that is sent', () => {
    const v = values({ issueIdOrKey: 'A B' }, { expand: ['x&y'], other: [''] });
    const { parts, missing } = urlParts(summary, op, v);
    expect(missing).toEqual([]);
    expect(show(parts)).toBe(
      '[base:/jira/rest/][mod:api][sep:/][ver:2][sep:/][lead:issue][sep:/][value:A%20B][sep:/][sub:comment][qsep:?][qname:expand][qsep:=][qvalue:x%26y]');
    expect(parts.map((p) => p.text).join('')).toBe(buildRequest(summary, op, v).url);
  });
});
