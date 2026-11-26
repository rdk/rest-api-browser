import { findTemplates } from './template';

/**
 * lead: the first resource word (bold, the text color); sub: the second (bold, its own color); text: a later one;
 * sep: "/"; param: a {template}; ver: a version segment; mod: the module's part of a full path.
 */
export type PartKind = 'text' | 'lead' | 'sub' | 'sep' | 'param' | 'ver' | 'mod';
export interface PathPart { text: string; kind: PartKind; hit?: boolean; }

/** "2", "1.0", "v3", "latest": a whole segment that only says which version of the API it is. */
const VERSION = /^(?:v?\d+(?:\.\d+)*|latest)$/i;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Classifies every character of a REST path for syntax coloring and hierarchy emphasis. */
export function pathKinds(path: string, opts: { prefix?: number; rank?: boolean } = {}): PartKind[] {
  const n = path.length;
  const kinds: PartKind[] = new Array(n).fill('text');
  for (const t of findTemplates(path)) for (let i = t.start; i < t.end; i++) kinds[i] = 'param';
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

/** Splits a path into colored segments with optional search-term hit highlights. */
export function pathParts(path: string, opts: { prefix?: number; words?: string[]; rank?: boolean } = {}): PathPart[] {
  const n = path.length;
  const kinds = pathKinds(path, opts);
  const hits: boolean[] = new Array(n).fill(false);
  const lower = path.toLowerCase();
  for (const raw of opts.words ?? []) {
    const w = raw.toLowerCase();
    if (!WORD_CHAR.test(w)) continue;
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

/** Splits a search query into lowercased whitespace-delimited tokens. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}
