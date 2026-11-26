import { scanJavaTokens, scanSourceLines, type ScannedSource, type Token, type TokenKind } from './javascan';

export type { ScannedSource, Token, TokenKind };

const KEYWORDS = new Set([
  'public', 'protected', 'private', 'static', 'final', 'abstract', 'synchronized', 'native', 'default', 'transient',
  'volatile', 'strictfp', 'throws', 'class', 'interface', 'enum', 'record', 'extends', 'super', 'true', 'false', 'null',
  'void', 'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double',
]);
const SOURCE_KEYWORDS = new Set([
  ...KEYWORDS,
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return', 'try', 'catch', 'finally',
  'throw', 'new', 'this', 'implements', 'import', 'package', 'instanceof', 'assert', 'yield', 'var', 'sealed', 'permits',
]);

/** Splits Java annotation/type expressions into coloured tokens in linear time. */
export function tokenize(s: string): Token[] {
  return scanJavaTokens(s, { keywords: KEYWORDS, markMembers: true, includeComments: false, collapseSpaces: true });
}

/** Splits decompiled Java source into coloured tokens, preserving indentation, newlines and comments. */
export function tokenizeSource(s: string): Token[] {
  return scanJavaTokens(s, { keywords: SOURCE_KEYWORDS, markMembers: false, includeComments: true, collapseSpaces: false });
}

/**
 * Splits decompiled Java source into lines and tracks whether each line begins inside a multiline block comment
 * or multiline text block, returning the full `ScannedSource` (including `codeWithoutComments`).
 */
export function splitSourceLines(source: string): ScannedSource {
  return scanSourceLines(source);
}

/** Tokenizes a single line of Java source given whether it begins inside a multiline block comment or text block. */
export function tokenizeSourceLine(line: string, startsInComment: boolean, startsInTextBlock = false): Token[] {
  if (startsInComment) {
    const end = line.indexOf('*/');
    if (end < 0) return line ? [{ text: line, kind: 'comment' }] : [];
    const head: Token = { text: line.slice(0, end + 2), kind: 'comment' };
    const rest = line.slice(end + 2);
    return rest ? [head, ...tokenizeSource(rest)] : [head];
  }
  if (startsInTextBlock) {
    let closeAt = -1;
    for (let i = 0; i + 2 < line.length; i++) {
      if (line[i] === '\\') {
        i++;
        continue;
      }
      if (line[i] === '"' && line[i + 1] === '"' && line[i + 2] === '"') {
        closeAt = i + 3;
        break;
      }
    }
    if (closeAt < 0) return line ? [{ text: line, kind: 'str' }] : [];
    const head: Token = { text: line.slice(0, closeAt), kind: 'str' };
    const rest = line.slice(closeAt);
    return rest ? [head, ...tokenizeSource(rest)] : [head];
  }
  return tokenizeSource(line);
}

// ---- annotations: a small tree, laid out flat when it fits, else one member per line

type Node =
  | { t: 'ann'; name: string; value?: Node; members?: [string, Node][] }
  | { t: 'arr'; items: Node[] }
  | { t: 'atom'; tokens: Token[] };

class Parser {
  private i = 0;
  constructor(private readonly toks: Token[]) {}

  private skipSpaces(): void {
    while (this.toks[this.i]?.kind === 'space') this.i++;
  }

  done(): boolean {
    this.skipSpaces();
    return this.i >= this.toks.length;
  }

  private peek(): Token | undefined {
    let k = this.i;
    while (this.toks[k]?.kind === 'space') k++;
    return this.toks[k];
  }

  private take(text?: string): Token {
    this.skipSpaces();
    const t = this.toks[this.i];
    if (!t || (text !== undefined && t.text !== text)) throw new Error('unexpected ' + (t?.text ?? 'end'));
    this.i++;
    return t;
  }

  value(): Node {
    this.skipSpaces();
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
    let paren = 0;
    let bracket = 0;
    while (this.i < this.toks.length) {
      const next = this.toks[this.i];
      if (next.kind !== 'space' && paren === 0 && bracket === 0 && (next.text === ',' || next.text === ')' || next.text === '}')) break;
      if (next.text === '(') paren++;
      else if (next.text === ')') {
        if (paren === 0) break;
        paren--;
      } else if (next.text === '[') bracket++;
      else if (next.text === ']') {
        if (bracket === 0) break;
        bracket--;
      }
      tokens.push(this.toks[this.i++]);
    }
    while (tokens.length && tokens[tokens.length - 1].kind === 'space') tokens.pop();
    if (!tokens.length || paren !== 0 || bracket !== 0) throw new Error('empty or unbalanced value');
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

// Splits a quoted JSON/Java string at unescaped `\n` escapes (handling arbitrary `\\` parity before `\n`).
function splitString(text: string, col: number): Token[] {
  if (text.length < 2 || !text.endsWith('"') || text.startsWith('"""')) return [tok(text, 'str')];
  const inner = text.slice(1, -1);
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== '\\') continue;
    if (inner[i + 1] === 'n') {
      const cut = i + 2;
      if (cut > start) parts.push(inner.slice(start, cut));
      start = cut;
    }
    i++; // skip the escaped character whether it was \ or n or anything else
  }
  if (start < inner.length) parts.push(inner.slice(start));
  if (parts.length < 2) return [tok(text, 'str')];
  const out: Token[] = [];
  parts.forEach((part, i) => {
    if (i) out.push(tok(' +', 'punct'), nl(col));
    out.push(tok('"' + part + '"', 'str'));
  });
  return out;
}

/** Splits formatted annotation tokens into lines with relative indentation. */
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

/** Lays out an annotation into coloured tokens, or returns plain tokens when malformed/clipped. */
export function annotationTokens(s: string, max = 80): Token[] {
  const all = tokenize(s);
  try {
    const p = new Parser(all);
    const node = p.ann();
    if (!p.done()) throw new Error('trailing text');
    return layout(node, 0, 0, max);
  } catch {
    return all;
  }
}
