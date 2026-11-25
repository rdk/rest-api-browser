import type { Token, TokenKind } from './javatokens';

/** A token of decompiled Java source, optionally linked to a decompilable Java class. */
export type SourceSpan =
  | { text: string; kind: TokenKind; target?: undefined; candidates?: undefined }
  | { text: string; kind: 'type' | 'ann'; target: string; candidates: string[] };

const PKG_RE = /^\s*package\s+([A-Za-z_][\w$.]*)\s*;/m;
const IMPORT_RE = /^\s*import\s+(?:static\s+)?([A-Za-z_][\w$.*]*)(\s*;)/gm;

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

interface RefContext {
  pkg: string;
  currentClass: string;
  explicit: Map<string, string>;
  wildcards: string[];
  exactRefs: Set<string>;
  bySimple: Map<string, string[]>;
  byTail: Map<string, string[]>;
}

function buildContext(source: string, currentClass: string, refs: string[]): RefContext {
  const pkgMatch = PKG_RE.exec(source);
  const pkg = pkgMatch ? pkgMatch[1] : packageOf(currentClass);
  const explicit = new Map<string, string>();
  const wildcards: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) {
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

function unique(list: string[]): string[] {
  return [...new Set(list.filter(Boolean))];
}

/** Resolves a simple, nested ("Response.Status") or qualified ("java.util.List") Java type name to ordered FQCN candidates. */
function resolveName(name: string, ctx: RefContext, isAnnotation: boolean): string[] {
  if (!name) return [];
  // Already package-qualified (starts with lowercase segment)
  if (/^[a-z_][\w$]*\.[A-Za-z0-9_.$]+$/.test(name)) {
    return [name];
  }
  // Nested type like Outer.Inner
  if (name.includes('.')) {
    const fromTail = ctx.byTail.get(name) ?? [];
    const parts = name.split('.');
    const headCandidates = resolveName(parts[0], ctx, false);
    const tail = parts.slice(1).join('$');
    const expanded = headCandidates.map((h) => `${h}$${tail}`);
    return unique([...fromTail, ...expanded]);
  }
  // Single-letter generic type parameters (T, E, K, V...) are not classes unless explicitly imported/referenced
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

/**
 * Turns tokens from `tokenizeSource` into clickable spans for every Java class and annotation reference.
 * Package declarations stay plain text; explicit imports, qualified names, nested types (`Outer.Inner`),
 * simple type names, and annotations become clickable spans carrying their resolved FQCN candidates.
 */
export function linkSourceTokens(tokens: Token[], source: string, currentClass: string, refs: string[] = []): SourceSpan[] {
  const ctx = buildContext(source, currentClass, refs);
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
        // Keep trailing package segments plain if followed by ".*" (wildcard import)
        const isWildcard = j + 2 < tokens.length && tokens[j + 1].text === '.' && tokens[j + 2].text === '*';
        if (!isWildcard) {
          const dot = chain.lastIndexOf('.');
          // Render package prefix plain and make the class (and nested classes) clickable, or make the whole FQCN clickable
          // Keep the first uppercase segment onward as a single clickable type span so styling stays consistent
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
