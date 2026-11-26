import { findTemplates, spansSegments, splitSegments, trimModulePath, trimOpPath } from './template';

export interface RouteModule {
  id: string;
  path: string;
}

export interface RouteOp {
  module: string;
  method: string;
  path: string;
}

export interface RouteMatch<TOp extends RouteOp = RouteOp> {
  op: TOp;
  values: Record<string, string>;
  query: Record<string, string[]>;
}

export interface Matcher<TOp extends RouteOp = RouteOp> {
  match(url: string): RouteMatch<TOp> | null;
}

interface TemplateSeg {
  re: RegExp;
  names: string[];
  restricted: boolean;
}

interface TemplateBranch<TOp extends RouteOp> {
  seg: TemplateSeg;
  node: Node<TOp>;
}

interface RestSeg<TOp extends RouteOp> {
  seg: TemplateSeg;
  ops: TOp[];
}

interface Node<TOp extends RouteOp> {
  literal: Map<string, Node<TOp>>;
  templates: Map<string, TemplateBranch<TOp>>;
  sortedTemplates?: TemplateBranch<TOp>[];
  rests: Map<string, RestSeg<TOp>>;
  sortedRests?: RestSeg<TOp>[];
  ops: TOp[];
}

const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const newNode = <TOp extends RouteOp>(): Node<TOp> => ({
  literal: new Map(),
  templates: new Map(),
  rests: new Map(),
  ops: [],
});

const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function tryRegExp(source: string): RegExp | null {
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

const ANY = '[\\s\\S]+';

/** Compiles one JAX-RS path segment containing `{name[: regex]}` placeholders into a bounded RegExp. */
export function compileTemplate(src: string): TemplateSeg {
  const templates = findTemplates(src);
  const names = templates.map((t) => t.name);
  const build = (withRegex: boolean) => {
    let source = '^';
    let last = 0;
    let restricted = false;
    templates.forEach((t, i) => {
      source += escapeRegExp(src.slice(last, t.start));
      const valid = withRegex && t.regex && tryRegExp(`^(?:${t.regex})$`) ? t.regex : null;
      source += `(?<p${i}>${valid ?? ANY})`;
      if (valid) restricted = true;
      last = t.end;
    });
    return { re: tryRegExp(source + escapeRegExp(src.slice(last)) + '$'), restricted };
  };
  const full = build(true);
  if (full.re) return { re: full.re, names, restricted: full.restricted };
  return { re: build(false).re ?? new RegExp(`^${ANY}$`), names, restricted: false };
}

function insert<TOp extends RouteOp>(root: Node<TOp>, op: TOp): void {
  const segs = splitSegments(trimOpPath(op.path).replace(/\/+$/, ''));
  let node = root;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const templates = findTemplates(seg);
    if (!templates.length) {
      let next = node.literal.get(seg);
      if (!next) node.literal.set(seg, (next = newNode()));
      node = next;
      continue;
    }
    if (i === segs.length - 1 && templates.some((t) => spansSegments(t.regex))) {
      let rest = node.rests.get(seg);
      if (!rest) node.rests.set(seg, (rest = { seg: compileTemplate(seg), ops: [] }));
      rest.ops.push(op);
      return;
    }
    let next = node.templates.get(seg);
    if (!next) node.templates.set(seg, (next = { seg: compileTemplate(seg), node: newNode() }));
    node = next.node;
  }
  node.ops.push(op);
}

// Pre-sort template and catch-all branches once at trie build time instead of allocating + sorting on every match().
function finalizeNode<TOp extends RouteOp>(node: Node<TOp>): void {
  node.sortedTemplates = [...node.templates.values()].sort((a, b) => Number(b.seg.restricted) - Number(a.seg.restricted));
  node.sortedRests = [...node.rests.values()].sort((a, b) => Number(b.seg.restricted) - Number(a.seg.restricted));
  for (const child of node.literal.values()) finalizeNode(child);
  for (const branch of node.templates.values()) finalizeNode(branch.node);
}

interface Found<TOp extends RouteOp> {
  ops: TOp[];
  values: Record<string, string>;
}

