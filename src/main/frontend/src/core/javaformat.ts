import { annotationTokens, toLines } from './javatokens';

const INDENT = '    ';
const MAX_ANNOTATION_LINE = 92;
const MAX_SIGNATURE_LINE = 110;

/**
 * Deterministic, fast pretty-formatter for decompiled Java source (CFR / Vineflower):
 * - Normalizes indentation to 4 spaces while respecting block comments, strings, char literals, and annotation arrays.
 * - Pretty-prints long single-line or compressed annotations using the annotation layout engine.
 * - Normalizes control keyword and brace spacing (`if (`, `) {`, `} else {`, `} catch (`).
 * - Wraps very long method parameter lists onto aligned lines.
 * - Adds clean blank-line separation after `package`, after imports, and between class members.
 * Preserves every comment, string literal, and code token verbatim.
 */
export function formatJavaSource(source: string): string {
  if (!source) return source;
  const rawLines = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // Pass 1: join multiline annotations so long OpenAPI annotations can be re-laid-out cleanly,
  // and split compressed single-line blocks (e.g. `if (x) { return y; }`) into separate logical lines.
  const logical: string[] = [];
  let inBlockComment = false;
  let i = 0;
  while (i < rawLines.length) {
    const raw = rawLines[i];
    const trimmed = raw.trim();

    if (inBlockComment) {
      logical.push(raw);
      if (trimmed.includes('*/')) inBlockComment = false;
      i++;
      continue;
    }
    if (!trimmed) {
      logical.push('');
      i++;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      logical.push(raw);
      if (!trimmed.includes('*/')) inBlockComment = true;
      i++;
      continue;
    }
    if (trimmed.startsWith('//')) {
      logical.push(trimmed);
      i++;
      continue;
    }

    // Collect complete annotation (single-line or multiline) when a line starts with `@Name` (not `@interface`)
    if (trimmed.startsWith('@') && !trimmed.startsWith('@interface')) {
      const start = i;
      let joined = trimmed;
      let pDepth = parenDelta(trimmed);
      while (pDepth > 0 && i + 1 < rawLines.length) {
        i++;
        const next = rawLines[i].trim();
        joined += ' ' + next;
        pDepth += parenDelta(next);
      }
      // Only re-layout when the whole collected text is a standalone annotation (not `@GET public Response foo()`)
      if (pDepth === 0 && isStandaloneAnnotation(joined)) {
        if (joined.length > MAX_ANNOTATION_LINE || i > start) {
          const prettyAnn = layoutAnnotation(joined);
          if (prettyAnn) {
            logical.push(...prettyAnn);
            i++;
            continue;
          }
        }
        logical.push(joined);
        i++;
        continue;
      }
      // Fall back to original lines if it wasn't a pure annotation
      for (let k = start; k <= i; k++) {
        logical.push(...splitCompressedLine(normalizeSpacing(rawLines[k].trim())));
      }
      i++;
      continue;
    }

    logical.push(...splitCompressedLine(normalizeSpacing(trimmed)));
    i++;
  }

  // Pass 2: wrap long method/constructor parameter lines, compute 4-space indentation, and normalize blank lines.
  const out: string[] = [];
  let depth = 0;
  let inBlock = false;
  let annParen = 0;
  type LineKind = 'none' | 'blank' | 'package' | 'import' | 'ann' | 'comment' | 'close' | 'open' | 'other';
  let prevKind: LineKind = 'none';

  const pushBlank = (): LineKind => {
    if (out.length > 0 && out[out.length - 1] !== '') {
      out.push('');
      return 'blank';
    }
    return prevKind;
  };

  for (let idx = 0; idx < logical.length; idx++) {
    const line = logical[idx];

    if (inBlock) {
      const t = line.trim();
      const pad = t.startsWith('*') ? INDENT.repeat(depth) + ' ' : INDENT.repeat(depth);
      out.push(pad + t);
      if (t.includes('*/')) inBlock = false;
      prevKind = 'comment';
      continue;
    }

    // Pre-indented lines emitted by layoutAnnotation carry a `\0` marker with their relative column offset
    if (line.startsWith('\0')) {
      const sep = line.indexOf('\0', 1);
      const rel = Number(line.slice(1, sep));
      const text = line.slice(sep + 1);
      if (rel === 0 && (prevKind === 'close' || prevKind === 'import' || prevKind === 'package')) {
        prevKind = pushBlank();
      }
      out.push(INDENT.repeat(depth) + ' '.repeat(rel) + text);
      prevKind = 'ann';
      continue;
    }

    const t = line.trim();
    if (!t) {
      if (prevKind !== 'blank' && prevKind !== 'open' && prevKind !== 'ann' && prevKind !== 'none') {
        prevKind = pushBlank();
      }
      continue;
    }

    if (t.startsWith('/*')) {
      if (prevKind === 'close' || prevKind === 'import' || prevKind === 'package') prevKind = pushBlank();
      out.push(INDENT.repeat(depth) + t);
      if (!t.includes('*/')) inBlock = true;
      prevKind = 'comment';
      continue;
    }

    if (t.startsWith('//')) {
      out.push(INDENT.repeat(depth) + t);
      prevKind = 'comment';
      continue;
    }

    const leadingCloses = countLeadingCloses(t);
    const lineDepth = Math.max(0, depth - leadingCloses);

    // Vertical rhythm: blank line after package, after import block, and before top-level/member declarations
    const isPkg = t.startsWith('package ');
    const isImp = t.startsWith('import ');
    const isAnn = t.startsWith('@') && !t.startsWith('@interface');
    const isMemberStart = !isPkg && !isImp && !isAnn && !t.startsWith('}') && (
      /^(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|sealed|non-sealed)\s+)*(?:class|interface|enum|record|@interface)\b/.test(t)
      || (depth >= 1 && isMethodHeaderLine(t))
    );

    if (prevKind === 'package' && !isPkg) prevKind = pushBlank();
    else if (prevKind === 'import' && !isImp) prevKind = pushBlank();
    else if (prevKind === 'close' && !t.startsWith('}') && !/^(?:else|catch|finally|while)\b/.test(t)) prevKind = pushBlank();
    else if (isMemberStart && prevKind !== 'ann' && prevKind !== 'comment' && prevKind !== 'open' && prevKind !== 'blank' && prevKind !== 'none') {
      prevKind = pushBlank();
    }

    // Wrap long method signatures onto cleanly indented parameter lines
    const wrapped = t.length > MAX_SIGNATURE_LINE && isMethodHeaderLine(t) ? wrapMethodParams(t, lineDepth) : null;
    if (wrapped) {
      out.push(...wrapped);
    } else {
      out.push(INDENT.repeat(lineDepth) + t);
    }

    // Update block brace depth (ignoring braces inside strings, comments, and annotation arguments)
    const state = advanceDepth(t, depth, annParen);
    depth = state.depth;
    annParen = state.annParen;

    if (isPkg) prevKind = 'package';
    else if (isImp) prevKind = 'import';
    else if (isAnn) prevKind = 'ann';
    else if (t.endsWith('{')) prevKind = 'open';
    else if (t === '}' || t === '};') prevKind = 'close';
    else prevKind = 'other';
  }

  // Trim trailing blank lines
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

