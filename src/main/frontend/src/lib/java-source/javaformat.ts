import { annotationTokens, toLines } from './javatokens';

const INDENT = '    ';
const MAX_ANNOTATION_LINE = 92;
const MAX_SIGNATURE_LINE = 110;

type LogicalLine =
  | { kind: 'line'; text: string }
  | { kind: 'raw'; text: string }
  | { kind: 'ann'; rel: number; text: string };

/**
 * Deterministic, fast pretty-formatter for decompiled Java source (CFR / Vineflower):
 * handles block comments (including mid-line `/* ... * /` and `/* synthetic * / ... {`),
 * text blocks, long OpenAPI annotations, control/brace spacing, and method signature wrapping.
 */
export function formatJavaSource(source: string): string {
  if (!source) return source;
  const rawLines = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  const logical: LogicalLine[] = [];
  let inBlockComment = false;
  let inTextBlock = false;
  let i = 0;
  while (i < rawLines.length) {
    const raw = rawLines[i];
    const trimmed = raw.trim();

    if (inTextBlock) {
      logical.push({ kind: 'raw', text: raw });
      const endState = blockStateAfterLine(raw, false, 0, 0, true);
      inBlockComment = endState.inBlock;
      inTextBlock = endState.inTextBlock;
      i++;
      continue;
    }

    if (inBlockComment) {
      logical.push({ kind: 'line', text: raw });
      const endState = blockStateAfterLine(raw, true);
      inBlockComment = endState.inBlock;
      inTextBlock = endState.inTextBlock;
      i++;
      continue;
    }
    if (!trimmed) {
      logical.push({ kind: 'line', text: '' });
      i++;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      const endState = blockStateAfterLine(trimmed, false);
      if (endState.inBlock) {
        logical.push({ kind: 'line', text: raw });
        inBlockComment = true;
        i++;
        continue;
      }
      // Pure single-line comment `/* ... */` or `/* synthetic */ code {`
      const afterComment = stripLineCommentsOnly(trimmed).trim();
      if (!afterComment) {
        logical.push({ kind: 'line', text: raw });
        i++;
        continue;
      }
      const code = normalizeSpacing(trimmed);
      const pieces = trimmed.includes('"""') ? [code] : splitCompressedLine(code);
      logical.push(...pieces.map((text): LogicalLine => ({ kind: 'line', text })));
      inBlockComment = endState.inBlock;
      inTextBlock = endState.inTextBlock;
      i++;
      continue;
    }
    if (trimmed.startsWith('//')) {
      logical.push({ kind: 'line', text: trimmed });
      i++;
      continue;
    }

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
      if (pDepth === 0 && isStandaloneAnnotation(joined)) {
        if (joined.length > MAX_ANNOTATION_LINE || i > start) {
          const prettyAnn = layoutAnnotation(joined);
          if (prettyAnn) {
            logical.push(...prettyAnn);
            i++;
            continue;
          }
        }
        logical.push({ kind: 'line', text: joined });
        i++;
        continue;
      }
      for (let k = start; k <= i; k++) {
        const piece = rawLines[k].trim();
        const code = normalizeSpacing(piece);
        const pieces = piece.includes('"""') ? [code] : splitCompressedLine(code);
        logical.push(...pieces.map((text): LogicalLine => ({ kind: 'line', text })));
        const st = blockStateAfterLine(piece, inBlockComment, 0, 0, inTextBlock);
        inBlockComment = st.inBlock;
        inTextBlock = st.inTextBlock;
      }
      i++;
      continue;
    }

    const code = normalizeSpacing(trimmed);
    const pieces = trimmed.includes('"""') ? [code] : splitCompressedLine(code);
    logical.push(...pieces.map((text): LogicalLine => ({ kind: 'line', text })));
    const endState = blockStateAfterLine(trimmed, false);
    inBlockComment = endState.inBlock;
    inTextBlock = endState.inTextBlock;
    i++;
  }

  const out: string[] = [];
  let depth = 0;
  let inBlock = false;
  let inText = false;
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
    const entry = logical[idx];

    if (entry.kind === 'ann') {
      if (entry.rel === 0 && (prevKind === 'close' || prevKind === 'import' || prevKind === 'package')) {
        prevKind = pushBlank();
      }
      out.push(INDENT.repeat(depth) + ' '.repeat(entry.rel) + entry.text);
      prevKind = 'ann';
      continue;
    }

    if (entry.kind === 'raw') {
      out.push(entry.text);
      const state = advanceDepth(entry.text, depth, annParen, false, true);
      depth = state.depth;
      annParen = state.annParen;
      inBlock = state.inBlock;
      inText = state.inTextBlock;
      prevKind = 'other';
      continue;
    }

    const raw = entry.text;
    if (inBlock) {
      const t = raw.trim();
      const pad = t.startsWith('*') ? INDENT.repeat(depth) + ' ' : INDENT.repeat(depth);
      out.push(pad + t);
      const state = blockStateAfterLine(t, true, depth, annParen);
      inBlock = state.inBlock;
      depth = state.depth;
      annParen = state.annParen;
      inText = state.inTextBlock;
      prevKind = 'comment';
      continue;
    }

    const t = raw.trim();
    if (!t) {
      if (prevKind !== 'blank' && prevKind !== 'open' && prevKind !== 'ann' && prevKind !== 'none') {
        prevKind = pushBlank();
      }
      continue;
    }

    const codeOnly = stripLineCommentsOnly(t).trim();
    if (t.startsWith('/*') && !codeOnly) {
      if (prevKind === 'close' || prevKind === 'import' || prevKind === 'package') prevKind = pushBlank();
      out.push(INDENT.repeat(depth) + t);
      inBlock = blockStateAfterLine(t, false).inBlock;
      prevKind = 'comment';
      continue;
    }

    if (t.startsWith('//')) {
      out.push(INDENT.repeat(depth) + t);
      prevKind = 'comment';
      continue;
    }

    const leadingCloses = countLeadingCloses(codeOnly || t);
    const lineDepth = Math.max(0, depth - leadingCloses);

    const inspect = codeOnly || t;
    const isPkg = inspect.startsWith('package ');
    const isImp = inspect.startsWith('import ');
    const isAnn = inspect.startsWith('@') && !inspect.startsWith('@interface');
    const isMemberStart = !isPkg && !isImp && !isAnn && !inspect.startsWith('}') && (
      /^(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|sealed|non-sealed)\s+)*(?:class|interface|enum|record|@interface)\b/.test(inspect)
      || (depth >= 1 && isMethodHeaderLine(inspect))
    );

    if (prevKind === 'package' && !isPkg) prevKind = pushBlank();
    else if (prevKind === 'import' && !isImp) prevKind = pushBlank();
    else if (prevKind === 'close' && !inspect.startsWith('}') && !/^(?:else|catch|finally|while)\b/.test(inspect)) prevKind = pushBlank();
    else if (isMemberStart && prevKind !== 'ann' && prevKind !== 'comment' && prevKind !== 'open' && prevKind !== 'blank' && prevKind !== 'none') {
      prevKind = pushBlank();
    }

    const wrapped = !t.startsWith('/*') && t.length > MAX_SIGNATURE_LINE && isMethodHeaderLine(t) ? wrapMethodParams(t, lineDepth) : null;
    if (wrapped) {
      out.push(...wrapped);
    } else {
      out.push(INDENT.repeat(lineDepth) + t);
    }

    const state = advanceDepth(t, depth, annParen, false, inText);
    depth = state.depth;
    annParen = state.annParen;
    inBlock = state.inBlock;
    inText = state.inTextBlock;

    if (isPkg) prevKind = 'package';
    else if (isImp) prevKind = 'import';
    else if (isAnn) prevKind = 'ann';
    else if (inspect.endsWith('{')) prevKind = 'open';
    else if (inspect === '}' || inspect === '};') prevKind = 'close';
    else prevKind = 'other';
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