function walk<TOp extends RouteOp>(node: Node<TOp>, segs: string[], i: number, values: Record<string, string>): Found<TOp> | null {
  if (i === segs.length && node.ops.length) return { ops: node.ops, values };
  if (i < segs.length) {
    const next = node.literal.get(segs[i]);
    if (next) {
      const r = walk(next, segs, i + 1, values);
      if (r) return r;
    }
    for (const t of node.sortedTemplates ?? []) {
      const m = t.seg.re.exec(segs[i]);
      if (!m) continue;
      const v = Object.assign(dict<string>(), values);
      t.seg.names.forEach((n, k) => (v[n] = m.groups?.[`p${k}`] ?? ''));
      const r = walk(t.node, segs, i + 1, v);
      if (r) return r;
    }
  }
  const remainder = segs.slice(i).join('/');
  for (const rest of node.sortedRests ?? []) {
    const m = rest.seg.re.exec(remainder);
    if (!m) continue;
    const v = Object.assign(dict<string>(), values);
    rest.seg.names.forEach((n, k) => (v[n] = m.groups?.[`p${k}`] ?? ''));
    return { ops: rest.ops, values: v };
  }
  return null;
}

function pick<TOp extends RouteOp>(ops: TOp[]): TOp {
  const rank = (o: TOp) => {
    const i = METHOD_ORDER.indexOf(o.method.toUpperCase());
    return i < 0 ? METHOD_ORDER.length : i;
  };
  return ops.reduce((best, o) => (rank(o) < rank(best) ? o : best));
}

function parseQuery(qs: string): Record<string, string[]> {
  const out = dict<string[]>();
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const name = safeDecode((eq < 0 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
    const value = eq < 0 ? '' : safeDecode(pair.slice(eq + 1).replace(/\+/g, ' '));
    (out[name] ??= []).push(value);
  }
  return out;
}

function restPath(baseUrl: string, path: string, mountPrefix = '/rest/'): string | null {
  const origin = typeof location !== 'undefined' ? location.origin : 'http://localhost';
  let base: URL;
  try {
    base = new URL(baseUrl, origin);
  } catch {
    return null;
  }
  let p = path;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
    let u: URL;
    try {
      u = new URL(p);
    } catch {
      return null;
    }
    if (u.origin !== base.origin) return null;
    p = u.pathname;
  } else if (!p.startsWith('/')) {
    p = '/' + p;
  }
  const prefix = base.pathname.replace(/\/+$/, '');
  if (prefix && p.startsWith(prefix + '/')) p = p.slice(prefix.length);
  return p.startsWith(mountPrefix) ? p.slice(mountPrefix.length) : null;
}

/** Builds a lazy longest-module-prefix radix router for JAX-RS resource paths under `mountPrefix`. */
export function createJaxRsMatcher<TOp extends RouteOp>(
  baseUrl: string,
  modules: readonly RouteModule[],
  operations: readonly TOp[],
  mountPrefix = '/rest/',
): Matcher<TOp> {
  let tries: { path: string; root: Node<TOp> }[] | null = null;

  function build() {
    const paths = new Map(modules.map((m) => [m.id, trimModulePath(m.path)]));
    const roots = new Map<string, Node<TOp>>();
    for (const path of paths.values()) if (!roots.has(path)) roots.set(path, newNode<TOp>());
    for (const op of operations) {
      const path = paths.get(op.module);
      if (path !== undefined) insert(roots.get(path)!, op);
    }
    for (const root of roots.values()) finalizeNode(root);
    return [...roots.entries()].map(([path, root]) => ({ path, root })).sort((a, b) => b.path.length - a.path.length);
  }

  return {
    match(url: string): RouteMatch<TOp> | null {
      const hash = url.indexOf('#');
      const noHash = hash < 0 ? url : url.slice(0, hash);
      const q = noHash.indexOf('?');
      const rest = restPath(baseUrl, q < 0 ? noHash : noHash.slice(0, q), mountPrefix);
      if (rest === null) return null;
      const query = q < 0 ? dict<string[]>() : parseQuery(noHash.slice(q + 1));
      const raw = rest.split('/');
      if (raw[raw.length - 1] === '') raw.pop();
      const segs = raw.map((s) => safeDecode(s.split(';')[0]));
      tries ??= build();
      for (const t of tries) {
        const own = t.path ? t.path.split('/') : [];
        if (own.length > segs.length || own.some((s, i) => s !== segs[i])) continue;
        const found = walk(t.root, segs.slice(own.length), 0, dict());
        if (found) return { op: pick(found.ops), values: found.values, query };
      }
      return null;
    },
  };
}
