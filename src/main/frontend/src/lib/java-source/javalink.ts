import { tokenizeSourceLine, type Token } from './javatokens';
import { classLabel, packageOf, simpleName, type DeclKind, type SourceSpan } from './javatypes';

const PKG_RE = /^\s*package\s+([A-Za-z_][\w$.]*)\s*;/m;
const IMPORT_RE = /^\s*import\s+(static\s+)?([A-Za-z_][\w$.*]*)(\s*;)/gm;

export interface RefContext {
  pkg: string;
  currentClass: string;
  explicit: Map<string, string>;
  wildcards: string[];
  exactRefs: Set<string>;
  bySimple: Map<string, string[]>;
  byTail: Map<string, string[]>;
  resolvedCache?: Map<string, string[]>;
}

/** Finds the offset of the first top-level opening brace `{` outside comments, strings and text blocks. */
function findHeaderEnd(source: string): number {
  const n = source.length;
  let inBlock = false;
  let inStr = false;
  let inChr = false;
  let inText = false;
  for (let i = 0; i < n; i++) {
    const ch = source.charCodeAt(i);
    const next = i + 1 < n ? source.charCodeAt(i + 1) : 0;
    if (inBlock) {
      if (ch === 42 && next === 47) {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inText) {
      if (ch === 92 && i + 1 < n) {
        i++;
        continue;
      }
      if (ch === 34 && next === 34 && source.charCodeAt(i + 2) === 34) {
        inText = false;
        i += 2;
      }
      continue;
    }
    if (inStr) {
      if (ch === 92) i++;
      else if (ch === 34) inStr = false;
      continue;
    }
    if (inChr) {
      if (ch === 92) i++;
      else if (ch === 39) inChr = false;
      continue;
    }
    if (ch === 47 && next === 47) {
      const nl = source.indexOf('\n', i + 2);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if (ch === 47 && next === 42) {
      inBlock = true;
      i++;
      continue;
    }
    if (ch === 34 && next === 34 && source.charCodeAt(i + 2) === 34) {
      inText = true;
      i += 2;
      continue;
    }
    if (ch === 34) {
      inStr = true;
      continue;
    }
    if (ch === 39) {
      inChr = true;
      continue;
    }
    if (ch === 123 /* { */) return i;
  }
  return Math.min(n, 16_384);
}

/** Builds a memoized class-reference resolution context from source package/imports and constant-pool refs. */
export function createRefContext(source: string, currentClass: string, refs: string[] = []): RefContext {
  const headerEnd = findHeaderEnd(source);
  const header = headerEnd < source.length ? source.slice(0, headerEnd) : source;
  const pkgMatch = PKG_RE.exec(header);
  const pkg = pkgMatch ? pkgMatch[1] : packageOf(currentClass);
  const explicit = new Map<string, string>();
  const wildcards: string[] = [];
  for (const m of header.matchAll(IMPORT_RE)) {
    const isStatic = !!m[1];
    if (isStatic) continue; // static imports bring members/constants into scope, not type wildcard packages
    const imp = m[2];
    if (imp.endsWith('.*')) {
      wildcards.push(imp.slice(0, -2));
    } else {
      explicit.set(simpleName(imp), imp);
    }
  }
  const exactRefs = new Set<string>();
  const bySimple = new Map<string, string[]>();
  const byTail = new Map<string, string[]>();
  const addRef = (fqcn: string) => {
    if (!fqcn || exactRefs.has(fqcn)) return;
    exactRefs.add(fqcn);
    const s = simpleName(fqcn);
    if (s) {
      const list = bySimple.get(s) ?? [];
      list.push(fqcn);
      bySimple.set(s, list);
    }
    const tail = classLabel(fqcn);
    if (tail.includes('.')) {
      const list = byTail.get(tail) ?? [];
      list.push(fqcn);
      byTail.set(tail, list);
    }
  };
  if (currentClass) addRef(currentClass);
  for (const r of refs) addRef(r);
  return { pkg, currentClass, explicit, wildcards, exactRefs, bySimple, byTail, resolvedCache: new Map() };
}

function unique(list: string[]): string[] {
  return [...new Set(list.filter(Boolean))];
}

function resolveName(name: string, ctx: RefContext, isAnnotation: boolean): string[] {
  if (!name) return [];
  const cacheKey = `${isAnnotation ? '1' : '0'}:${name}`;
  const cached = ctx.resolvedCache?.get(cacheKey);
  if (cached) return cached;

  let res: string[];
  if (/^[a-z_][\w$]*\.[A-Za-z0-9_.$]+$/.test(name)) {
    const dollarized = toDollarNested(name);
    res = dollarized !== name ? unique([name, dollarized]) : [name];
  } else if (name.includes('.')) {
    const fromTail = ctx.byTail.get(name) ?? [];
    const parts = name.split('.');
    const headCandidates = resolveName(parts[0], ctx, false);
    const tail = parts.slice(1).join('$');
    const expanded = headCandidates.map((h) => `${h}$${tail}`);
    res = unique([...fromTail, ...expanded]);
  } else if (name.length === 1 && !ctx.explicit.has(name) && !ctx.bySimple.has(name)) {
    res = [];
  } else {
    const out: string[] = [];
    const imp = ctx.explicit.get(name);
    if (imp) out.push(imp);
    const fromPool = ctx.bySimple.get(name);
    if (fromPool) out.push(...fromPool);
    if (ctx.currentClass) {
      if (simpleName(ctx.currentClass) === name) out.push(ctx.currentClass);
      out.push(`${ctx.currentClass}$${name}`);
    }
    if (ctx.pkg) out.push(`${ctx.pkg}.${name}`);
    for (const w of ctx.wildcards) out.push(`${w}.${name}`);
    if (!isAnnotation) out.push(`java.lang.${name}`);
    else if (out.length === 0) out.push(`java.lang.${name}`);
    res = unique(out);
  }
  ctx.resolvedCache?.set(cacheKey, res);
  return res;
}

// Converts `pkg.Outer.Inner` -> `pkg.Outer$Inner` (preserving lowercase package prefix segments).
function toDollarNested(fqcn: string): string {
  const segs = fqcn.split('.');
  let firstUpper = -1;
  for (let i = 0; i < segs.length; i++) {
    if (/^[A-Z]/.test(segs[i])) {
      firstUpper = i;
      break;
    }
  }
  if (firstUpper < 0 || firstUpper >= segs.length - 1) return fqcn;
  return segs.slice(0, firstUpper + 1).join('.') + '$' + segs.slice(firstUpper + 1).join('$');
}

/** Turns tokens from `tokenizeSource` into clickable spans for every Java class and annotation reference. */
export function linkSourceTokens(tokens: Token[], source: string, currentClass: string, refs: string[] = []): SourceSpan[] {
  return linkTokensWithContext(tokens, createRefContext(source, currentClass, refs));
}

/** Lazily tokenizes and links a single line of decompiled source for virtualized rendering. */
export function linkSourceLine(line: string, startsInComment: boolean, ctx: RefContext, startsInTextBlock = false): SourceSpan[] {
  if (!line) return [];
  return linkTokensWithContext(tokenizeSourceLine(line, startsInComment, startsInTextBlock), ctx);
}

const MODIFIER_KW = new Set([
  'public', 'protected', 'private', 'static', 'final', 'abstract', 'synchronized', 'native', 'default', 'strictfp',
  'sealed', 'non-sealed',
]);
const TYPE_DECL_KW = new Set(['class', 'interface', 'enum', 'record']);
const NON_METHOD_KW = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return', 'try', 'catch', 'finally',
  'throw', 'new', 'this', 'super', 'assert', 'yield', 'package', 'import', 'instanceof', 'extends', 'implements',
  'throws', 'class', 'interface', 'enum', 'record',
]);
const PRIMITIVE_KW = new Set(['void', 'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double']);
const NON_METHOD_PUNCT = new Set(['=', ';', '{', '}', '?', ':', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~']);

function detectDeclarations(tokens: Token[], currentClass: string): Map<number, DeclKind> {
  const decls = new Map<number, DeclKind>();
  const curSimple = currentClass ? simpleName(currentClass) : '';
  let lineStart = 0;
  for (let i = 0; i <= tokens.length; i++) {
    const isEnd = i === tokens.length || (tokens[i].kind === 'space' && tokens[i].text.includes('\n'));
    if (!isEnd) continue;
    scanLineDeclarations(tokens, lineStart, i, curSimple, decls);
    lineStart = i + 1;
  }
  return decls;
}

function nextNonSpace(tokens: Token[], from: number, end: number): number {
  let i = from;
  while (i < end && (tokens[i].kind === 'space' || tokens[i].kind === 'comment')) i++;
  return i;
}

function prevNonSpace(tokens: Token[], from: number, start: number): number {
  let i = from;
  while (i >= start && (tokens[i].kind === 'space' || tokens[i].kind === 'comment')) i--;
  return i;
}

function scanLineDeclarations(
  tokens: Token[],
  start: number,
  end: number,
  curSimple: string,
  decls: Map<number, DeclKind>,
): void {
  for (let i = start; i < end; i++) {
    const t = tokens[i];
    const isTypeKw = (t.kind === 'kw' && TYPE_DECL_KW.has(t.text)) || (t.kind === 'ann' && t.text === '@interface');
    if (!isTypeKw) continue;
    const prev = prevNonSpace(tokens, i - 1, start);
    if (prev >= start && tokens[prev].text === '.') continue;
    const next = nextNonSpace(tokens, i + 1, end);
    if (next < end && (tokens[next].kind === 'type' || tokens[next].kind === 'name')) {
      decls.set(next, 'type');
    }
  }

  let p = nextNonSpace(tokens, start, end);
  while (p < end && tokens[p].kind === 'ann') {
    if (tokens[p].text === '@interface') return;
    p = nextNonSpace(tokens, p + 1, end);
    if (p < end && tokens[p].text === '(') {
      let depth = 1;
      p++;
      while (p < end && depth > 0) {
        if (tokens[p].text === '(') depth++;
        else if (tokens[p].text === ')') depth--;
        p++;
      }
      p = nextNonSpace(tokens, p, end);
    }
  }
  if (p >= end) return;

  let sawModifier = false;
  while (p < end && tokens[p].kind === 'kw' && MODIFIER_KW.has(tokens[p].text)) {
    sawModifier = true;
    p = nextNonSpace(tokens, p + 1, end);
  }
  if (p < end && tokens[p].text === '<') {
    let angle = 1;
    p++;
    while (p < end && angle > 0) {
      if (tokens[p].text === '<') angle++;
      else if (tokens[p].text === '>') angle--;
      p++;
    }
    p = nextNonSpace(tokens, p, end);
  }

  let openParen = -1;
  let angle = 0;
  for (let i = p; i < end; i++) {
    const t = tokens[i];
    if (t.kind === 'space' || t.kind === 'comment') continue;
    if (t.text === '<') {
      angle++;
      continue;
    }
    if (t.text === '>') {
      if (angle === 0) return;
      angle--;
      continue;
    }
    if (angle > 0) continue;
    if (t.text === '(') {
      openParen = i;
      break;
    }
    if (t.kind === 'kw' && NON_METHOD_KW.has(t.text)) return;
    if (t.kind === 'punct' && NON_METHOD_PUNCT.has(t.text)) return;
  }
  if (openParen < 0) return;

  const nameIdx = prevNonSpace(tokens, openParen - 1, p);
  if (nameIdx < p) return;
  const nameTok = tokens[nameIdx];
  if (nameTok.kind !== 'name' && nameTok.kind !== 'type') return;

  const beforeName = prevNonSpace(tokens, nameIdx - 1, p);
  if (beforeName < p) {
    if (nameTok.kind === 'type' && (sawModifier || (curSimple && nameTok.text === curSimple))) {
      decls.set(nameIdx, 'method');
    }
    return;
  }

  const prevTok = tokens[beforeName];
  if (prevTok.text === '.' || prevTok.text === ',') return;
  if (
    prevTok.kind === 'type'
    || (prevTok.kind === 'kw' && PRIMITIVE_KW.has(prevTok.text))
    || prevTok.text === '>'
    || prevTok.text === ']'
  ) {
    decls.set(nameIdx, 'method');
  }
}

function isAllCapsIdent(t: Token): boolean {
  return t.kind === 'num' && /^[A-Z_$][A-Z0-9_$]*$/.test(t.text) && /[A-Z]/.test(t.text);
}

function isKnownNestedType(chain: string, segment: string, ctx?: RefContext): boolean {
  if (!ctx) return false;
  if (ctx.byTail.has(chain)) return true;
  const dollar = toDollarNested(chain);
  if (ctx.exactRefs.has(dollar) || ctx.exactRefs.has(chain)) return true;
  const exp = ctx.explicit.get(segment);
  if (exp && (exp === chain || exp.endsWith('.' + chain) || exp.endsWith('.' + dollar))) return true;
  const parts = chain.split('.');
  if (parts.length >= 2 && /^[A-Z]/.test(parts[0])) {
    const tail = parts.slice(1).join('$');
    const headCandidates = resolveName(parts[0], ctx, false);
    if (headCandidates.some((h) => ctx.exactRefs.has(`${h}$${tail}`) || ctx.exactRefs.has(`${h}.${tail}`))) {
      return true;
    }
  }
  return false;
}

function scanQualifiedTypeChain(
  tokens: Token[],
  start: number,
  ctx?: RefContext,
): { endIdx: number; firstTypeIdx: number; chain: string } | null {
  let j = start;
  let lastTypeIdx = -1;
  let firstTypeIdx = -1;
  let chain = tokens[start].text;
  while (j + 2 < tokens.length && tokens[j + 1].text === '.') {
    const next = tokens[j + 2];
    const isCapsType = isAllCapsIdent(next) && (firstTypeIdx < 0 || isKnownNestedType(chain + '.' + next.text, next.text, ctx));
    if (next.kind === 'name' || next.kind === 'type' || isCapsType) {
      chain += '.' + next.text;
      j += 2;
      if (next.kind === 'type' || isCapsType) {
        if (firstTypeIdx < 0) firstTypeIdx = j;
        lastTypeIdx = j;
      } else if (lastTypeIdx >= 0) {
        // Once we passed a capitalized Type, stop before lowercase member/method names (e.g. `.foo()`).
        j -= 2;
        break;
      }
    } else {
      break;
    }
  }
  if (lastTypeIdx < 0 || firstTypeIdx < 0) return null;
  // Build exact dotted string up to lastTypeIdx.
  const parts: string[] = [];
  for (let k = start; k <= lastTypeIdx; k += 2) parts.push(tokens[k].text);
  return { endIdx: lastTypeIdx, firstTypeIdx, chain: parts.join('.') };
}

/** Attaches resolved class targets/candidates to a stream of source tokens. */
export function linkTokensWithContext(tokens: Token[], ctx: RefContext): SourceSpan[] {
  const out: SourceSpan[] = [];
  const decls = detectDeclarations(tokens, ctx.currentClass);
  let inPackage = false;

  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i];
    const decl = decls.get(i);
    if (t.kind === 'kw' && t.text === 'package') {
      inPackage = true;
      out.push(t);
      i++;
      continue;
    }
    if (inPackage) {
      if (t.kind === 'punct' && t.text === ';') inPackage = false;
      out.push(t);
      i++;
      continue;
    }

    if (t.kind === 'name' && i + 2 < tokens.length && tokens[i + 1].text === '.') {
      const hit = scanQualifiedTypeChain(tokens, i, ctx);
      if (hit) {
        const isWildcard = hit.endIdx + 2 < tokens.length && tokens[hit.endIdx + 1].text === '.' && tokens[hit.endIdx + 2].text === '*';
        if (!isWildcard) {
          for (let k = i; k < hit.firstTypeIdx; k++) out.push(tokens[k]);
          const display = tokens.slice(hit.firstTypeIdx, hit.endIdx + 1).map((x) => x.text).join('');
          if (display) {
            const dollar = toDollarNested(hit.chain);
            const candidates = dollar !== hit.chain ? [hit.chain, dollar] : [hit.chain];
            out.push({ text: display, kind: 'type', target: hit.chain, candidates });
            i = hit.endIdx + 1;
            continue;
          }
        }
      }
    }

    if (
      t.kind === 'type'
      && i + 2 < tokens.length
      && tokens[i + 1].text === '.'
      && (tokens[i + 2].kind === 'type' || (isAllCapsIdent(tokens[i + 2]) && isKnownNestedType(t.text + '.' + tokens[i + 2].text, tokens[i + 2].text, ctx)))
    ) {
      let j = i;
      let chain = t.text;
      while (
        j + 2 < tokens.length
        && tokens[j + 1].text === '.'
        && (tokens[j + 2].kind === 'type' || (isAllCapsIdent(tokens[j + 2]) && isKnownNestedType(chain + '.' + tokens[j + 2].text, tokens[j + 2].text, ctx)))
      ) {
        chain += '.' + tokens[j + 2].text;
        j += 2;
      }
      const candidates = resolveName(chain, ctx, false);
      if (candidates.length > 0) {
        out.push({ text: chain, kind: 'type', target: candidates[0], candidates });
        i = j + 1;
        continue;
      }
    }

    if (t.kind === 'type') {
      const candidates = resolveName(t.text, ctx, false);
      if (candidates.length > 0) {
        out.push(decl ? { text: t.text, kind: 'type', decl, target: candidates[0], candidates } : { text: t.text, kind: 'type', target: candidates[0], candidates });
        i++;
        continue;
      }
    }

    if (t.kind === 'ann' && t.text.length > 1) {
      const raw = t.text.slice(1);
      const candidates = resolveName(raw, ctx, true);
      if (candidates.length > 0) {
        out.push({ text: t.text, kind: 'ann', target: candidates[0], candidates });
        i++;
        continue;
      }
    }

    out.push(decl ? { text: t.text, kind: t.kind, decl } : t);
    i++;
  }
  const compact: SourceSpan[] = [];
  for (const span of out) {
    const prev = compact[compact.length - 1];
    if (
      prev && !prev.target && !span.target && !prev.decl && !span.decl
      && (prev.kind === 'space' || prev.kind === 'name') && (span.kind === 'space' || span.kind === 'name')
    ) {
      prev.text += span.text;
    } else {
      compact.push(span.target ? span : span.decl ? { text: span.text, kind: span.kind, decl: span.decl } : { text: span.text, kind: span.kind });
    }
  }
  return compact;
}