function parenDelta(line: string): number {
  let d = 0;
  let inStr = false;
  let inChr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (inChr) {
      if (ch === '\\') i++;
      else if (ch === '\'') inChr = false;
      continue;
    }
    if (ch === '/' && next === '/') break;
    if (ch === '"') inStr = true;
    else if (ch === '\'') inChr = true;
    else if (ch === '(') d++;
    else if (ch === ')') d--;
  }
  return d;
}

function isStandaloneAnnotation(text: string): boolean {
  const m = /^@[\w$.]+/.exec(text);
  if (!m) return false;
  let pos = m[0].length;
  while (pos < text.length && /\s/.test(text[pos])) pos++;
  if (pos === text.length) return true;
  if (text[pos] !== '(') return false;
  let d = 0;
  let inStr = false;
  let inChr = false;
  for (let i = pos; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (inChr) {
      if (ch === '\\') i++;
      else if (ch === '\'') inChr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '\'') inChr = true;
    else if (ch === '(') d++;
    else if (ch === ')') {
      d--;
      if (d === 0) return text.slice(i + 1).trim() === '';
    }
  }
  return false;
}

function layoutAnnotation(text: string): string[] | null {
  const toks = annotationTokens(text, MAX_ANNOTATION_LINE);
  const lines = toLines(toks);
  if (!lines.length) return null;
  return lines.map((l) => `\0${l.indent}\0${l.tokens.map((t) => t.text).join('')}`);
}

