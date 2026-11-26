/** Soft-wrapped plain-text row index: Int32Array avoids per-row string allocation on large payloads. */
export interface Rows {
  count: number;
  lines: Int32Array;   // 0-based line number each row belongs to
  starts: Int32Array;  // start offset in `text` of each row (its end is the next row's start, or line end)
}

/** Splits `text` into display rows wrapped at `cols` UTF-16 units without splitting surrogate pairs. */
export function wrapRows(text: string, cols: number): Rows {
  const width = cols === Number.POSITIVE_INFINITY
    ? Math.max(1, text.length)
    : Number.isFinite(cols)
      ? Math.max(1, Math.floor(cols))
      : 1;
  let cap = 64;
  let lines = new Int32Array(cap);
  let starts = new Int32Array(cap);
  let count = 0;
  const push = (line: number, start: number) => {
    if (count === cap) {
      cap *= 2;
      const nl = new Int32Array(cap);
      nl.set(lines);
      lines = nl;
      const ns = new Int32Array(cap);
      ns.set(starts);
      starts = ns;
    }
    lines[count] = line;
    starts[count] = start;
    count++;
  };

  let line = 0;
  let i = 0;
  while (i <= text.length) {
    const nl = text.indexOf('\n', i);
    const end = nl < 0 ? text.length : nl;
    if (i === end) {
      push(line, i);
    } else {
      let at = i;
      while (at < end) {
        push(line, at);
        let next = Math.min(at + width, end);
        // keep a high surrogate with its low surrogate instead of splitting a pair across rows
        if (next < end && next > at + 1) {
          const code = text.charCodeAt(next - 1);
          if (code >= 0xd800 && code <= 0xdbff) next--;
        }
        at = next;
      }
    }
    if (nl < 0) break;
    line++;
    i = nl + 1;
  }
  if (cap > 1024 && count * 4 < cap * 3) {
    return { count, lines: lines.slice(0, count), starts: starts.slice(0, count) };
  }
  return { count, lines: lines.subarray(0, count), starts: starts.subarray(0, count) };
}

const lowerCache = new WeakMap<Rows, { text: string; lower: string }>();

/** End offset (exclusive) in `text` of row `row`, trimming the trailing `\n` when the next row starts a new line. */
export function rowEnd(rows: Rows, row: number, textLength: number): number {
  if (row + 1 >= rows.count) return textLength;
  return rows.starts[row + 1] - (rows.lines[row + 1] === rows.lines[row] ? 0 : 1);
}

/** Case-insensitive row indices where literal occurrences of `needle` start. */
export function findRows(text: string, rows: Rows, needle: string): number[] {
  const n = needle.toLowerCase();
  if (!n) return [];
  let cached = lowerCache.get(rows);
  if (!cached || cached.text !== text) {
    cached = { text, lower: text.toLowerCase() };
    lowerCache.set(rows, cached);
  }
  const { lower } = cached;
  const out: number[] = [];
  const { starts, count } = rows;
  let r = 0;
  for (let i = lower.indexOf(n); i >= 0; i = lower.indexOf(n, i + 1)) {
    while (r + 1 < count && starts[r + 1] <= i) r++;
    if (out[out.length - 1] !== r) out.push(r);
  }
  return out;
}
