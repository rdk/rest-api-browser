import { describe, expect, it } from 'vitest';
import { pathParts, searchWords } from './pathparts';

const show = (parts: ReturnType<typeof pathParts>) => parts.map((p) => (p.hit ? `[${p.kind}:${p.text}]!` : `[${p.kind}:${p.text}]`)).join('');

describe('pathParts', () => {
  it('tells separators, templates and versions from resource words', () => {
    expect(show(pathParts('/issue/{issueIdOrKey}/comment'))).toBe(
      '[sep:/][text:issue][sep:/][param:{issueIdOrKey}][sep:/][text:comment]');
    expect(show(pathParts('api/2/serverInfo', { prefix: 5 }))).toBe('[mod:api][sep:/][ver:2][sep:/][text:serverInfo]');
    expect(show(pathParts('activities/1.0'))).toBe('[text:activities][sep:/][ver:1.0]');
    expect(show(pathParts('x/latest/v3/v3a'))).toBe('[text:x][sep:/][ver:latest][sep:/][ver:v3][sep:/][text:v3a]');
  });

  it('keeps a slash inside a template regex in the template', () => {
    expect(show(pathParts('file/{path: .+/x}'))).toBe('[text:file][sep:/][param:{path: .+/x}]');
  });

  it('marks the search words, case-insensitively, also inside templates', () => {
    expect(show(pathParts('/issue/{issueIdOrKey}', { words: ['ISSUE'] }))).toBe(
      '[sep:/][text:issue]![sep:/][param:{][param:issue]![param:IdOrKey}]');
    // punctuation alone marks nothing
    expect(show(pathParts('/a/b', { words: ['/'] }))).toBe('[sep:/][text:a][sep:/][text:b]');
    expect(searchWords('  post  Issue ')).toEqual(['post', 'issue']);
  });

  it('gives back the path unchanged', () => {
    for (const p of ['', '/', 'a//b', '{x}', 'x/{a}{b}/1.0/', 'api/2/issue/{issueIdOrKey}/properties/{propertyKey}']) {
      expect(pathParts(p, { prefix: 3, words: ['a', 'pro'] }).map((x) => x.text).join('')).toBe(p);
    }
  });
});
