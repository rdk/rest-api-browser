// Java text as the Java tab shows it: annotations and types split into coloured tokens, long annotations laid out
// one member per line. Not a Java parser: it reads what OperationDetails writes (annotations as source would write
// them, generic type names) and falls back to plain tokens for anything else.

/**
 * ann "@Operation"; member "summary" (before "="); type "String"; kw public, class, true; str "x"; num 5, 1.0f and
 * constants (MAX_VALUE, Policy.RUNTIME); punct ( ) { } , = < > .
 */
export type TokenKind = 'ann' | 'member' | 'type' | 'kw' | 'str' | 'num' | 'punct' | 'name' | 'space';
export interface Token { text: string; kind: TokenKind; }

const KEYWORDS = new Set([
  'public', 'protected', 'private', 'static', 'final', 'abstract', 'synchronized', 'native', 'default', 'transient',
  'volatile', 'strictfp', 'throws', 'class', 'interface', 'enum', 'record', 'extends', 'super', 'true', 'false', 'null',
  'void', 'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double',
]);
const TOKEN = /("(?:[^"\\]|\\.)*"?)|('(?:[^'\\]|\\.)*'?)|(@[\w$.]+)|(-?\d[\w.]*)|([A-Za-z_$][\w$]*)|(\s+)|(.)/g;

// The token before index k that is not a space, or -1.
function before(out: Token[], k: number): number {
  let i = k - 1;
  while (i >= 0 && out[i].kind === 'space') i--;
  return i;
}

/**
 * Whether an all-caps name is a constant: one with an underscore (MAX_VALUE), or a member of a type
 * (MediaType.APPLICATION_JSON, RetentionPolicy.RUNTIME). Otherwise it is a type, as URI, URL, UUID or JSON are.
 */
function isConstant(text: string, out: Token[]): boolean {
  if (!/^[A-Z_$][A-Z0-9_$]*$/.test(text) || !/[A-Z]/.test(text)) return false;
  if (text.includes('_')) return true;
  const dot = before(out, out.length);
  if (dot < 0 || out[dot].text !== '.') return false;
  const owner = before(out, dot);
  return owner >= 0 && (out[owner].kind === 'type' || out[owner].kind === 'num') && /^[A-Z]/.test(out[owner].text);
}

/** Splits Java text into tokens; an identifier right before "=" is a member, a capitalised one a type (see isConstant). */
export function tokenize(s: string): Token[] {
  const out: Token[] = [];
  for (const m of s.matchAll(TOKEN)) {
    const [text, str, chr, ann, num, ident, space] = m;
    if (str !== undefined || chr !== undefined) out.push({ text, kind: 'str' });
    else if (ann !== undefined) out.push({ text, kind: 'ann' });
    else if (num !== undefined) out.push({ text, kind: 'num' });
    else if (ident !== undefined) {
      const rest = s.slice(m.index! + text.length);
      const kind: TokenKind = KEYWORDS.has(text) ? 'kw' : /^\s*=(?!=)/.test(rest) ? 'member'
        : isConstant(text, out) ? 'num' : /^[A-Z]/.test(text) ? 'type' : 'name';
      out.push({ text, kind });
    } else if (space !== undefined) out.push({ text: ' ', kind: 'space' });
    else out.push({ text, kind: 'punct' });
  }
  return out;
}

// ---- annotations: a small tree, laid out flat when it fits, else one member per line

type Node =
  | { t: 'ann'; name: string; value?: Node; members?: [string, Node][] }
  | { t: 'arr'; items: Node[] }
  | { t: 'atom'; tokens: Token[] };

class Parser {
  private i = 0;
  constructor(private readonly toks: Token[]) {}

  done(): boolean {
    return this.i >= this.toks.length;
  }

  private peek(k = 0): Token | undefined {
    return this.toks[this.i + k];
  }

  private take(text?: string): Token {
    const t = this.toks[this.i];
    if (!t || (text !== undefined && t.text !== text)) throw new Error('unexpected ' + (t?.text ?? 'end'));
    this.i++;
    return t;
  }

  value(): Node {
    const t = this.peek();
    if (!t) throw new Error('unexpected end');
    if (t.kind === 'ann') return this.ann();
    if (t.text === '{') {
      this.take('{');
      const items: Node[] = [];
      while (this.peek()?.text !== '}') {
        items.push(this.value());
        if (this.peek()?.text === ',') this.take(',');
        else break;
      }
      this.take('}');
      return { t: 'arr', items };
    }
    const tokens: Token[] = [];
    while (this.peek() && ![',', ')', '}'].includes(this.peek()!.text)) tokens.push(this.take());
    if (!tokens.length) throw new Error('empty value');
    return { t: 'atom', tokens };
  }

