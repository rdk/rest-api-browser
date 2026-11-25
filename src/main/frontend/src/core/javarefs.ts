import { tokenizeSourceLine, type Token, type TokenKind } from './javatokens';
import type { Module, Operation } from './types';

/** Declaration role for syntax highlighting (bold class/interface/enum/record and method/constructor names). */
export type DeclKind = 'type' | 'method';

/** A token of decompiled Java source, optionally linked to a decompilable Java class. */
export type SourceSpan =
  | { text: string; kind: TokenKind; decl?: DeclKind; target?: undefined; candidates?: undefined }
  | { text: string; kind: 'type' | 'ann'; decl?: DeclKind; target: string; candidates: string[] };

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

/**
 * Identifies token indices that name a class/interface/enum/record declaration or a method/constructor declaration so
 * the syntax renderer can style declaration identifiers bold without false-positiving on calls or expressions.
 */
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
  // 1. Class / interface / enum / record / @interface declaration name
  for (let i = start; i < end; i++) {
    const t = tokens[i];
    const isTypeKw = (t.kind === 'kw' && TYPE_DECL_KW.has(t.text)) || (t.kind === 'ann' && t.text === '@interface');
    if (!isTypeKw) continue;
    const prev = prevNonSpace(tokens, i - 1, start);
    if (prev >= start && tokens[prev].text === '.') continue; // skip Foo.class
    const next = nextNonSpace(tokens, i + 1, end);
    if (next < end && (tokens[next].kind === 'type' || tokens[next].kind === 'name')) {
      decls.set(next, 'type');
    }
  }

  // 2. Method / constructor declaration name
  let p = nextNonSpace(tokens, start, end);
  // Skip leading inline annotations (e.g. "@GET public Response foo()")
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
  // Skip optional method-level generic parameters: <T extends Foo>
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

  // Scan up to the opening '(' of the parameter list
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
      if (angle === 0) return; // comparison operator, not generic type
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
    // Constructor: directly after modifiers (or package-private constructor matching current class name)
    if (nameTok.kind === 'type' && (sawModifier || (curSimple && nameTok.text === curSimple))) {
      decls.set(nameIdx, 'method');
    }
    return;
  }

  // Regular method: preceded by a return type token (not '.' or ',')
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
        out.push(decl ? { text: t.text, kind: 'type', decl, target: candidates[0], candidates } : { text: t.text, kind: 'type', target: candidates[0], candidates });
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

    out.push(decl ? { text: t.text, kind: t.kind, decl } : t);
    i++;
  }
  // Coalesce adjacent plain-text tokens (space/name) so virtualized lines emit fewer VNodes while scrolling
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
const REST_PATH_RE = /@(?:[\w$.]+\.)?(?:Path|RequestMapping|(?:Get|Post|Put|Delete|Patch)Mapping)\s*\(\s*(?:(?:value|path)\s*=\s*)?(?:\{\s*)?"([^"]*)"/;

/**
 * Strips inline type-use annotations (e.g. `@NotNull`, `@Nullable`) and balanced generic method type parameter lists
 * (e.g. `<T extends Comparable<T>>`) from the prefix before `(` so `OUTLINE_METHOD_RE` matches Kotlin/JSR-308 headers.
 */
function normalizeMethodHeader(declLine: string): string {
  const paren = declLine.indexOf('(');
  if (paren <= 0) return declLine;
  const prefix = declLine.slice(0, paren);
  const rest = declLine.slice(paren);
  // Strip any inline `@Ann` / `@Ann(...)` type-use annotations in the header prefix (between modifiers / in return type)
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
          while (pos < prefix.length && d > 0) {
            if (prefix[pos] === '(') d++;
            else if (prefix[pos] === ')') d--;
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
  // Strip balanced leading method type parameters `<...>` after modifiers (e.g. `public <T extends Comparable<T>> T max`)
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
        } else if (ch === '"') {
          inStr = true;
        } else if (ch === '(') {
          depth++;
        } else if (ch === ')') {
          depth--;
        }
        pos++;
      }
      if (depth > 0) return ''; // multiline annotation continues on next line
    }
    s = s.slice(pos).trimStart();
  }
  return s;
}

