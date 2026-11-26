export type TokenKind = 'ann' | 'member' | 'type' | 'kw' | 'str' | 'num' | 'punct' | 'name' | 'space' | 'comment';

export interface Token {
  text: string;
  kind: TokenKind;
}

const isWs = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isHex = (c: number) => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isIdentStart = (c: number) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
const isIdentPart = (c: number) => isIdentStart(c) || isDigit(c);

function readQuoted(s: string, start: number, quote: number): number {
  const n = s.length;
  let i = start + 1;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 /* \ */) {
      i += i + 1 < n ? 2 : 1;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return n;
}

function readTextBlock(s: string, start: number): number {
  const n = s.length;
  let i = start + 3;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 /* \ */) {
      i += i + 1 < n ? 2 : 1;
      continue;
    }
    if (c === 34 /* " */ && s.charCodeAt(i + 1) === 34 && s.charCodeAt(i + 2) === 34) {
      return i + 3;
    }
    i++;
  }
  return n;
}

function readNumber(s: string, start: number): number {
  const n = s.length;
  let i = start;
  if (s.charCodeAt(i) === 45 /* - */) i++;
  const first = s.charCodeAt(i);
  const next = s.charCodeAt(i + 1);
  if (first === 48 && (next === 120 || next === 88)) {
    i += 2;
    while (i < n && (isHex(s.charCodeAt(i)) || s.charCodeAt(i) === 95)) i++;
    if (i < n && s.charCodeAt(i) === 46 && (isHex(s.charCodeAt(i + 1)) || s.charCodeAt(i + 1) === 95)) {
      i++;
      while (i < n && (isHex(s.charCodeAt(i)) || s.charCodeAt(i) === 95)) i++;
    }
    if (i < n && (s.charCodeAt(i) === 112 || s.charCodeAt(i) === 80)) {
      i++;
      if (i < n && (s.charCodeAt(i) === 43 || s.charCodeAt(i) === 45)) i++;
      while (i < n && (isDigit(s.charCodeAt(i)) || s.charCodeAt(i) === 95)) i++;
    }
  } else if (first === 48 && (next === 98 || next === 66)) {
    i += 2;
    while (i < n && (s.charCodeAt(i) === 48 || s.charCodeAt(i) === 49 || s.charCodeAt(i) === 95)) i++;
  } else {
    while (i < n && (isDigit(s.charCodeAt(i)) || s.charCodeAt(i) === 95)) i++;
    if (i < n && s.charCodeAt(i) === 46 && isDigit(s.charCodeAt(i + 1))) {
      i++;
      while (i < n && (isDigit(s.charCodeAt(i)) || s.charCodeAt(i) === 95)) i++;
    }
    if (i < n && (s.charCodeAt(i) === 101 || s.charCodeAt(i) === 69)) {
      let exp = i + 1;
      if (exp < n && (s.charCodeAt(exp) === 43 || s.charCodeAt(exp) === 45)) exp++;
      if (exp < n && isDigit(s.charCodeAt(exp))) {
        i = exp;
        while (i < n && (isDigit(s.charCodeAt(i)) || s.charCodeAt(i) === 95)) i++;
      }
    }
  }
  if (i < n && 'fFdDlL'.includes(s[i])) i++;
  return i;
}

function beforeNonSpace(out: Token[], k: number): number {
  let i = k - 1;
  while (i >= 0 && out[i].kind === 'space') i--;
  return i;
}

function isConstant(text: string, out: Token[]): boolean {
  if (!/^[A-Z_$][A-Z0-9_$]*$/.test(text) || !/[A-Z]/.test(text)) return false;
  if (text.includes('_')) return true;
  const dot = beforeNonSpace(out, out.length);
  if (dot < 0 || out[dot].text !== '.') return false;
  const owner = beforeNonSpace(out, dot);
  return owner >= 0 && (out[owner].kind === 'type' || out[owner].kind === 'num') && /^[A-Z]/.test(out[owner].text);
}

/**
 * Single-pass $O(n)$ Java lexical scanner shared by annotation layout and full-source syntax highlighting.
 * Supports `//`, `/* ... * /`, Java 15+ text blocks `"""..."""`, strings, char literals, hex/binary/exponent numbers,
 * `@Annotations`, and identifiers without quadratic tail slicing.
 */