  ann(): Node {
    const name = this.take().text;
    if (this.peek()?.text !== '(') return { t: 'ann', name };
    this.take('(');
    if (this.peek()?.kind === 'member') {
      const members: [string, Node][] = [];
      for (;;) {
        const m = this.take().text;
        this.take('=');
        members.push([m, this.value()]);
        if (this.peek()?.text === ',') this.take(',');
        else break;
      }
      this.take(')');
      return { t: 'ann', name, members };
    }
    const value = this.peek()?.text === ')' ? undefined : this.value();
    this.take(')');
    return { t: 'ann', name, value };
  }
}

const tok = (text: string, kind: TokenKind): Token => ({ text, kind });

function flat(n: Node): Token[] {
  if (n.t === 'atom') return n.tokens;
  if (n.t === 'arr') {
    const out: Token[] = [tok('{', 'punct')];
    n.items.forEach((it, i) => out.push(...(i ? [tok(',', 'punct'), tok(' ', 'space')] : []), ...flat(it)));
    return [...out, tok('}', 'punct')];
  }
  const out: Token[] = [tok(n.name, 'ann')];
  if (n.members) {
    out.push(tok('(', 'punct'));
    n.members.forEach(([m, v], i) => {
      if (i) out.push(tok(',', 'punct'), tok(' ', 'space'));
      out.push(tok(m, 'member'), tok(' = ', 'punct'), ...flat(v));
    });
    out.push(tok(')', 'punct'));
  } else if (n.value) {
    out.push(tok('(', 'punct'), ...flat(n.value), tok(')', 'punct'));
  }
  return out;
}

const width = (ts: Token[]) => ts.reduce((w, t) => w + t.text.length, 0);
const nl = (indent: number) => tok('\n' + ' '.repeat(indent), 'space');

/** `indent` is the indentation of the current line, `col` the column the node starts at (after "name = "). */
function layout(n: Node, indent: number, col: number, max: number): Token[] {
  const f = flat(n);
  if (col + width(f) <= max) return f;
  if (n.t === 'atom') return n.tokens.length === 1 && n.tokens[0].kind === 'str' ? splitString(n.tokens[0].text, col) : f;
  const inner = indent + 4;
  if (n.t === 'arr') {
    const out: Token[] = [tok('{', 'punct')];
    n.items.forEach((it, i) => out.push(nl(inner), ...layout(it, inner, inner, max), ...(i < n.items.length - 1 ? [tok(',', 'punct')] : [])));
    return [...out, nl(indent), tok('}', 'punct')];
  }
  if (!n.members) {
    return n.value ? [tok(n.name, 'ann'), tok('(', 'punct'), ...layout(n.value, indent, col + n.name.length + 1, max), tok(')', 'punct')] : f;
  }
  const out: Token[] = [tok(n.name, 'ann'), tok('(', 'punct')];
  n.members.forEach(([m, v], i) => {
    out.push(nl(inner), tok(m, 'member'), tok(' = ', 'punct'), ...layout(v, inner, inner + m.length + 3, max));
    if (i < n.members!.length - 1) out.push(tok(',', 'punct'));
  });
  return [...out, nl(indent), tok(')', 'punct')];
}

/**
 * A long string literal with line breaks (\n escapes) as Java source would lay it out: one concatenated part per
 * line, aligned at the column it starts at. Without breaks, or clipped (no closing quote), it stays one token.
 */
function splitString(text: string, col: number): Token[] {
  if (text.length < 2 || !text.endsWith('"')) return [tok(text, 'str')];
  const parts = text.slice(1, -1).split(/(?<=(?<!\\)\\n)/).filter(Boolean);
  if (parts.length < 2) return [tok(text, 'str')];
  const out: Token[] = [];
  parts.forEach((part, i) => {
    if (i) out.push(tok(' +', 'punct'), nl(col));
    out.push(tok('"' + part + '"', 'str'));
  });
  return out;
}

/**
 * Tokens as lines: split where a space token holds a line break, each line with the indentation it starts with
 * (taken off its tokens), so a renderer can wrap a long line with a hanging indent instead of at column 0.
 */
export function toLines(tokens: Token[]): { indent: number; tokens: Token[] }[] {
  const lines: { indent: number; tokens: Token[] }[] = [{ indent: 0, tokens: [] }];
  for (const t of tokens) {
    if (t.kind === 'space' && t.text.includes('\n')) {
      const after = t.text.slice(t.text.lastIndexOf('\n') + 1);
      lines.push({ indent: after.length, tokens: [] });
    } else {
      lines[lines.length - 1].tokens.push(t);
    }
  }
  return lines;
}

/**
 * An annotation in coloured tokens, laid out one member per line (nested ones too) when it is wider than `max`
 * characters. Text it cannot read (a clipped annotation) comes back as plain tokens.
 */
export function annotationTokens(s: string, max = 80): Token[] {
  const toks = tokenize(s).filter((t) => t.kind !== 'space');
  try {
    const p = new Parser(toks);
    const node = p.ann();
    if (!p.done()) throw new Error('trailing text');
    return layout(node, 0, 0, max);
  } catch {
    return tokenize(s);
  }
}