function stripLineCommentsOnly(line: string): string {
  let out = '';
  let inBlock = false;
  let inStr = false;
  let inChr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        out += ' ';
        i++;
      }
      continue;
    }
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
    if (ch === '/' && next === '/') break;
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '\'') inChr = true;
    out += ch;
  }
  return out;
}

function blockStateAfterLine(
  line: string,
  startsInBlock: boolean,
  depth = 0,
  annParen = 0,
  startsInTextBlock = false,
): { inBlock: boolean; inTextBlock: boolean; depth: number; annParen: number } {
  return advanceDepth(line, depth, annParen, startsInBlock, startsInTextBlock);
}

function parenDelta(line: string): number {
  let d = 0;
  let inStr = false;
  let inChr = false;
  let inBlock = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
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
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
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

function layoutAnnotation(text: string): LogicalLine[] | null {
  const toks = annotationTokens(text, MAX_ANNOTATION_LINE);
  const lines = toLines(toks);
  if (!lines.length) return null;
  return lines.map((l) => ({ kind: 'ann', rel: l.indent, text: l.tokens.map((t) => t.text).join('') }));
}

function normalizeSpacing(line: string): string {
  return transformCodeSegments(line, (seg) => seg
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
  let inText = false;
  let inBlock = false;
  const flush = () => {
    if (buf) {
      res += fn(buf);
      buf = '';
    }
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';
    if (inBlock) {
      res += ch;
      if (ch === '*' && next === '/' && i + 1 < line.length) {
        res += line[++i];
        inBlock = false;
      }
      continue;
    }
    if (inText) {
      res += ch;
      if (ch === '\\' && i + 1 < line.length) res += line[++i];
      else if (ch === '"' && line.startsWith('"""', i)) {
        res += '""';
        i += 2;
        inText = false;
      }
      continue;
    }
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
    if (ch === '/' && next === '*') {
      flush();
      inBlock = true;
      res += ch + next;
      i++;
      continue;
    }
    if (ch === '"' && line.startsWith('"""', i)) {
      flush();
      inText = true;
      res += '"""';
      i += 2;
      continue;
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

function splitCompressedLine(line: string): string[] {
  if (!line.includes('{') || !line.includes('}')) return [line];
  if (line.includes('//') || line.includes('/*')) return [line];
  if (line.startsWith('@') || /=\s*\{/.test(line) || /\[\s*\]\s*\{/.test(line)) return [line];
  if (/\{\s*\}/.test(line)) return [line];

  const open = findTopLevelChar(line, '{');
  if (open < 0) return [line];
  const close = findMatchingCloseBrace(line, open);
  if (close !== line.length - 1) return [line];

  const head = line.slice(0, open + 1).trim();
  const body = line.slice(open + 1, close).trim();
  if (!body || body.includes('{') || body.includes('->')) return [line];
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

function advanceDepth(
  line: string,
  depth: number,
  annParen: number,
  startsInBlock = false,
  startsInTextBlock = false,
): { depth: number; annParen: number; inBlock: boolean; inTextBlock: boolean } {
  let inStr = false;
  let inChr = false;
  let inBlock = startsInBlock;
  let inTextBlock = startsInTextBlock;
  let annState: 0 | 1 | 2 = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inTextBlock) {
      if (ch === '\\') i++;
      else if (ch === '"' && line.startsWith('"""', i)) {
        inTextBlock = false;
        i += 2;
      }
      continue;
    }
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
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (ch === '"' && line.startsWith('"""', i)) {
      inTextBlock = true;
      annState = 0;
      i += 2;
      continue;
    }
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
      annState = line.startsWith('@interface', i) ? 0 : 1;
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
  return { depth, annParen, inBlock, inTextBlock };
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
