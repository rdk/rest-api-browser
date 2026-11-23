/** Raw text wrapped into rows of a fixed number of characters, and the find over it (Response's Raw view). */

/** The rows of a text wrapped at `cols` characters: where each starts in the text and its line's number. */
export interface Rows { starts: Int32Array; lines: Int32Array; count: number }

/**
 * Wraps a text into rows of at most `cols` characters, each line starting a new row. Two passes (count, then fill)
 * into typed arrays, so millions of rows cost a few bytes each, and the text itself is sliced only when a row shows.
 */
export function wrapRows(text: string, cols: number): Rows {
  const width = Math.max(1, cols);
  let count = 0;
  for (let start = 0; ; ) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    for (let s = start; ; ) {
      count++;
      s = next(text, s, width, end);
      if (s >= end) break;
    }
    if (end >= text.length) break;
    start = end + 1;
  }
  const starts = new Int32Array(count);
  const lines = new Int32Array(count);
  let r = 0;
  for (let start = 0, line = 0; ; line++) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    let s = start;
    do {
      starts[r] = s;
      lines[r] = line;
      r++;
      s = next(text, s, width, end);
    } while (s < end);
    if (end >= text.length) break;
    start = end + 1;
  }
  return { starts, lines, count };
}

/**
 * Where the row after the one starting at `s` starts: `width` characters on, but never between the two halves of a
 * surrogate pair (an emoji would show as two broken characters).
 */
function next(text: string, s: number, width: number, end: number): number {
  let n = s + width;
  if (n < end && n > s + 1) {
    const c = text.charCodeAt(n);
    if (c >= 0xdc00 && c <= 0xdfff) n--;
  }
  return n;
}

/** Where row i ends in the text: the next row's start, or the newline before it. */
export const rowEnd = (rows: Rows, i: number, length: number) =>
  i + 1 < rows.count ? (rows.lines[i + 1] === rows.lines[i] ? rows.starts[i + 1] : rows.starts[i + 1] - 1) : length;

/**
 * The rows where a case-insensitive match of the needle starts, searched in the whole text, so a match that a row's
 * end cuts in two is found too.
 */
export function findRows(text: string, rows: Rows, needle: string): number[] {
  if (!needle) return [];
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const found: number[] = [];
  let r = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    while (r + 1 < rows.count && rows.starts[r + 1] <= m.index) r++; // matches come in order: the row only moves on
    if (found[found.length - 1] !== r) found.push(r);
  }
  return found;
}