export function scanJavaTokens(
  s: string,
  opts: { keywords: ReadonlySet<string>; markMembers?: boolean; includeComments?: boolean; collapseSpaces?: boolean },
): Token[] {
  const out: Token[] = [];
  const n = s.length;
  let i = 0;

  while (i < n) {
    const ch = s.charCodeAt(i);
    const next = i + 1 < n ? s.charCodeAt(i + 1) : 0;

    if (opts.includeComments && ch === 47 /* / */) {
      if (next === 47 /* / */) {
        const nl = s.indexOf('\n', i + 2);
        const end = nl < 0 ? n : nl;
        out.push({ text: s.slice(i, end), kind: 'comment' });
        i = end;
        continue;
      }
      if (next === 42 /* * */) {
        const close = s.indexOf('*/', i + 2);
        const end = close < 0 ? n : close + 2;
        out.push({ text: s.slice(i, end), kind: 'comment' });
        i = end;
        continue;
      }
    }

    if (ch === 34 /* " */) {
      const end = next === 34 && s.charCodeAt(i + 2) === 34 ? readTextBlock(s, i) : readQuoted(s, i, 34);
      out.push({ text: s.slice(i, end), kind: 'str' });
      i = end;
      continue;
    }

    if (ch === 39 /* ' */) {
      const end = readQuoted(s, i, 39);
      out.push({ text: s.slice(i, end), kind: 'str' });
      i = end;
      continue;
    }

    if (ch === 64 /* @ */ && i + 1 < n && (isIdentStart(next) || next === 46)) {
      let end = i + 1;
      while (end < n && (isIdentPart(s.charCodeAt(end)) || s.charCodeAt(end) === 46)) end++;
      out.push({ text: s.slice(i, end), kind: 'ann' });
      i = end;
      continue;
    }

    if (
      isDigit(ch)
      || (ch === 46 /* . */ && isDigit(next) && out[out.length - 1]?.kind !== 'name' && out[out.length - 1]?.kind !== 'type')
      || (ch === 45 /* - */ && opts.markMembers && isDigit(next))
    ) {
      const end = readNumber(s, i);
      if (end > i) {
        out.push({ text: s.slice(i, end), kind: 'num' });
        i = end;
        continue;
      }
    }

    if (isIdentStart(ch)) {
      let end = i + 1;
      while (end < n && isIdentPart(s.charCodeAt(end))) end++;
      const text = s.slice(i, end);
      let isMember = false;
      if (opts.markMembers) {
        let look = end;
        while (look < n && isWs(s.charCodeAt(look))) look++;
        isMember = s.charCodeAt(look) === 61 /* = */ && s.charCodeAt(look + 1) !== 61;
      }
      const kind: TokenKind = opts.keywords.has(text)
        ? 'kw'
        : isMember
          ? 'member'
          : isConstant(text, out)
            ? 'num'
            : /^[A-Z]/.test(text)
              ? 'type'
              : 'name';
      out.push({ text, kind });
      i = end;
      continue;
    }

    if (isWs(ch)) {
      let end = i + 1;
      while (end < n && isWs(s.charCodeAt(end))) end++;
      out.push({ text: opts.collapseSpaces ? ' ' : s.slice(i, end), kind: 'space' });
      i = end;
      continue;
    }

    out.push({ text: s[i], kind: 'punct' });
    i++;
  }
  return out;
}

export interface ScannedSource {
  lines: string[];
  codeWithoutComments: string[];
  inComment: boolean[];
  inTextBlock: boolean[];
  maxCols: number;
}

/** Strips `//` and `/* ... * /` comments on one line while tracking multiline comment/text-block state across lines. */
export function scanSourceLines(source: string): ScannedSource {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const n = lines.length;
  const codeWithoutComments = new Array<string>(n);
  const inComment = new Array<boolean>(n);
  const inTextBlock = new Array<boolean>(n);
  let comment = false;
  let textBlock = false;
  let maxCols = 0;

  for (let i = 0; i < n; i++) {
    inComment[i] = comment;
    inTextBlock[i] = textBlock;
    const line = lines[i];
    if (line.length > maxCols) maxCols = line.length;
    let code = '';
    let inStr = false;
    let inChr = false;
    for (let c = 0; c < line.length; c++) {
      const ch = line.charCodeAt(c);
      const next = c + 1 < line.length ? line.charCodeAt(c + 1) : 0;
      if (comment) {
        if (ch === 42 /* * */ && next === 47 /* / */) {
          comment = false;
          c++;
        }
        continue;
      }
      if (textBlock) {
        code += line[c];
        if (ch === 92 /* \ */ && c + 1 < line.length) {
          code += line[++c];
          continue;
        }
        if (ch === 34 && next === 34 && line.charCodeAt(c + 2) === 34) {
          code += '""';
          textBlock = false;
          c += 2;
        }
        continue;
      }
      if (inStr) {
        code += line[c];
        if (ch === 92 && c + 1 < line.length) code += line[++c];
        else if (ch === 34) inStr = false;
        continue;
      }
      if (inChr) {
        code += line[c];
        if (ch === 92 && c + 1 < line.length) code += line[++c];
        else if (ch === 39) inChr = false;
        continue;
      }
      if (ch === 47 && next === 47) break;
      if (ch === 47 && next === 42) {
        comment = true;
        c++;
        continue;
      }
      if (ch === 34 && next === 34 && line.charCodeAt(c + 2) === 34) {
        textBlock = true;
        code += '"""';
        c += 2;
        continue;
      }
      if (ch === 34) inStr = true;
      else if (ch === 39) inChr = true;
      code += line[c];
    }
    codeWithoutComments[i] = code;
  }
  return { lines, codeWithoutComments, inComment, inTextBlock, maxCols };
}
