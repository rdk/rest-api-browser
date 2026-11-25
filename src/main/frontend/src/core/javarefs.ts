import { tokenizeSourceLine, type Token, type TokenKind } from './javatokens';

/** A token of decompiled Java source, optionally linked to a decompilable Java class. */
export type SourceSpan =
  | { text: string; kind: TokenKind; target?: undefined; candidates?: undefined }
  | { text: string; kind: 'type' | 'ann'; target: string; candidates: string[] };

const PKG_RE = /^\s*package\s+([A-Za-z_][\w$.]*)\s*;/m;
const IMPORT_RE = /^\s*import\s+(?:static\s+)?([A-Za-z_][\w$.*]*)(\s*;)/gm;
const PRIMITIVES = new Set(['void', 'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double']);

function packageOf(fqcn: string): string {
  const dot = fqcn.lastIndexOf('.');
  return dot > 0 ? fqcn.slice(0, dot) : '';
}

function simpleName(fqcn: string): string {
  const sep = Math.max(fqcn.lastIndexOf('.'), fqcn.lastIndexOf('$'));
  return sep >= 0 ? fqcn.slice(sep + 1) : fqcn;
}

/** Short display label for a class tab: "ServerInfoBean" or "Response.Status" for nested classes. */
export function classLabel(fqcn: string): string {
  const dot = fqcn.lastIndexOf('.');
  const tail = dot >= 0 ? fqcn.slice(dot + 1) : fqcn;
  return tail.replace(/\$/g, '.');
}

export interface RefContext {
  pkg: string;
  currentClass: string;
  explicit: Map<string, string>;
  wildcards: string[];
  exactRefs: Set<string>;
  bySimple: Map<string, string[]>;
  byTail: Map<string, string[]>;
}

/** Builds a reusable class-reference resolution context from source package/imports and bytecode constant-pool refs. */
export function createRefContext(source: string, currentClass: string, refs: string[] = []): RefContext {
  // Package and imports always appear near the top of a decompiled file; avoid regex scanning 200 KB bodies
  const headerEnd = findHeaderEnd(source);
  const header = headerEnd < source.length ? source.slice(0, headerEnd) : source;
  const pkgMatch = PKG_RE.exec(header);
  const pkg = pkgMatch ? pkgMatch[1] : packageOf(currentClass);
  const explicit = new Map<string, string>();
  const wildcards: string[] = [];
  for (const m of header.matchAll(IMPORT_RE)) {
    const imp = m[1];
    if (imp.endsWith('.*')) {
      wildcards.push(imp.slice(0, -2));
    } else if (!m[0].includes('import static ')) {
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
  return { pkg, currentClass, explicit, wildcards, exactRefs, bySimple, byTail };
}

function findHeaderEnd(source: string): number {
  // Imports always precede the first top-level type opening brace '{'
  const brace = source.indexOf('{');
  return brace >= 0 ? brace : Math.min(source.length, 16_384);
}

function unique(list: string[]): string[] {
  return [...new Set(list.filter(Boolean))];
}

/** Resolves a simple, nested ("Response.Status") or qualified ("java.util.List") Java type name to ordered FQCN candidates. */
function resolveName(name: string, ctx: RefContext, isAnnotation: boolean): string[] {
  if (!name) return [];
  if (/^[a-z_][\w$]*\.[A-Za-z0-9_.$]+$/.test(name)) {
    return [name];
  }
  if (name.includes('.')) {
    const fromTail = ctx.byTail.get(name) ?? [];
    const parts = name.split('.');
    const headCandidates = resolveName(parts[0], ctx, false);
    const tail = parts.slice(1).join('$');
    const expanded = headCandidates.map((h) => `${h}$${tail}`);
    return unique([...fromTail, ...expanded]);
  }
  if (name.length === 1 && !ctx.explicit.has(name) && !ctx.bySimple.has(name)) {
    return [];
  }
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
  return unique(out);
}

/** Turns tokens from `tokenizeSource` into clickable spans for every Java class and annotation reference. */
export function linkSourceTokens(tokens: Token[], source: string, currentClass: string, refs: string[] = []): SourceSpan[] {
  return linkTokensWithContext(tokens, createRefContext(source, currentClass, refs));
}

/** Lazily tokenizes and links a single line of decompiled source for virtualized rendering. */
export function linkSourceLine(line: string, startsInComment: boolean, ctx: RefContext): SourceSpan[] {
  if (!line) return [];
  return linkTokensWithContext(tokenizeSourceLine(line, startsInComment), ctx);
}

export function linkTokensWithContext(tokens: Token[], ctx: RefContext): SourceSpan[] {
  const out: SourceSpan[] = [];
  let inPackage = false;

  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i];
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

    // Qualified package.Class(.Inner)* chain (e.g. "com.atlassian.sal.api.ApplicationProperties" or "import a.b.Foo;")
    if (t.kind === 'name' && i + 2 < tokens.length && tokens[i + 1].text === '.') {
      let j = i;
      let sawType = false;
      let chain = t.text;
      while (j + 2 < tokens.length && tokens[j + 1].text === '.') {
        const next = tokens[j + 2];
        if (next.kind === 'name' || next.kind === 'type') {
          chain += '.' + next.text;
          if (next.kind === 'type') sawType = true;
          j += 2;
        } else {
          break;
        }
      }
      if (sawType) {
        const isWildcard = j + 2 < tokens.length && tokens[j + 1].text === '.' && tokens[j + 2].text === '*';
        if (!isWildcard) {
          const dot = chain.lastIndexOf('.');
          let firstTypeIdx = i;
          while (firstTypeIdx <= j && tokens[firstTypeIdx].kind !== 'type') {
            out.push(tokens[firstTypeIdx]);
            firstTypeIdx++;
          }
          const display = tokens.slice(firstTypeIdx, j + 1).map((x) => x.text).join('');
          if (dot > 0 && display) {
            out.push({ text: display, kind: 'type', target: chain, candidates: [chain] });
            i = j + 1;
            continue;
          }
        }
      }
    }

    // Nested Type.Inner chain (e.g. "Response.Status" or "Map.Entry")
    if (t.kind === 'type' && i + 2 < tokens.length && tokens[i + 1].text === '.' && tokens[i + 2].kind === 'type') {
      let j = i;
      let chain = t.text;
      while (j + 2 < tokens.length && tokens[j + 1].text === '.' && tokens[j + 2].kind === 'type') {
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

    // Single type token
    if (t.kind === 'type') {
      const candidates = resolveName(t.text, ctx, false);
      if (candidates.length > 0) {
        out.push({ text: t.text, kind: 'type', target: candidates[0], candidates });
        i++;
        continue;
      }
    }

    // Annotation token (@Operation, @jakarta.ws.rs.GET)
    if (t.kind === 'ann' && t.text.length > 1) {
      const raw = t.text.slice(1);
      const candidates = resolveName(raw, ctx, true);
      if (candidates.length > 0) {
        out.push({ text: t.text, kind: 'ann', target: candidates[0], candidates });
        i++;
        continue;
      }
    }

    out.push(t);
    i++;
  }
  return out;
}

/**
 * Finds the 0-based line index of the first line of the declaration header of `methodName` in decompiled class lines.
 * When overloaded and `paramCount` is provided, prefers the overload with the matching number of parameters.
 */
export function findMethodHeaderLine(lines: string[], methodName: string, paramCount?: number): number {
  if (!methodName || !lines.length) return -1;
  const escaped = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `^\\s{0,12}(?:(?:public|protected|private|static|final|abstract|synchronized|native|default)\\s+)*`
      + `(?:<[^>]+>\\s+)?[\\w$.<>?, \\[\\]]+\\s+${escaped}\\s*\\(`,
  );
  const hits: number[] = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*') && !trimmed.includes('*/')) {
      inBlock = true;
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('return ') || trimmed.startsWith('new ')) {
      continue;
    }
    if (re.test(lines[i])) {
      hits.push(i);
    }
  }
  if (!hits.length) return -1;
  if (hits.length === 1 || paramCount === undefined) return hits[0];
  for (const idx of hits) {
    const counted = countParamsAt(lines, idx, methodName);
    if (counted === paramCount) return idx;
  }
  return hits[0];
}

