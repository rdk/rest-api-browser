export interface JsonLine {
  depth: number;
  text: string;
  foldEnd?: number;   // on an opening line: index of its closing line
}

export interface LineModel {
  lines: JsonLine[];
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

// Scans the text once and writes it out pretty-printed, one entry per line. It works on the source
// text rather than on JSON.parse output so big numbers and key order survive unchanged.
export function buildLines(text: string): LineModel | null {
  const n = text.length;
  const lines: JsonLine[] = [];
  const stack: { line: number; array: boolean }[] = [];
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

  const push = (text: string): number => lines.push({ depth: stack.length, text }) - 1;

  try {
    for (;;) {
      skipWs();
      let prefix = '';
      const top = stack[stack.length - 1];
      if (top && !top.array) {
        if (text[i] !== '"') return null;
        const key = readString();
        if (key === null) return null;
        skipWs();
        if (text[i++] !== ':') return null;
        skipWs();
        prefix = key + ': ';
      }
      const c = text[i];
      if (c === '{' || c === '[') {
        const close = c === '{' ? '}' : ']';
        i++;
        skipWs();
        if (text[i] === close) {
          i++;
          push(prefix + c + close);
        } else {
          stack.push({ line: push(prefix + c), array: c === '[' });
          continue;
        }
      } else {
        const scalar = readScalar();
        if (scalar === null) return null;
        push(prefix + scalar);
      }

      // After a complete value: a comma, or close containers until a comma is found.
      for (;;) {
        skipWs();
        const t = text[i];
        if (!stack.length) {
          if (i < n) return null;
          return { lines };
        }
        if (t === ',') {
          lines[lines.length - 1].text += ',';
          i++;
          break;
        }
        const open = stack[stack.length - 1];
        if (t !== (open.array ? ']' : '}')) return null;
        i++;
        stack.pop();
        const closing = push(open.array ? ']' : '}');
        lines[open.line].foldEnd = closing;
      }
    }
  } catch {
    return null;
  }
}

// A collapsed line hides everything up to and including its closing line. The viewer draws the
// placeholder itself and can read a trailing comma from lines[foldEnd].text.
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
