export function stripLineCommentsOnly(line: string): string {
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

export function blockStateAfterLine(
  line: string,
  startsInBlock: boolean,
  depth = 0,
  annParen = 0,
  startsInTextBlock = false,
): { inBlock: boolean; inTextBlock: boolean; depth: number; annParen: number } {
  return advanceDepth(line, depth, annParen, startsInBlock, startsInTextBlock);
}

export function parenDelta(line: string): number {
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

export function normalizeSpacing(line: string): string {
  return transformCodeSegments(line, (seg) => seg
    .replace(/\b(if|for|while|switch|catch|synchronized)\(/g, '$1 (')
    .replace(/\)\{/g, ') {')
    .replace(/\}\s*(else|catch|finally)\b/g, '} $1')
    .replace(/\b(else|try|finally)\{/g, '$1 {'));
}

export function transformCodeSegments(line: string, fn: (code: string) => string): string {
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

export function splitCompressedLine(line: string): string[] {
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

export function findTopLevelChar(line: string, target: string): number {
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

export function findMatchingCloseBrace(line: string, open: number): number {
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

export function splitTopLevelSemicolons(body: string): string[] {
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

export function countLeadingCloses(t: string): number {
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '}') n++;
    else if (t[i] === ' ' || t[i] === '\t') continue;
    else break;
  }
  return n;
}

export function advanceDepth(
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