function stripQuotedForMap(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"' || ch === '\'') {
      out += '""';
      i++;
      while (i < raw.length) {
        if (raw[i] === '\\') i++;
        else if (raw[i] === ch) break;
        i++;
      }
      continue;
    }
    out += ch;
  }
  return out;
}

const isQualifiedClassChain = (chain: string): boolean => {
  const segs = chain.split('.');
  if (segs.length < 2) return false;
  let i = 0;
  if (!/^[a-z_][\w$]*$/.test(segs[0])) return false;
  while (i < segs.length && /^[a-z_][\w$]*$/.test(segs[i])) i++;
  if (i === 0 || i >= segs.length) return false;
  for (; i < segs.length; i++) {
    if (!/^[A-Z_$][\w$]*(?:\$[A-Z_$][\w$]*)*$/.test(segs[i])) return false;
  }
  return true;
};

/**
 * Extracts short/display/FQCN mappings from raw annotation text in strict linear $O(n)$ time (immune to ReDoS).
 */
export function extractAnnotationClassMap(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  const code = stripQuotedForMap(raw);
  const record = (fqcn: string) => {
    if (!fqcn) return;
    const normalized = fqcn.replace(/\s+/g, '');
    if (!map.has(normalized)) map.set(normalized, normalized);
    const dotted = normalized.replace(/\$/g, '.');
    if (!map.has(dotted)) map.set(dotted, normalized);
    const label = classLabel(normalized);
    if (label && !map.has(label)) map.set(label, normalized);
    const simple = simpleName(normalized);
    if (simple && !map.has(simple)) map.set(simple, normalized);
  };

  // Single linear scan over code tokens without nested backtracking quantifiers.
  const n = code.length;
  for (let i = 0; i < n; ) {
    if (code[i] === '@') {
      let j = i + 1;
      while (j < n && /[\w$.]/.test(code[j])) j++;
      const chain = code.slice(i + 1, j);
      if (isQualifiedClassChain(chain)) record(chain);
      i = j;
      continue;
    }
    if (/[a-z_]/.test(code[i]) && (i === 0 || !/[@.\w$]/.test(code[i - 1]))) {
      let j = i;
      while (j < n && /[\w$.]/.test(code[j])) j++;
      const ident = code.slice(i, j);
      let after = j;
      while (after < n && (code[after] === ' ' || code[after] === '\t' || code[after] === '[' || code[after] === ']')) after++;
      if (ident.endsWith('.class')) {
        const cls = ident.slice(0, -'.class'.length);
        if (isQualifiedClassChain(cls)) record(cls);
      } else if (code.startsWith('.class', after) && !/[\w$]/.test(code[after + 6] ?? '')) {
        if (isQualifiedClassChain(ident)) record(ident);
      } else {
        const lastDot = ident.lastIndexOf('.');
        if (lastDot > 0) {
          const tail = ident.slice(lastDot + 1);
          const prefix = ident.slice(0, lastDot);
          if (/^[A-Z_][A-Z0-9_]*$/.test(tail) && isQualifiedClassChain(prefix)) {
            record(prefix);
          }
        }
      }
      i = j;
      continue;
    }
    i++;
  }
  return map;
}