function countParamsAt(lines: string[], startLine: number, methodName: string): number {
  const openPos = lines[startLine].indexOf('(', lines[startLine].indexOf(methodName));
  if (openPos < 0) return -1;
  let depthParen = 0;
  let depthAngle = 0;
  let seenContent = false;
  let commas = 0;
  for (let i = startLine; i < Math.min(lines.length, startLine + 25); i++) {
    const line = lines[i];
    const from = i === startLine ? openPos : 0;
    for (let c = from; c < line.length; c++) {
      const ch = line[c];
      if (ch === '(') {
        depthParen++;
      } else if (ch === ')') {
        depthParen--;
        if (depthParen === 0) return seenContent ? commas + 1 : 0;
      } else if (ch === '<') {
        depthAngle++;
      } else if (ch === '>') {
        if (depthAngle > 0) depthAngle--;
      } else if (ch === ',' && depthParen === 1 && depthAngle === 0) {
        commas++;
      } else if (depthParen === 1 && !/\s/.test(ch)) {
        seenContent = true;
      }
    }
  }
  return -1;
}

export interface TypePart {
  text: string;
  fqcn?: string;
}

/**
 * Splits a Java type expression (e.g. "java.util.List<com.atlassian.jira.rest.v2.issue.IssueBean>") into display
 * fragments, where each non-primitive class name carries its FQCN so the UI can make it clickable and tooltip-enabled.
 */
export function parseJavaTypeParts(typeExpr: string, showFull = false): TypePart[] {
  if (!typeExpr) return [];
  const out: TypePart[] = [];
  const re = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)|([^A-Za-z_$]+)/g;
  for (const m of typeExpr.matchAll(re)) {
    const [, ident, other] = m;
    if (other !== undefined) {
      out.push({ text: other });
      continue;
    }
    if (PRIMITIVES.has(ident) || ident === 'extends' || ident === 'super') {
      out.push({ text: ident });
      continue;
    }
    // Single-letter type variables like T, E, K, V
    if (ident.length === 1 && !ident.includes('.')) {
      out.push({ text: ident });
      continue;
    }
    const display = showFull ? ident.replace(/\$/g, '.') : classLabel(ident);
    out.push({ text: display, fqcn: ident });
  }
  return out;
}

/** Maps catalog shorthand parameter types ("string", "int", "File") to a Java class FQCN when no `javaType` is given. */
export function fallbackJavaType(paramType: string): string | undefined {
  switch (paramType.toLowerCase()) {
    case 'string': return 'java.lang.String';
    case 'int':
    case 'integer': return 'java.lang.Integer';
    case 'long': return 'java.lang.Long';
    case 'boolean': return 'java.lang.Boolean';
    case 'number':
    case 'double': return 'java.lang.Double';
    case 'float': return 'java.lang.Float';
    case 'file': return 'com.atlassian.plugins.rest.api.multipart.FilePart';
    default: return /^[A-Z]/.test(paramType) ? paramType : undefined;
  }
}
