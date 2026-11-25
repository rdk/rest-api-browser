import { tokenizeSourceLine, type Token, type TokenKind } from './javatokens';

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
  /** 0-based line index of the declaration header. */
  line: number;
  depth: number;
}

const OUTLINE_TYPE_RE = /^\s*(?:(?:public|protected|private|static|final|abstract|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)/;
const OUTLINE_METHOD_RE = /^\s*((?:(?:public|protected|private|static|final|abstract|synchronized|native|default)\s+)*)(?:<[^>]+>\s+)?(?:([\w$.<>?,[\] ]+?)\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)/;
const CONTROL_KW = new Set(['if', 'for', 'while', 'switch', 'catch', 'synchronized', 'try', 'return', 'throw', 'new', 'else', 'do', 'assert', 'super', 'this']);
const REST_VERB_RE = /@(?:[\w$.]+\.)?(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/;
const SPRING_MAPPING_RE = /@(?:[\w$.]+\.)?(Get|Post|Put|Delete|Patch)Mapping\b/;
const REST_PATH_RE = /@(?:[\w$.]+\.)?Path\s*\(\s*(?:value\s*=\s*)?"([^"]*)"/;

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
  const typeStack: { name: string; depth: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const depthBefore = depth;
    const annDepthBefore = annParenDepth;

    // Update comment, annotation-argument paren depth, and brace depth across this line
    let inStr = false;
    let inChr = false;
    let afterAt = false; // true after '@' until whitespace/non-ident or '('
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
        afterAt = false;
        continue;
      }
      if (ch === '\'') {
        inChr = true;
        afterAt = false;
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
        afterAt = !raw.slice(c).startsWith('@interface');
      } else if (afterAt) {
        if (ch === '(') {
          annParenDepth = 1;
          afterAt = false;
        } else if (!/[\w$.\s]/.test(ch)) {
          afterAt = false;
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

    // Track REST annotations at class-body depth (even across multiline annotations or inline with the method)
    const currentType = typeStack[typeStack.length - 1];
    if (currentType && depthBefore === currentType.depth) {
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
      if (lineCode.includes('{')) {
        typeStack.push({ name, depth: targetDepth });
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

    const mm = OUTLINE_METHOD_RE.exec(declLine);
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
    if (!isCtor && pendingHttp) item.httpMethod = pendingHttp;
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