/** Normalizes spacing around Java keywords and braces outside strings, char literals, and comments. */
function normalizeSpacing(line: string): string {
  let out = '';
  let inStr = false;
  let inChr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';
    if (inStr) {
      out += ch;
      if (ch === '\\' && i + 1 < line.length) out += line[++i];
      else if (ch === '"') inStr = false;
      continue;
    }
    if (inChr) {
      out += ch;
      if (ch === '\\' && i + 1 < line.length) out += line[++i];
      else if (ch === '\'') inChr = false;
      continue;
    }
    if (ch === '/' && next === '/') {
      out += line.slice(i);
      break;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === '\'') {
      inChr = true;
      out += ch;
      continue;
    }
    out += ch;
  }
  // Apply lightweight regex spacing only to code segments outside strings/comments
  return transformCodeSegments(out, (seg) => seg
    .replace(/\b(if|for|while|switch|catch|synchronized)\(/g, '$1 (')
    .replace(/\)\{/g, ') {')
    .replace(/\}\s*(else|catch|finally)\b/g, '} $1')
    .replace(/\b(else|try|finally)\{/g, '$1 {'));
}

function transformCodeSegments(line: string, fn: (code: string) => string): string {
  let res = '';
  let buf = '';
  let inStr = false;
  let inChr = false;
  const flush = () => {
    if (buf) {
      res += fn(buf);
      buf = '';
    }
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';
    if (inStr) {
      res += ch;
      if (ch === '\\' && i + 1 < line.length) res += line[++i];
      else if (ch === '"') inStr = false;
      continue;
    }
    if (inChr) {
      res += ch;
      if (ch === '\\' && i + 1 < line.length) res += line[++i];
      else if (ch === '\'') inChr = false;
      continue;
    }
    if (ch === '/' && next === '/') {
      flush();
      res += line.slice(i);
      break;
    }
    if (ch === '"') {
      flush();
      inStr = true;
      res += ch;
      continue;
    }
    if (ch === '\'') {
      flush();
      inChr = true;
      res += ch;
      continue;
    }
    buf += ch;
  }
  flush();
  return res;
}

/**
 * Splits compressed single-line blocks such as `public void run() { a(); b(); }` or `if (ok) { return x; }`
 * into properly broken lines, leaving empty `{}` and array initializers (`= { ... }`, `[]{...}`) untouched.
 */
