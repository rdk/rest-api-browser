import { findTemplates } from './template';

/**
 * lead: the first resource word (bold, the text color); sub: the second (bold, its own color); text: a later one;
 * sep: "/"; param: a {template}; ver: a version segment; mod: the module's part of a full path.
 */
export type PartKind = 'text' | 'lead' | 'sub' | 'sep' | 'param' | 'ver' | 'mod';
export interface PathPart { text: string; kind: PartKind; hit?: boolean; }

/** "2", "1.0", "v3", "latest": a whole segment that only says which version of the API it is. */
const VERSION = /^(?:v?\d+(?:\.\d+)*|latest)$/i;

/**
 * The kind of each character of a path: separators, {templates}, version segments and the module prefix (its first
 * `prefix` characters) are told apart; of the resource words after the prefix, the first is the lead and the second
 * the sub, unless `rank` is false.
 */
export function pathKinds(path: string, opts: { prefix?: number; rank?: boolean } = {}): PartKind[] {
  const n = path.length;
  const kinds: PartKind[] = new Array(n).fill('text');
  for (const t of findTemplates(path)) for (let i = t.start; i < t.end; i++) kinds[i] = 'param';
  // separators outside templates (a template's regex may hold a slash); a segment that is all version is one
  const segments: [number, number][] = [];
  let start = 0;
  for (let i = 0; i <= n; i++) {
    if (i < n && (path[i] !== '/' || kinds[i] === 'param')) continue;
    if (i > start && VERSION.test(path.slice(start, i)) && kinds[start] !== 'param') {
      for (let k = start; k < i; k++) kinds[k] = 'ver';
    }
    if (i > start) segments.push([start, i]);
    if (i < n) kinds[i] = 'sep';
    start = i + 1;
  }
  const prefix = Math.min(opts.prefix ?? 0, n);
  for (let i = 0; i < prefix; i++) if (kinds[i] === 'text') kinds[i] = 'mod';
  if (opts.rank !== false) {
    let rank = 0;
    for (const [s, e] of segments) {
      if (rank === 2) break;
      let words = false;
      for (let k = s; k < e; k++) {
        if (kinds[k] === 'text') {
          kinds[k] = rank === 0 ? 'lead' : 'sub';
          words = true;
        }
      }
      if (words) rank++;
    }
  }
  return kinds;
}

/**
 * A path split for display, so its resource words stand out (see pathKinds), with the search's words marked where
 * they occur.
 */
export function pathParts(path: string, opts: { prefix?: number; words?: string[]; rank?: boolean } = {}): PathPart[] {
  const n = path.length;
  const kinds = pathKinds(path, opts);
  const hits: boolean[] = new Array(n).fill(false);
  const lower = path.toLowerCase();
  for (const raw of opts.words ?? []) {
    const w = raw.toLowerCase();
    if (!/[a-z0-9]/.test(w)) continue; // "/" or "-" alone would mark every separator
    for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + 1)) {
      for (let k = i; k < i + w.length; k++) hits[k] = true;
    }
  }

  const out: PathPart[] = [];
  for (let i = 0; i < n; ) {
    let j = i + 1;
    while (j < n && kinds[j] === kinds[i] && hits[j] === hits[i]) j++;
    out.push(hits[i] ? { text: path.slice(i, j), kind: kinds[i], hit: true } : { text: path.slice(i, j), kind: kinds[i] });
    i = j;
  }
  return out;
}

/** The search box's words, as the search splits them. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}
