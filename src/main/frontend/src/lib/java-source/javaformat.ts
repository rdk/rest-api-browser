import { annotationTokens, toLines } from './javatokens';
import {
  advanceDepth,
  blockStateAfterLine,
  countLeadingCloses,
  normalizeSpacing,
  parenDelta,
  splitCompressedLine,
  stripLineCommentsOnly,
} from './javaformat-scan';

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
