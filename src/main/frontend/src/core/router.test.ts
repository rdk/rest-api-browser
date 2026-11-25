import { describe, expect, it } from 'vitest';
import { formatState, parseState } from './router';

describe('router', () => {
  it('parses op, path, q (repeated, ordered) and h', () => {
    const s = parseState('?op=jira%3AGET%3Aissue%2F%7B%7D&path.issueIdOrKey=A-1&q.expand=a&q.expand=b&q.fields=x%20y&h.X-A=1');
    expect(s).toEqual({
      op: 'jira:GET:issue/{}',
      path: { issueIdOrKey: 'A-1' },
      q: { expand: ['a', 'b'], fields: ['x y'] },
      h: { 'X-A': '1' },
    });
  });

  it('round-trips awkward characters', () => {
    const state = { op: 'm:POST:a/{}#json', path: { 'a.b': 'x&y=z/ü' }, q: { e: ['1', '', '2'] }, h: { 'X-A': '%' } };
    expect(parseState(formatState(state))).toEqual(state);
  });

  it('formats empty state as an empty string and keeps repeated order', () => {
    expect(formatState({ path: {}, q: {}, h: {} })).toBe('');
    expect(formatState({ op: 'k', path: {}, q: { e: ['b', 'a'] }, h: {} })).toBe('?op=k&q.e=b&q.e=a');
  });

  it('ignores unknown keys and tolerates no leading ?', () => {
    expect(parseState('foo=1&op=k')).toEqual({ op: 'k', path: {}, q: {}, h: {} });
    expect(parseState('')).toEqual({ path: {}, q: {}, h: {} });
  });

  it('takes parameter names that Object.prototype also has', () => {
    const s = parseState('?q.toString=x&q.constructor=1&q.__proto__=y&path.hasOwnProperty=p&h.__proto__=h&q.toString=z');
    expect(Object.entries(s.q)).toEqual([['toString', ['x', 'z']], ['constructor', ['1']], ['__proto__', ['y']]]);
    expect(Object.entries(s.path)).toEqual([['hasOwnProperty', 'p']]);
    expect(Object.entries(s.h)).toEqual([['__proto__', 'h']]);
    expect(parseState(formatState(s))).toEqual(s);
  });

  it('parses and formats form.* parameters safely, including Object.prototype names', () => {
    const s = parseState('?op=m%3APOST%3Ax&form.a=1&form.a=2&form.__proto__=p&form.toString=t');
    expect(Object.entries(s.form!)).toEqual([['a', ['1', '2']], ['__proto__', ['p']], ['toString', ['t']]]);
    expect(parseState(formatState(s))).toEqual(s);
  });
});