function splitCompressedLine(line: string): string[] {
  if (!line.includes('{') || !line.includes('}')) return [line];
  if (line.includes('//') || line.includes('/*')) return [line];
  // Never split array initializers, annotations, or empty blocks `{}`
  if (line.startsWith('@') || /=\s*\{/.test(line) || /\[\s*\]\s*\{/.test(line)) return [line];
  if (/\{\s*\}/.test(line)) return [line];

  const open = findTopLevelChar(line, '{');
  if (open < 0) return [line];
  const close = findMatchingCloseBrace(line, open);
  if (close !== line.length - 1) return [line];

  const head = line.slice(0, open + 1).trim();
  const body = line.slice(open + 1, close).trim();
  if (!body || body.includes('{') || body.includes('->')) return [line];
  // Expand single-line block only when it contains a real statement ending with ';'
  if (!body.endsWith(';')) return [line];
  const stmts = splitTopLevelSemicolons(body);
  return [head, ...stmts, '}'];
}

function findTopLevelChar(line: string, target: string): number {
  let inStr = false;
  let inChr = false;
  let paren = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (inChr) {
      if (ch === '\\') i++;
      else if (ch === '\'') inChr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '\'') inChr = true;
    else if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (paren === 0 && ch === target) return i;
  }
  return -1;
}

function findMatchingCloseBrace(line: string, open: number): number {
  let depth = 0;
  let inStr = false;
  let inChr = false;
  for (let i = open; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (inChr) {
      if (ch === '\\') i++;
      else if (ch === '\'') inChr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '\'') inChr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelSemicolons(body: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inStr = false;
  let inChr = false;
  let paren = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      cur += ch;
      if (ch === '\\' && i + 1 < body.length) cur += body[++i];
      else if (ch === '"') inStr = false;
      continue;
    }
    if (inChr) {
      cur += ch;
      if (ch === '\\' && i + 1 < body.length) cur += body[++i];
      else if (ch === '\'') inChr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '\'') inChr = true;
    else if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    cur += ch;
    if (ch === ';' && paren === 0) {
      const s = cur.trim();
      if (s) out.push(s);
      cur = '';
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function countLeadingCloses(t: string): number {
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '}') n++;
    else if (t[i] === ' ' || t[i] === '\t') continue;
    else break;
  }
  return n;
}

function advanceDepth(line: string, depth: number, annParen: number): { depth: number; annParen: number } {
  let inStr = false;
  let inChr = false;
  // 0 = outside annotation name, 1 = reading `@Name`, 2 = whitespace right after `@Name` (only `(` may follow)
  let annState: 0 | 1 | 2 = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (inChr) {
      if (ch === '\\') i++;
      else if (ch === '\'') inChr = false;
      continue;
    }
    if (ch === '/' && next === '/') break;
    if (ch === '"') {
      inStr = true;
      annState = 0;
      continue;
    }
    if (ch === '\'') {
      inChr = true;
      annState = 0;
      continue;
    }
    if (annParen > 0) {
      if (ch === '(') annParen++;
      else if (ch === ')') annParen--;
      continue;
    }
    if (ch === '@') {
      annState = line.slice(i).startsWith('@interface') ? 0 : 1;
    } else if (annState === 1) {
      if (ch === '(') {
        annParen = 1;
        annState = 0;
      } else if (/\s/.test(ch)) {
        annState = 2;
      } else if (!/[\w$.]/.test(ch)) {
        annState = 0;
      }
    } else if (annState === 2) {
      if (ch === '(') {
        annParen = 1;
        annState = 0;
      } else if (!/\s/.test(ch)) {
        annState = 0;
      }
    }
    if (annParen === 0) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  return { depth, annParen };
}

function isMethodHeaderLine(t: string): boolean {
  if (t.includes('=') && (!t.includes('(') || t.indexOf('=') < t.indexOf('('))) return false;
  if (/^(?:if|for|while|switch|catch|return|throw|new|else|do|try|case|assert|super|this)\b/.test(t)) return false;
  return /^(?:(?:public|protected|private|static|final|abstract|synchronized|native|default)\s+)+(?:<[^>]+>\s+)?(?:[\w$.<>?,[\] ]+\s+)?[A-Za-z_$][\w$]*\s*\(/.test(t);
}

function wrapMethodParams(t: string, lineDepth: number): string[] | null {
  const open = t.indexOf('(');
  if (open < 0) return null;
  let pDepth = 0;
  let aDepth = 0;
  let inStr = false;
  let inChr = false;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (inChr) {
      if (ch === '\\') i++;
      else if (ch === '\'') inChr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '\'') inChr = true;
    else if (ch === '<') aDepth++;
    else if (ch === '>' && aDepth > 0) aDepth--;
    else if (ch === '(') pDepth++;
    else if (ch === ')') {
      pDepth--;
      if (pDepth === 0) {
        close = i;
        break;
      }
    } else if (ch === ',' && pDepth === 1 && aDepth === 0) {
      commas.push(i);
    }
  }
  if (close < 0 || commas.length === 0) return null;
  const base = INDENT.repeat(lineDepth);
  const paramIndent = INDENT.repeat(lineDepth + 1);
  const parts: string[] = [];
  let start = open + 1;
  for (const c of commas) {
    parts.push(t.slice(start, c).trim());
    start = c + 1;
  }
  parts.push(t.slice(start, close).trim());
  const tail = t.slice(close).trim();
  const lines = [base + t.slice(0, open + 1)];
  parts.forEach((p, idx) => lines.push(paramIndent + p + (idx < parts.length - 1 ? ',' : '')));
  lines.push(base + tail);
  return lines;
}
