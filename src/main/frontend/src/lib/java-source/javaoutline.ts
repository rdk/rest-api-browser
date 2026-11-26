import { scanSourceLines, type ScannedSource } from './javascan';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export interface OutlineItem {
  kind: 'method' | 'ctor' | 'type';
  name: string;
  params: string;
  returns: string;
  visibility: 'public' | 'protected' | 'private' | 'package';
  isStatic: boolean;
  /** HTTP method when annotated as a REST endpoint (e.g. @GET, @POST, @PutMapping). */
  httpMethod?: HttpMethod;
  /** Optional @Path("...") value on the method. */
  restPath?: string;
  /** Combined class-level @Path + method-level @Path (trimmed of leading/trailing slashes) for REST endpoints. */
  fullRestPath?: string;
  /** 0-based line index of the declaration header. */
  line: number;
  depth: number;
}

const OUTLINE_TYPE_RE = /^\s*(?:(?:public|protected|private|static|final|abstract|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)/;
const OUTLINE_MODS_RE = /^(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)*/;
const OUTLINE_METHOD_RE = /^\s*((?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)*)(?:([\w$.<>?,[\] ]+?)\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)/;
const CONTROL_KW = new Set(['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'try', 'return', 'throw', 'new', 'else', 'do', 'assert', 'super', 'this']);
const REST_VERB_RE = /@(?:[\w$.]+\.)?(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/;
const SPRING_MAPPING_RE = /@(?:[\w$.]+\.)?(Get|Post|Put|Delete|Patch)Mapping\b/;
const REQUEST_METHOD_RE = /\bRequestMethod\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/;
const REST_PATH_RE = /@(?:[\w$.]+\.)?(?:Path|RequestMapping|(?:Get|Post|Put|Delete|Patch)Mapping)\s*\(\s*(?:(?:value|path)\s*=\s*)?(?:\{\s*)?"([^"]*)"/;

function normalizeMethodHeader(declLine: string): string {
  const paren = declLine.indexOf('(');
  if (paren <= 0) return declLine;
  const prefix = declLine.slice(0, paren);
  const rest = declLine.slice(paren);
  let clean = '';
  let i = 0;
  while (i < prefix.length) {
    if (prefix[i] === '@') {
      const m = /^@[\w$.]+/.exec(prefix.slice(i));
      if (m) {
        let pos = i + m[0].length;
        let ws = pos;
        while (ws < prefix.length && /\s/.test(prefix[ws])) ws++;
        if (prefix[ws] === '(') {
          let d = 1;
          pos = ws + 1;
          let inStr = false;
          while (pos < prefix.length && d > 0) {
            const ch = prefix[pos];
            if (inStr) {
              if (ch === '\\') pos++;
              else if (ch === '"') inStr = false;
            } else if (ch === '"') inStr = true;
            else if (ch === '(') d++;
            else if (ch === ')') d--;
            pos++;
          }
        }
        i = pos;
        if (clean.length > 0 && !/[\s<(,]$/.test(clean)) clean += ' ';
        continue;
      }
    }
    clean += prefix[i++];
  }
  clean = clean.replace(/<\s+/g, '<').replace(/\s+/g, ' ').trimStart();
  const modMatch = OUTLINE_MODS_RE.exec(clean);
  const mods = modMatch ? modMatch[0] : '';
  let afterMods = clean.slice(mods.length);
  if (afterMods.startsWith('<')) {
    let angle = 0;
    let pos = 0;
    while (pos < afterMods.length) {
      if (afterMods[pos] === '<') angle++;
      else if (afterMods[pos] === '>') {
        angle--;
        if (angle === 0) {
          pos++;
          break;
        }
      }
      pos++;
    }
    if (angle === 0) afterMods = afterMods.slice(pos).trimStart();
  }
  return mods + afterMods + rest;
}

function joinRestPaths(a?: string, b?: string): string | undefined {
  if (a === undefined && b === undefined) return undefined;
  const parts = [a, b]
    .filter((s): s is string => s !== undefined)
    .map((s) => s.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  return parts.join('/');
}

function stripLeadingAnnotations(code: string): string {
  let s = code.trimStart();
  while (s.startsWith('@') && !s.startsWith('@interface')) {
    const m = /^@[\w$.]+/.exec(s);
    if (!m) break;
    let pos = m[0].length;
    while (pos < s.length && /\s/.test(s[pos])) pos++;
    if (s[pos] === '(') {
      let depth = 1;
      pos++;
      let inStr = false;
      while (pos < s.length && depth > 0) {
        const ch = s[pos];
        if (inStr) {
          if (ch === '\\') pos++;
          else if (ch === '"') inStr = false;
        } else if (ch === '"') inStr = true;
        else if (ch === '(') depth++;
        else if (ch === ')') depth--;
        pos++;
      }
      if (depth > 0) return '';
    }
    s = s.slice(pos).trimStart();
  }
  return s;
}

/** Extracts constructors, methods, nested types, and REST annotations from decompiled Java source lines. */
export function extractClassOutline(input: string[] | ScannedSource): OutlineItem[] {
  const items: OutlineItem[] = [];
  const scanned = Array.isArray(input) ? scanSourceLines(input.join('\n')) : input;
  const { lines } = scanned;
  let depth = 0;
  let annParenDepth = 0;
  let inMappingAnnotation = false;
  let pendingHttp: HttpMethod | undefined;
  let pendingPath: string | undefined;
  let pendingType: { name: string; depth: number; restPath?: string } | undefined;
  const typeStack: { name: string; depth: number; restPath?: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (scanned.inComment[i] && !raw.includes('*/')) continue;
    const noComment = scanned.codeWithoutComments[i];
    const depthBefore = depth;
    const annDepthBefore = annParenDepth;

    let inStr = false;
    let inChr = false;
    let inText = scanned.inTextBlock[i];
    let annState: 0 | 1 | 2 = 0;
    let lineCode = '';
    for (let c = 0; c < noComment.length; c++) {
      const ch = noComment[c];
      if (inText) {
        if (ch === '\\') c++;
        else if (ch === '"' && noComment.startsWith('"""', c)) {
          inText = false;
          c += 2;
        }
        continue;
      }
      if (inStr) {
        if (ch === '\\') c++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (inChr) {
        if (ch === '\\') c++;
        else if (ch === '\'') inChr = false;
        continue;
      }
      if (ch === '"' && noComment.startsWith('"""', c)) {
        inText = true;
        annState = 0;
        c += 2;
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

      lineCode += ch;
      if (annParenDepth > 0) {
        if (ch === '(') annParenDepth++;
        else if (ch === ')') annParenDepth--;
        continue;
      }
      if (ch === '@') {
        annState = noComment.startsWith('@interface', c) ? 0 : 1;
      } else if (annState === 1) {
        if (ch === '(') {
          annParenDepth = 1;
          annState = 0;
        } else if (/\s/.test(ch)) {
          annState = 2;
        } else if (!/[\w$.]/.test(ch)) {
          annState = 0;
        }
      } else if (annState === 2) {
        if (ch === '(') {
          annParenDepth = 1;
          annState = 0;
        } else if (!/\s/.test(ch)) {
          annState = 0;
        }
      }
      if (annParenDepth === 0) {
        if (ch === '{') depth++;
        else if (ch === '}') depth = Math.max(0, depth - 1);
      }
    }

    while (typeStack.length > 0 && depth < typeStack[typeStack.length - 1].depth) {
      typeStack.pop();
      pendingHttp = undefined;
      pendingPath = undefined;
    }

    if (annDepthBefore > 0) {
      if (inMappingAnnotation) {
        const rm = REQUEST_METHOD_RE.exec(lineCode);
        if (rm) pendingHttp = rm[1] as HttpMethod;
        const pm = /\b(?:value|path)\s*=\s*(?:\{\s*)?"([^"]*)"/.exec(noComment)
          ?? (pendingPath === undefined ? /^\s*(?:\{\s*)?"([^"]*)"/.exec(noComment) : null);
        if (pm) pendingPath = pm[1];
      }
      if (annParenDepth === 0) inMappingAnnotation = false;
      continue;
    }

    const codeTrim = lineCode.trim();
    if (!codeTrim || codeTrim.startsWith('package ') || codeTrim.startsWith('import ')) {
      continue;
    }

    if (pendingType) {
      if (depth >= pendingType.depth) {
        typeStack.push(pendingType);
        pendingType = undefined;
        continue;
      }
      if (lineCode.includes('{') || codeTrim.endsWith(';')) {
        pendingType = undefined;
      }
      continue;
    }

    const currentType = typeStack[typeStack.length - 1];
    const atDeclDepth = depthBefore === 0 || (currentType && depthBefore === currentType.depth);
    if (atDeclDepth && codeTrim.startsWith('@') && !codeTrim.startsWith('@interface')) {
      const vm = REST_VERB_RE.exec(codeTrim);
      if (vm) pendingHttp = vm[1] as HttpMethod;
      else {
        const sm = SPRING_MAPPING_RE.exec(codeTrim);
        if (sm) pendingHttp = sm[1].toUpperCase() as HttpMethod;
        else {
          const rm = REQUEST_METHOD_RE.exec(codeTrim);
          if (rm) pendingHttp = rm[1] as HttpMethod;
        }
      }
      const pm = REST_PATH_RE.exec(noComment);
      if (pm) pendingPath = pm[1];
      inMappingAnnotation = annParenDepth > 0 && /@(?:[\w$.]+\.)?(?:Path|RequestMapping|(?:Get|Post|Put|Delete|Patch)Mapping)\b/.test(codeTrim);
      if (annParenDepth > 0) continue;
      const afterAnn = stripLeadingAnnotations(codeTrim);
      if (!afterAnn) continue;
    }

    const declLine = codeTrim.startsWith('@') && !codeTrim.startsWith('@interface')
      ? stripLeadingAnnotations(codeTrim)
      : codeTrim;
    if (!declLine) continue;

    const tm = OUTLINE_TYPE_RE.exec(declLine);
    if (tm && !declLine.includes('=')) {
      const name = tm[2];
      const targetDepth = depthBefore + 1;
      const classPath = joinRestPaths(currentType?.restPath, pendingPath);
      pendingHttp = undefined;
      pendingPath = undefined;
      if (depthBefore >= 1) {
        items.push({
          kind: 'type',
          name,
          params: '',
          returns: tm[1],
          visibility: visibilityOf(declLine),
          isStatic: /\bstatic\b/.test(declLine),
          line: i,
          depth: Math.max(0, typeStack.length - 1),
        });
      }
      if (depth >= targetDepth) {
        typeStack.push({ name, depth: targetDepth, restPath: classPath });
        pendingType = undefined;
      } else if (!lineCode.includes('{') && !declLine.endsWith(';')) {
        pendingType = { name, depth: targetDepth, restPath: classPath };
      }
      continue;
    }

    if (!currentType || depthBefore !== currentType.depth) continue;
    if (declLine.includes('=') && (!declLine.includes('(') || declLine.indexOf('=') < declLine.indexOf('('))) {
      pendingHttp = undefined;
      pendingPath = undefined;
      continue;
    }

    const mm = OUTLINE_METHOD_RE.exec(normalizeMethodHeader(declLine));
    if (!mm) {
      if (declLine.endsWith(';') || declLine === '}') {
        pendingHttp = undefined;
        pendingPath = undefined;
      }
      continue;
    }
    const mods = mm[1] ?? '';
    const ret = (mm[2] ?? '').trim();
    const name = mm[3];
    if (!name || CONTROL_KW.has(name)) continue;
    const isCtor = !ret && name === currentType.name;
    if (!isCtor && !ret) continue;
    const rawParams = collectCompactParams(scanned.codeWithoutComments, i, name);
    const item: OutlineItem = {
      kind: isCtor ? 'ctor' : 'method',
      name,
      params: rawParams,
      returns: isCtor ? '' : compactReturn(ret),
      visibility: visibilityOf(mods),
      isStatic: /\bstatic\b/.test(mods),
      line: i,
      depth: Math.max(0, typeStack.length - 1),
    };
    if (!isCtor && pendingHttp) {
      item.httpMethod = pendingHttp;
      const fullPath = joinRestPaths(currentType.restPath, pendingPath);
      if (fullPath !== undefined) item.fullRestPath = fullPath;
    }
    if (!isCtor && pendingPath !== undefined) item.restPath = pendingPath;
    pendingHttp = undefined;
    pendingPath = undefined;
    items.push(item);
  }
  return items;
}

function visibilityOf(mods: string): 'public' | 'protected' | 'private' | 'package' {
  if (/\bpublic\b/.test(mods)) return 'public';
  if (/\bprotected\b/.test(mods)) return 'protected';
  if (/\bprivate\b/.test(mods)) return 'private';
  return 'package';
}

function compactReturn(ret: string): string {
  return ret.replace(/\b(?:[a-z_][\w]*\.)+(?=[A-Z_$])/g, '').replace(/\s+/g, ' ').trim();
}

// Extracts raw text inside top-level `(...)` of a declaration, skipping strings/chars so `"()"` does not close parens.
function sliceParamList(lines: string[], startLine: number, methodName: string, maxSpan = 32): string | null {
  const first = lines[startLine];
  const nameIdx = first.indexOf(methodName);
  const openPos = first.indexOf('(', nameIdx >= 0 ? nameIdx : 0);
  if (openPos < 0) return null;
  let depthParen = 0;
  let inStr = false;
  let inChr = false;
  let buf = '';
  for (let i = startLine; i < Math.min(lines.length, startLine + maxSpan); i++) {
    const line = lines[i];
    const from = i === startLine ? openPos : 0;
    for (let c = from; c < line.length; c++) {
      const ch = line[c];
      if (inStr) {
        if (c > from || i > startLine) {
          if (depthParen >= 1) buf += ch;
        }
        if (ch === '\\' && c + 1 < line.length) {
          if (depthParen >= 1) buf += line[++c];
          else c++;
        } else if (ch === '"') inStr = false;
        continue;
      }
      if (inChr) {
        if (depthParen >= 1) buf += ch;
        if (ch === '\\' && c + 1 < line.length) {
          if (depthParen >= 1) buf += line[++c];
          else c++;
        } else if (ch === '\'') inChr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
        if (depthParen >= 1) buf += ch;
        continue;
      }
      if (ch === '\'') {
        inChr = true;
        if (depthParen >= 1) buf += ch;
        continue;
      }
      if (ch === '(') {
        depthParen++;
        if (depthParen > 1) buf += ch;
      } else if (ch === ')') {
        depthParen--;
        if (depthParen === 0) return buf;
        buf += ch;
      } else if (depthParen >= 1) {
        buf += ch;
      }
    }
    buf += ' ';
  }
  return null;
}

function stripParamAnnotations(paramText: string): string {
  let out = '';
  let i = 0;
  const n = paramText.length;
  while (i < n) {
    if (paramText[i] === '@') {
      const m = /^@[\w$.]+/.exec(paramText.slice(i));
      if (m) {
        let pos = i + m[0].length;
        let ws = pos;
        while (ws < n && /\s/.test(paramText[ws])) ws++;
        if (paramText[ws] === '(') {
          let d = 1;
          pos = ws + 1;
          let inStr = false;
          while (pos < n && d > 0) {
            const c = paramText[pos];
            if (inStr) {
              if (c === '\\') pos++;
              else if (c === '"') inStr = false;
            } else if (c === '"') inStr = true;
            else if (c === '(') d++;
            else if (c === ')') d--;
            pos++;
          }
        }
        i = pos;
        continue;
      }
    }
    out += paramText[i++];
  }
  return out.replace(/\bfinal\s+/g, '').replace(/\s+/g, ' ').trim();
}

function splitTopLevelParams(clean: string): string[] {
  if (!clean) return [];
  const parts: string[] = [];
  let angle = 0;
  let paren = 0;
  let cur = '';
  for (const ch of clean) {
    if (ch === '<') angle++;
    else if (ch === '>' && angle > 0) angle--;
    else if (ch === '(') paren++;
    else if (ch === ')' && paren > 0) paren--;
    if (ch === ',' && angle === 0 && paren === 0) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function collectCompactParams(lines: string[], startLine: number, methodName: string): string {
  const raw = sliceParamList(lines, startLine, methodName, 16);
  if (raw === null) return '()';
  const clean = stripParamAnnotations(raw);
  if (!clean) return '()';
  const parts = splitTopLevelParams(clean);
  const types = parts.map((p) => {
    const m = /^(.+?)\s+[A-Za-z_$][\w$]*((?:\s*\[\s*\])*)$/.exec(p);
    const cBrackets = m && m[2] ? m[2].replace(/\s+/g, '') : '';
    const t = m ? m[1].trim() + cBrackets : p;
    return t.replace(/\b(?:[a-z_][\w]*\.)+(?=[A-Z_$])/g, '');
  });
  return `(${types.join(', ')})`;
}

/** Finds the 0-based declaration header line of `methodName` in decompiled lines, matching overload parameter count when given. */
export function findMethodHeaderLine(input: string[] | ScannedSource, methodName: string, paramCount?: number): number {
  if (!methodName || CONTROL_KW.has(methodName)) return -1;
  const scanned = Array.isArray(input) ? scanSourceLines(input.join('\n')) : input;
  const { lines } = scanned;
  if (!lines.length) return -1;
  const escaped = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `^\\s*(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\\s+)*`
      + `(?:<[^>]+>\\s+)?(?:[\\w$.<>?, \\[\\]]+\\s+)?${escaped}\\s*\\(`,
  );
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    let code = scanned.codeWithoutComments[i];
    if (scanned.inTextBlock[i]) {
      let closeAt = -1;
      for (let c = 0; c + 2 < code.length; c++) {
        if (code[c] === '\\') {
          c++;
          continue;
        }
        if (code[c] === '"' && code[c + 1] === '"' && code[c + 2] === '"') {
          closeAt = c + 3;
          break;
        }
      }
      if (closeAt < 0) continue;
      code = code.slice(closeAt);
    }
    const trimmed = code.trim();
    if (!trimmed || trimmed.startsWith('return ') || trimmed.startsWith('new ') || trimmed.startsWith('throw ')) continue;
    const norm = normalizeMethodHeader(code);
    if (re.test(norm)) {
      // If there's no modifier and no return type before methodName, require `{` on or right after the param list (package-private constructor, not a bare call).
      const beforeParen = norm.slice(0, norm.indexOf('(')).trim();
      if (beforeParen === methodName && !hasBodyBraceAfterParams(scanned.codeWithoutComments, i, methodName)) {
        continue;
      }
      hits.push(i);
    }
  }
  if (!hits.length) return -1;
  if (hits.length === 1 || paramCount === undefined) return hits[0];
  for (const idx of hits) {
    const counted = countParamsAt(scanned.codeWithoutComments, idx, methodName);
    if (counted === paramCount) return idx;
  }
  return hits[0];
}

function hasBodyBraceAfterParams(lines: string[], startLine: number, methodName: string): boolean {
  let depth = 0;
  let seenOpen = false;
  let inStr = false;
  let inChr = false;
  for (let i = startLine; i < Math.min(lines.length, startLine + 16); i++) {
    const line = lines[i];
    const from = i === startLine ? Math.max(0, line.indexOf(methodName)) : 0;
    for (let c = from; c < line.length; c++) {
      const ch = line[c];
      if (inStr) {
        if (ch === '\\') c++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (inChr) {
        if (ch === '\\') c++;
        else if (ch === '\'') inChr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
      } else if (ch === '\'') {
        inChr = true;
      } else if (ch === '(') {
        depth++;
        seenOpen = true;
      } else if (ch === ')') {
        depth--;
        if (seenOpen && depth === 0) {
          const tail = line.slice(c + 1).trim();
          if (tail.startsWith('{') || /^throws\b/.test(tail)) return true;
          if (tail.startsWith(';')) return false;
          const next = (lines[i + 1] ?? '').trim();
          return next.startsWith('{') || /^throws\b/.test(next);
        }
      }
    }
  }
  return false;
}

/** Finds the 0-based declaration line of the method, constructor, or nested type in `outline` that encloses `line0` (or -1). */
export function findEnclosingOutlineLine(outline: OutlineItem[], line0: number): number {
  let best = -1;
  for (const item of outline) {
    if (item.line <= line0 && item.line >= best) {
      best = item.line;
    }
  }
  return best;
}

function countParamsAt(lines: string[], startLine: number, methodName: string): number {
  const raw = sliceParamList(lines, startLine, methodName, 25);
  if (raw === null) return -1;
  const clean = stripParamAnnotations(raw);
  return clean ? splitTopLevelParams(clean).length : 0;
}

/** Normalizes a JAX-RS path for outline matching by trimming slashes and erasing `{param: regex}` bodies. */
export function normalizeRestPath(path: string): string {
  const trimmed = path.trim().replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
  let out = '';
  let i = 0;
  while (i < trimmed.length) {
    if (trimmed[i] === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < trimmed.length && depth > 0) {
        if (trimmed[j] === '\\' && j + 1 < trimmed.length) {
          j += 2;
          continue;
        }
        if (trimmed[j] === '{') depth++;
        else if (trimmed[j] === '}') depth--;
        j++;
      }
      if (depth === 0) {
        out += '{}';
        i = j;
        continue;
      }
    }
    out += trimmed[i++];
  }
  return out;
}
