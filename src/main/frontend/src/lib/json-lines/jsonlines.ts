export interface JsonLine {
  depth: number;
  text: string;
  foldEnd?: number;   // on an opening line: index of its closing line
}

export interface LineModel {
  lines: JsonLine[];
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * What scan() meets, in order. `key` is the member's name as written (quotes and escapes included), null in an
 * array or at the top; `raw` is the value as written and `start`/`end` are its exact half-open source slice.
 */
interface Visitor {
  value(key: string | null, raw: string, start: number, end: number): void;   // a scalar, or "{}" or "[]"
  open(key: string | null, bracket: '{' | '[', start: number): void;          // start: where the bracket is
  close(bracket: '}' | ']', end: number): void;                               // end: just after the bracket
  comma(): void;
}

// Reads the text once, checking that it is JSON, and tells the visitor what it meets. It works on the source text
// rather than on JSON.parse output, so big numbers, escapes, key order and duplicate keys survive unchanged.
// False when the text is not JSON.
function scan(text: string, visitor: Visitor): boolean {
  const n = text.length;
  const arrays: boolean[] = [];   // the containers we are in: true for an array, false for an object
  let i = 0;

  const skipWs = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) i++;
      else break;
    }
  };

  // Returns the raw slice of a string token starting at i, or null if malformed.
  const readString = (): string | null => {
    const start = i++;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) return text.slice(start, ++i);
      if (c < 32) return null;
      if (c === 92) {
        const e = text[i + 1];
        if (e === undefined || !'"\\/bfnrtu'.includes(e)) return null;
        if (e === 'u' && !/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) return null;
        i += 2;
      } else i++;
    }
    return null;
  };

  const readScalar = (): string | null => {
    const c = text[i];
    if (c === '"') return readString();
    for (const lit of ['true', 'false', 'null']) {
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return lit;
      }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };

  for (;;) {
    skipWs();
    let key: string | null = null;
    if (arrays.length && !arrays[arrays.length - 1]) {
      if (text[i] !== '"') return false;
      key = readString();
      if (key === null) return false;
      skipWs();
      if (text[i++] !== ':') return false;
      skipWs();
    }
    const start = i;
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++;
      skipWs();
      if (text[i] === close) {
        i++;
        visitor.value(key, c + close, start, i);
      } else {
        visitor.open(key, c, start);
        arrays.push(c === '[');
        continue;
      }
    } else {
      const scalar = readScalar();
      if (scalar === null) return false;
      visitor.value(key, scalar, start, i);
    }

    // After a complete value: a comma, or close containers until a comma is found.
    for (;;) {
      skipWs();
      if (!arrays.length) return i >= n;
      const t = text[i];
      if (t === ',') {
        visitor.comma();
        i++;
        break;
      }
      const close = arrays[arrays.length - 1] ? ']' : '}';
      if (t !== close) return false;
      i++;
      arrays.pop();
      visitor.close(close, i);
    }
  }
}

/** Builds a foldable line model from valid JSON text while keeping numbers, key order and escapes intact. */
export function buildLines(text: string): LineModel | null {
  const lines: JsonLine[] = [];
  const open: number[] = [];   // the opening line of each container we are in
  const push = (line: string): number => lines.push({ depth: open.length, text: line }) - 1;
  const ok = scan(text, {
    value: (key, raw) => void push(key === null ? raw : key + ': ' + raw),
    open: (key, bracket) => void open.push(push(key === null ? bracket : key + ': ' + bracket)),
    close: (bracket) => {
      const line = open.pop()!;
      lines[line].foldEnd = push(bracket);
    },
    comma: () => void (lines[lines.length - 1].text += ','),
  });
  return ok ? { lines } : null;
}

/**
 * formatJson's output budget, in characters: deep nesting multiplies the indentation (1,000 levels of a 2 KB value
 * is 2 MB per line), and a string of hundreds of megabytes freezes or crashes the tab.
 */
export const FORMAT_MAX = 32 * 1024 * 1024;

/**
 * The text pretty-printed as JSON.stringify(JSON.parse(text), null, 2) prints it, but without losing anything:
 * numbers, string escapes, key order and duplicate keys stay as written. Null when the text is not JSON, or when the
 * result would be longer than `max` characters (FORMAT_MAX).
 */
export function formatJson(text: string, max = FORMAT_MAX): string | null {
  const model = buildLines(text);
  if (!model) return null;
  let size = 0;
  for (const l of model.lines) if ((size += l.depth * 2 + l.text.length + 1) > max) return null;
  const indents: string[] = [];
  return model.lines.map((l) => (indents[l.depth] ??= '  '.repeat(l.depth)) + l.text).join('\n');
}

/**
 * The text with the values of the members `hide` picks replaced by `mask` (a JSON string, quotes included), everything
 * else as written. A string value is hidden when `hide` picks its name; any other value (a number, an array, an
 * object, all of it) when `hideAny` does. Null, "" and whitespace-only strings are left alone. Null when not JSON.
 */
export function maskJson(
  text: string,
  hide: (name: string) => boolean,
  mask: string,
  hideAny: (name: string) => boolean = hide,
): { text: string; masked: number } | null {
  const cuts: [number, number][] = [];
  let depth = 0;
  let hidden: { from: number; depth: number } | null = null;   // the container being hidden whole
  const name = (key: string) => (!key.includes('\\') ? key.slice(1, -1) : (JSON.parse(key) as string));   // a string token as written, decoded
  const ok = scan(text, {
    value: (key, raw, start, end) => {
      if (hidden || key === null || raw === 'null') return;
      if (raw[0] === '"' ? hide(name(key)) && name(raw).trim() !== '' : hideAny(name(key))) cuts.push([start, end]);
    },
    open: (key, _bracket, start) => {
      depth++;
      if (!hidden && key !== null && hideAny(name(key))) hidden = { from: start, depth };
    },
    close: (_bracket, end) => {
      if (hidden && hidden.depth === depth) {
        cuts.push([hidden.from, end]);
        hidden = null;
      }
      depth--;
    },
    comma: () => undefined,
  });
  if (!ok) return null;
  let out = '';
  let last = 0;
  for (const [from, to] of cuts) {
    out += text.slice(last, from) + mask;
    last = to;
  }
  return { text: out + text.slice(last), masked: cuts.length };
}

/** Visible line indices of a foldable line model, skipping collapsed container interiors. */
export function visibleLines(model: LineModel, collapsed: Set<number>): number[] {
  const out: number[] = [];
  const { lines } = model;
  for (let i = 0; i < lines.length; i++) {
    out.push(i);
    const end = lines[i].foldEnd;
    if (end !== undefined && collapsed.has(i)) i = end;
  }
  return out;
}

const lowered = new WeakMap<LineModel, string[]>();

/** Case-insensitive line indices containing `needle`. */
export function find(model: LineModel, needle: string): number[] {
  const out: number[] = [];
  const n = needle.toLowerCase();
  if (!n) return out;
  let lower = lowered.get(model);
  if (!lower) lowered.set(model, (lower = model.lines.map((l) => l.text.toLowerCase())));
  for (let i = 0; i < lower.length; i++) {
    if (lower[i].includes(n)) out.push(i);
  }
  return out;
}
