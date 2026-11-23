import { describe, expect, it } from 'vitest';
import { findRows, rowEnd, wrapRows } from './textrows';

const texts = (t: string, cols: number) => {
  const rows = wrapRows(t, cols);
  return Array.from({ length: rows.count }, (_, i) => [rows.lines[i], t.slice(rows.starts[i], rowEnd(rows, i, t.length))]);
};

describe('wrapRows', () => {
  it('starts each line on a new row and wraps long ones at the width', () => {
    expect(texts('abcdefg\nhi\n\nxyz', 3)).toEqual([[0, 'abc'], [0, 'def'], [0, 'g'], [1, 'hi'], [2, ''], [3, 'xyz']]);
  });
  it('keeps an empty text and a final newline as rows, like the lines an editor shows', () => {
    expect(texts('', 10)).toEqual([[0, '']]);
    expect(texts('a\n', 10)).toEqual([[0, 'a'], [1, '']]);
  });
  it('splits a line of exactly the width into one row', () => {
    expect(texts('abcdef', 3)).toEqual([[0, 'abc'], [0, 'def']]);
  });
  it('handles a megabyte line without one string per row', () => {
    const rows = wrapRows('x'.repeat(1_000_000), 100);
    expect(rows.count).toBe(10_000);
    expect(rows.starts[9_999]).toBe(999_900);
  });
});

describe('findRows', () => {
  it('finds a match that the end of a row cuts in two, on the row where it starts', () => {
    const t = 'aaaneedlebbb';
    expect(findRows(t, wrapRows(t, 5), 'needle')).toEqual([0]);
  });
  it('is case-insensitive, lists each row once and takes the needle literally', () => {
    const t = 'A.b a.B\nxa.bx\nnothing';
    expect(findRows(t, wrapRows(t, 100), 'a.b')).toEqual([0, 1]);
    expect(findRows(t, wrapRows(t, 100), '(')).toEqual([]);
    expect(findRows(t, wrapRows(t, 100), '')).toEqual([]);
  });
});
