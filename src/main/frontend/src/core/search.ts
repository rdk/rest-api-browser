import type { Index, Module, Operation, Origin, Stability, Summary } from './types';

export interface SearchRow {
  op: Operation;
  module: Module;
  hay: string;        // lowercased: method, full path, plugin name
  path: string;       // lowercased module path + "/" + op path
  rank: number;       // 0 supported, 1 internal, 2 app
  stability: Stability;
  origin: Origin;
}

export interface Filters {
  supportedOnly?: boolean;
  methods?: string[];  // 'OTHER' means anything but GET, POST, PUT, PATCH, DELETE
}

const STABILITY_RANK: Record<Stability, number> = { supported: 0, internal: 1, app: 2 };
const MAIN_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const ORIGIN_ORDER: Origin[] = ['product', 'bundled', 'user'];

export function buildRows(summary: Summary, index: Index): SearchRow[] {
  const modules = new Map(summary.modules.map((m) => [m.id, m]));
  const rows: SearchRow[] = [];
  for (const op of index.operations) {
    const module = modules.get(op.module);
    if (!module) continue;
    const path = `${module.path}/${op.path}`.toLowerCase();
    rows.push({
      op,
      module,
      path,
      hay: `${op.method} ${path} ${module.plugin.name}`.toLowerCase(),
      rank: STABILITY_RANK[module.stability],
      stability: module.stability,
      origin: module.origin,
    });
  }
  return rows;
}

function methodAllowed(method: string, methods: Set<string>): boolean {
  const m = method.toUpperCase();
  return methods.has(m) || (methods.has('OTHER') && !MAIN_METHODS.includes(m));
}

// Number of tokens that occur at the start of a path segment.
function segmentHits(path: string, tokens: string[]): number {
  let hits = 0;
  for (const t of tokens) {
    for (let i = path.indexOf(t); i >= 0; i = path.indexOf(t, i + 1)) {
      if (i === 0 || path[i - 1] === '/' || path[i - 1] === '{') {
        hits++;
        break;
      }
    }
  }
  return hits;
}

export function search(rows: SearchRow[], query: string, filters: Filters = {}): SearchRow[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const methods = filters.methods && filters.methods.length ? new Set(filters.methods.map((m) => m.toUpperCase())) : null;
  const hits: { row: SearchRow; seg: number }[] = [];
  outer: for (const row of rows) {
    if (filters.supportedOnly && row.stability !== 'supported') continue;
    if (methods && !methodAllowed(row.op.method, methods)) continue;
    for (const t of tokens) if (!row.hay.includes(t)) continue outer;
    hits.push({ row, seg: tokens.length ? segmentHits(row.path, tokens) : 0 });
  }
  if (!tokens.length) {
    // browse mode: groupRows re-sorts per module, so a stable partition by rank is enough
    return hits.map((h) => h.row).sort((a, b) => a.rank - b.rank);
  }
  hits.sort(
    (a, b) =>
      a.row.rank - b.row.rank ||
      b.seg - a.seg ||
      a.row.path.length - b.row.path.length ||
      (a.row.path < b.row.path ? -1 : a.row.path > b.row.path ? 1 : 0) ||
      byMethod(a.row.op.method, b.row.op.method),
  );
  return hits.map((h) => h.row);
}

export type GroupRow = { kind: 'module'; module: Module; count: number } | { kind: 'op'; op: Operation };

function methodOrder(method: string): number {
  const i = MAIN_METHODS.indexOf(method.toUpperCase());
  return i < 0 ? MAIN_METHODS.length : i;
}

// GET, POST, PUT, PATCH, DELETE, then the others by name.
function byMethod(a: string, b: string): number {
  return methodOrder(a) - methodOrder(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * The list in modules: each module's row, then its operations unless it is collapsed. Failed and pending modules
 * show even without operations, so their state is seen; with `supportedOnly` only the supported ones do.
 */
export function groupRows(
  summary: Summary,
  rows: SearchRow[],
  collapsed: Set<string> = new Set(),
  opts: { supportedOnly?: boolean } = {},
): GroupRow[] {
  const byModule = new Map<string, SearchRow[]>();
  for (const row of rows) {
    const list = byModule.get(row.module.id);
    if (list) list.push(row);
    else byModule.set(row.module.id, [row]);
  }
  const modules = summary.modules
    .filter((m) => byModule.has(m.id) || (m.state !== 'ok' && (!opts.supportedOnly || m.stability === 'supported')))
    .sort(
      (a, b) =>
        ORIGIN_ORDER.indexOf(a.origin) - ORIGIN_ORDER.indexOf(b.origin) ||
        STABILITY_RANK[a.stability] - STABILITY_RANK[b.stability] ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const out: GroupRow[] = [];
  for (const module of modules) {
    const list = byModule.get(module.id) ?? [];
    out.push({ kind: 'module', module, count: list.length });
    if (collapsed.has(module.id)) continue;
    const sorted = [...list].sort(
      (a, b) =>
        (a.op.path < b.op.path ? -1 : a.op.path > b.op.path ? 1 : 0) || byMethod(a.op.method, b.op.method),
    );
    for (const row of sorted) out.push({ kind: 'op', op: row.op });
  }
  return out;
}
