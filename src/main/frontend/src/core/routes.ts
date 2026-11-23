import { findTemplates, spansSegments, splitSegments, trimModulePath, trimOpPath } from './template';
import type { Index, Operation, Summary } from './types';

export interface RouteMatch {
  op: Operation;
  values: Record<string, string>;
  query: Record<string, string[]>;
}

export interface Matcher {
  match(url: string): RouteMatch | null;
}

interface TemplateSeg {
  re: RegExp;
  names: string[];
  restricted: boolean;   // has an explicit regex, so more specific than a plain {name}
}

interface RestSeg {
  seg: TemplateSeg;      // tested against the whole remaining path
  ops: Operation[];
}

interface Node {
  literal: Map<string, Node>;
  templates: Map<string, { seg: TemplateSeg; node: Node }>;
  rests: Map<string, RestSeg>;
  ops: Operation[];
}

const METHOD_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const newNode = (): Node => ({ literal: new Map(), templates: new Map(), rests: new Map(), ops: [] });

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Names from the URL go into maps without a prototype, so "constructor" or "__proto__" is a name like any other.
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// JAX-RS regexes are Java syntax; one that JavaScript rejects must not break the whole matcher.
function tryRegExp(source: string): RegExp | null {
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

// A plain {name} takes any text: match() decodes a segment first, so "a%2Fb" arrives as "a/b".
const ANY = '[\\s\\S]+';

function compileTemplate(src: string): TemplateSeg {
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
  // If the combined regex does not compile, fall back to plain segments; it keeps the named groups match() reads.
  const full = build(true);
  if (full.re) return { re: full.re, names, restricted: full.restricted };
  return { re: build(false).re ?? new RegExp(`^${ANY}$`), names, restricted: false };
}

function insert(root: Node, op: Operation): void {
  const segs = splitSegments(trimOpPath(op.path));
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
    // a last segment whose template may span segments (as request.ts sends it) matches the rest of the path
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

interface Found {
  ops: Operation[];
  values: Record<string, string>;
}

function walk(node: Node, segs: string[], i: number, values: Record<string, string>): Found | null {
  if (i === segs.length && node.ops.length) return { ops: node.ops, values };
  if (i < segs.length) {
    const next = node.literal.get(segs[i]);
    if (next) {
      const r = walk(next, segs, i + 1, values);
      if (r) return r;
    }
    const templates = [...node.templates.values()].sort((a, b) => Number(b.seg.restricted) - Number(a.seg.restricted));
    for (const t of templates) {
      const m = t.seg.re.exec(segs[i]);
      if (!m) continue;
      const v = Object.assign(dict<string>(), values);
      t.seg.names.forEach((n, k) => (v[n] = m.groups?.[`p${k}`] ?? ''));
      const r = walk(t.node, segs, i + 1, v);
      if (r) return r;
    }
  }
  const remainder = segs.slice(i).join('/');
  for (const rest of node.rests.values()) {
    const m = rest.seg.re.exec(remainder);
    if (!m) continue;
    const v = Object.assign(dict<string>(), values);
    rest.seg.names.forEach((n, k) => (v[n] = m.groups?.[`p${k}`] ?? ''));
    return { ops: rest.ops, values: v };
  }
  return null;
}

function pick(ops: Operation[]): Operation {
  const rank = (o: Operation) => {
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

// Returns the path below "/rest/", or null when the URL is not ours.
// baseUrl is the context path ("/jira", "" at the root); the page's origin is assumed.
function restPath(baseUrl: string, path: string): string | null {
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
  return p.startsWith('/rest/') ? p.slice('/rest/'.length) : null;
}

export function createMatcher(summary: Summary, index: Index): Matcher {
  let tries: { path: string; root: Node }[] | null = null;

  // One trie per module path, not per module: two modules on "api/2" share it, so a literal route of one beats a
  // template of the other, and the method preference works across them.
  function build() {
    const paths = new Map(summary.modules.map((m) => [m.id, trimModulePath(m.path)]));
    const roots = new Map<string, Node>();
    for (const path of paths.values()) if (!roots.has(path)) roots.set(path, newNode());
    for (const op of index.operations) {
      const path = paths.get(op.module);
      if (path !== undefined) insert(roots.get(path)!, op);
    }
    // Longest module path first, so "api/2/foo" is tried before "api".
    return [...roots.entries()].map(([path, root]) => ({ path, root })).sort((a, b) => b.path.length - a.path.length);
  }

  return {
    match(url: string): RouteMatch | null {
      const hash = url.indexOf('#');
      const noHash = hash < 0 ? url : url.slice(0, hash);
      const q = noHash.indexOf('?');
      const rest = restPath(summary.baseUrl, q < 0 ? noHash : noHash.slice(0, q));
      if (rest === null) return null;
      const query = q < 0 ? dict<string[]>() : parseQuery(noHash.slice(q + 1));
      const raw = rest.split('/');
      if (raw[raw.length - 1] === '') raw.pop();
      // ";matrix=params" belong to the request, not to the route.
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