/** Turns tokens from `annotationTokens(...)` into clickable spans resolved via `extractAnnotationClassMap(raw)`. */
export function linkAnnotationTokens(tokens: Token[], classMap: Map<string, string>): SourceSpan[] {
  const out: SourceSpan[] = [];
  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i];
    if (t.kind === 'ann' && t.text.length > 1) {
      const name = t.text.slice(1);
      const fqcn = classMap.get(name) ?? (/^[a-z_][\w$]*\.[A-Za-z0-9_.$]+$/.test(name) ? name : undefined);
      if (fqcn) {
        out.push({ text: t.text, kind: 'ann', target: fqcn, candidates: [fqcn] });
        i++;
        continue;
      }
    }
    if (t.kind === 'name' && i + 2 < tokens.length && tokens[i + 1].text === '.') {
      const hit = scanQualifiedTypeChain(tokens, i);
      if (hit) {
        for (let k = i; k < hit.firstTypeIdx; k++) out.push(tokens[k]);
        const display = tokens.slice(hit.firstTypeIdx, hit.endIdx + 1).map((x) => x.text).join('');
        const fqcn = classMap.get(hit.chain) ?? hit.chain;
        if (display) {
          out.push({ text: display, kind: 'type', target: fqcn, candidates: [fqcn] });
          i = hit.endIdx + 1;
          continue;
        }
      }
    }
    if (t.kind === 'type' && i + 2 < tokens.length && tokens[i + 1].text === '.' && tokens[i + 2].kind === 'type') {
      let j = i;
      let chain = t.text;
      while (j + 2 < tokens.length && tokens[j + 1].text === '.' && tokens[j + 2].kind === 'type') {
        chain += '.' + tokens[j + 2].text;
        j += 2;
      }
      const fqcn = classMap.get(chain);
      if (fqcn) {
        out.push({ text: chain, kind: 'type', target: fqcn, candidates: [fqcn] });
        i = j + 1;
        continue;
      }
    }
    if (t.kind === 'type') {
      const fqcn = classMap.get(t.text);
      if (fqcn) {
        out.push({ text: t.text, kind: 'type', target: fqcn, candidates: [fqcn] });
        i++;
        continue;
      }
    }
    out.push(t);
    i++;
  }
  return out;
}