/**
 * Extracts constructors, methods, and nested types from decompiled Java source lines for the collapsible outline panel,
 * including REST HTTP method markers (@GET, @POST, @PUT, @DELETE, @PATCH, @HEAD, @OPTIONS, and Spring *Mapping).
 * Tracks brace depth and annotation argument parentheses so array literals inside multiline annotations
 * (e.g. `@Operation(responses = { @ApiResponse(...) })`) never corrupt brace depth or drop pending HTTP verbs.
 */
export function extractClassOutline(lines: string[]): OutlineItem[] {
  const items: OutlineItem[] = [];
  let depth = 0;
  let inBlock = false;
  let annParenDepth = 0;
  let pendingHttp: HttpMethod | undefined;
  let pendingPath: string | undefined;
  let pendingType: { name: string; depth: number; restPath?: string } | undefined;
  const typeStack: { name: string; depth: number; restPath?: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const depthBefore = depth;
    const annDepthBefore = annParenDepth;

    // Update comment, annotation-argument paren depth, and brace depth across this line
    let inStr = false;
    let inChr = false;
    // 0 = outside annotation name, 1 = reading `@Name`, 2 = whitespace right after `@Name` (only `(` may follow)
    let annState: 0 | 1 | 2 = 0;
    let lineCode = '';
    for (let c = 0; c < raw.length; c++) {
      const ch = raw[c];
      const next = c + 1 < raw.length ? raw[c + 1] : '';
      if (inBlock) {
        if (ch === '*' && next === '/') {
          inBlock = false;
          c++;
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
      if (ch === '/' && next === '/') break;
      if (ch === '/' && next === '*') {
        inBlock = true;
        c++;
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
        // Braces inside annotation arguments (e.g. responses = { ... }) are array literals, not code blocks
        continue;
      }
      if (ch === '@') {
        // Ignore `@interface` (annotation type declaration)
        annState = raw.slice(c).startsWith('@interface') ? 0 : 1;
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

    // Continuation line of a multiline annotation (e.g. @Operation(...))
    if (annDepthBefore > 0) {
      continue;
    }

    const codeTrim = lineCode.trim();
    if (!codeTrim || codeTrim.startsWith('package ') || codeTrim.startsWith('import ')) {
      continue;
    }

    // Complete a multiline class/interface/enum/record header whose opening `{` appeared on a later line (common in CFR)
    if (pendingType) {
      if (depth >= pendingType.depth) {
        typeStack.push(pendingType);
        pendingType = undefined;
        continue;
      }
      if (lineCode.includes('{') || codeTrim.endsWith(';')) {
        // Opened and closed on the same line (e.g. `implements Marker {}`) or terminated without a body
        pendingType = undefined;
      }
      continue;
    }

    // Track REST annotations at class-declaration depth (depth 0) and class-body depth
    const currentType = typeStack[typeStack.length - 1];
    const atDeclDepth = depthBefore === 0 || (currentType && depthBefore === currentType.depth);
    if (atDeclDepth) {
      if (codeTrim.startsWith('@') && !codeTrim.startsWith('@interface')) {
        const vm = REST_VERB_RE.exec(codeTrim);
        if (vm) pendingHttp = vm[1] as HttpMethod;
        else {
          const sm = SPRING_MAPPING_RE.exec(codeTrim);
          if (sm) pendingHttp = sm[1].toUpperCase() as HttpMethod;
        }
        const pm = REST_PATH_RE.exec(raw);
        if (pm) pendingPath = pm[1];
        if (annParenDepth > 0) continue; // multiline annotation opened on this line
        const afterAnn = stripLeadingAnnotations(codeTrim);
        if (!afterAnn) continue;
        // Inline annotation followed by declaration on the same line: fall through using `afterAnn`
      }
    }

    const declLine = codeTrim.startsWith('@') && !codeTrim.startsWith('@interface')
      ? stripLeadingAnnotations(codeTrim)
      : codeTrim;
    if (!declLine) continue;

    // Class / interface / enum / record declaration
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

    // Member declaration directly inside a class body
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
    const rawParams = collectCompactParams(lines, i, name);
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

function collectCompactParams(lines: string[], startLine: number, methodName: string): string {
  const openPos = lines[startLine].indexOf('(', lines[startLine].indexOf(methodName));
  if (openPos < 0) return '()';
  let depthParen = 0;
  let buf = '';
  outer:
  for (let i = startLine; i < Math.min(lines.length, startLine + 12); i++) {
    const line = lines[i];
    const from = i === startLine ? openPos : 0;
    for (let c = from; c < line.length; c++) {
      const ch = line[c];
      if (ch === '(') {
        depthParen++;
        if (depthParen > 1) buf += ch;
      } else if (ch === ')') {
        depthParen--;
        if (depthParen === 0) break outer;
        buf += ch;
      } else if (depthParen >= 1) {
        buf += ch;
      }
    }
    buf += ' ';
  }
  const clean = buf.replace(/@[\w$.]+(?:\([^)]*\))?\s*/g, '').replace(/\bfinal\s+/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return '()';
  // Extract just the parameter types (drop trailing parameter names)
  const parts: string[] = [];
  let angle = 0;
  let cur = '';
  for (const ch of clean) {
    if (ch === '<') angle++;
    else if (ch === '>' && angle > 0) angle--;
    if (ch === ',' && angle === 0) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  const types = parts.map((p) => {
    const m = /^(.+?)\s+[a-z_$][\w$]*$/.exec(p);
    const t = m ? m[1].trim() : p;
    return t.replace(/\b(?:[a-z_][\w]*\.)+(?=[A-Z_$])/g, '');
  });
  return `(${types.join(', ')})`;
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

/**
 * Extracts a lookup map of short/display/qualified Java names -> FQCN from a raw annotation string produced by
 * OperationDetails (where every nested @Annotation, Class literal, and Enum constant carries its full package name).
 */
export function extractAnnotationClassMap(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw) return map;
  // Strip quoted string and char literals so package-like text inside descriptions is never mistaken for a class name
  const code = raw.replace(/"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?/g, '""');
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
  // 1. All @package.Annotation names (top-level and nested)
  for (const m of code.matchAll(/@([a-z_][\w$]*(?:\.[a-z_][\w$]*)*\.[A-Z_$][\w$]*(?:\$[A-Z_$][\w$]*)*)/g)) {
    record(m[1]);
  }
  // 2. All Class literals (pkg.Foo.class, pkg.Foo[].class) and Enum types (pkg.Thread$State.BLOCKED)
  for (const m of code.matchAll(/(?<![@.\w$])([a-z_][\w$]*(?:\.[a-z_][\w$]*)*\.[A-Z_$][\w$]*(?:\$[A-Z_$][\w$]*)*)(?=\s*(?:\[\s*\])*\s*\.class\b|\.[A-Z_][A-Z0-9_]*\b)/g)) {
    record(m[1]);
  }
  return map;
}

/**
 * Turns tokens from `annotationTokens(...)` into clickable spans for every nested `@Annotation` and every class/enum
 * type resolved via `extractAnnotationClassMap(raw)`.
 */
export function linkAnnotationTokens(tokens: Token[], classMap: Map<string, string>): SourceSpan[] {
  const out: SourceSpan[] = [];
  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i];
    // Annotation token (@ApiResponses, @Schema, @io.swagger.v3.oas.annotations.media.Schema)
    if (t.kind === 'ann' && t.text.length > 1) {
      const name = t.text.slice(1);
      const fqcn = classMap.get(name) ?? (/^[a-z_][\w$]*\.[A-Za-z0-9_.$]+$/.test(name) ? name : undefined);
      if (fqcn) {
        out.push({ text: t.text, kind: 'ann', target: fqcn, candidates: [fqcn] });
        i++;
        continue;
      }
    }
    // Qualified package.Class(.Inner)* chain when Full names is enabled (stops before .class or .ENUM_CONST)
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
        let firstTypeIdx = i;
        while (firstTypeIdx <= j && tokens[firstTypeIdx].kind !== 'type') {
          out.push(tokens[firstTypeIdx]);
          firstTypeIdx++;
        }
        const display = tokens.slice(firstTypeIdx, j + 1).map((x) => x.text).join('');
        const fqcn = classMap.get(chain) ?? chain;
        if (display) {
          out.push({ text: display, kind: 'type', target: fqcn, candidates: [fqcn] });
          i = j + 1;
          continue;
        }
      }
    }
    // Nested Outer.Inner type chain when Full names is off (e.g. Thread.State.BLOCKED)
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
    // Single type token (e.g. RestUsageInfoResponse in @Schema(implementation = RestUsageInfoResponse.class))
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

/**
 * Normalizes a JAX-RS / REST path for matching between decompiled `@Path` annotations and catalog operation paths:
 * strips leading/trailing slashes, collapses duplicate slashes, and replaces `{param[: regex]}` templates with `{}`.
 */
export function normalizeRestPath(path: string): string {
  return path
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/')
    .replace(/\{[^}]*\}/g, '{}');
}

export interface MatchedEndpoint {
  op: Operation;
  /** Full display path including module base (e.g. "/rest/api/2/serverInfo"). */
  fullPath: string;
}

/**
 * Matches REST-annotated methods in a decompiled class's outline to concrete catalog operations so the source viewer
 * can render an "open in new tab" link directly beside each REST endpoint method declaration.
 */
export function matchOutlineEndpoints(
  outline: OutlineItem[],
  operations: Operation[],
  modulesById: Map<string, Module>,
  contextOpKey?: string,
  focusMethod?: string,
): Map<number, MatchedEndpoint> {
  const result = new Map<number, MatchedEndpoint>();
  if (!outline.length || !operations.length) return result;

  const restItems = outline.filter((o) => o.kind === 'method' && o.httpMethod);
  if (!restItems.length) return result;

  let contextOp: Operation | undefined;
  const byMethod = new Map<string, { op: Operation; norm: string }[]>();
  for (const op of operations) {
    if (contextOpKey && op.key === contextOpKey) contextOp = op;
    const m = op.method.toUpperCase();
    let list = byMethod.get(m);
    if (!list) {
      list = [];
      byMethod.set(m, list);
    }
    list.push({ op, norm: normalizeRestPath(op.path) });
  }
  const contextModuleId = contextOp?.module;
  const contextPluginKey = contextModuleId ? modulesById.get(contextModuleId)?.plugin.key : undefined;

  const pickBest = (candidates: Operation[]): Operation | undefined => {
    if (!candidates.length) return undefined;
    if (candidates.length === 1) return candidates[0];
    if (contextOpKey) {
      const exact = candidates.find((o) => o.key === contextOpKey);
      if (exact) return exact;
    }
    if (contextModuleId) {
      const sameMod = candidates.filter((o) => o.module === contextModuleId);
      if (sameMod.length) candidates = sameMod;
    }
    if (contextPluginKey && candidates.length > 1) {
      const samePlugin = candidates.filter((o) => modulesById.get(o.module)?.plugin.key === contextPluginKey);
      if (samePlugin.length) candidates = samePlugin;
    }
    if (candidates.length > 1) {
      const active = candidates.filter((o) => !o.deprecated);
      if (active.length) candidates = active;
    }
    return candidates[0];
  };

  const toMatched = (op: Operation): MatchedEndpoint => {
    const mod = modulesById.get(op.module);
    const modPath = mod ? mod.path.replace(/^\/+|\/+$/g, '') : '';
    const opPath = op.path.replace(/^\/+/, '');
    const fullPath = modPath ? `/rest/${modPath}${opPath ? '/' + opPath : ''}` : `/${opPath}`;
    return { op, fullPath };
  };

  for (const item of restItems) {
    const method = item.httpMethod!;
    const pool = byMethod.get(method) ?? [];
    let matched: Operation | undefined;

    if (item.fullRestPath !== undefined) {
      const targetNorm = normalizeRestPath(item.fullRestPath);
      // 1. Exact normalized path match
      const exact = pool.filter((e) => e.norm === targetNorm).map((e) => e.op);
      matched = pickBest(exact);
      // 2. Sub-resource suffix match (for classes reached via a parent resource locator)
      if (!matched && targetNorm) {
        const suffix = pool.filter((e) => e.norm.endsWith('/' + targetNorm)).map((e) => e.op);
        if (suffix.length === 1) {
          matched = suffix[0];
        } else if (suffix.length > 1 && contextModuleId) {
          const sameMod = suffix.filter((o) => o.module === contextModuleId);
          if (sameMod.length === 1) matched = sameMod[0];
        }
      }
    }

    // 3. Fallback for the exact handler method of the operation that opened this class
    if (!matched && contextOp && focusMethod && item.name === focusMethod && contextOp.method.toUpperCase() === method) {
      matched = contextOp;
    }

    if (matched) {
      result.set(item.line, toMatched(matched));
    }
  }
  return result;
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
