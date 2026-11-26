import type { RequestValues } from './request';

/** What the form holds: the values, the extra headers and the XSRF switch; not the response. */
export interface FormState {
  values: RequestValues;
  custom: { name: string; value: string }[];
  noXsrfHeader: boolean;
}

/** The undo and redo steps of one operation's form; `last` lets a run of keys in one field make one step. */
export interface FormHistory {
  undo: FormState[];
  redo: FormState[];
  last?: { field: string; at: number };
}

/** Steps kept per operation; older ones are dropped. */
export const UNDO_STEPS = 100;
/** Changes of the same field closer than this make one step (typing a word is one undo). */
const TYPING_MS = 1000;

export const NO_HISTORY: FormHistory = { undo: [], redo: [] };

const sameValue = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.hasOwn(b as object, k)) return false;
      if (!sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    }
    return true;
  }
  return false;
};

const sameCustom = (a: FormState['custom'], b: FormState['custom']): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].value !== b[i].value) return false;
  }
  return true;
};

// What the form shows the same: '' as no value, [] and [''] as no query value, rows of empty headers as none.
const blankValue = (v: unknown) => v === undefined || v === '' || (Array.isArray(v) && (v.length === 0 || (v.length === 1 && v[0] === '')));
const looks = (a: unknown, b: unknown) => (blankValue(a) && blankValue(b)) || sameValue(a, b);
const noRows = (rows: FormState['custom']) => rows.every((h) => !h.name.trim() && !h.value.trim());
const sameRows = (a: FormState['custom'], b: FormState['custom']) => (noRows(a) && noRows(b)) || sameCustom(a, b);

// A name's own value: names come from links too, and "constructor" must not read Object.prototype's.
const own = (map: Record<string, unknown>, name: string) => (Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined);

const sameFiles = (a: File[] | undefined, b: File[] | undefined): boolean => {
  const la = a ?? [];
  const lb = b ?? [];
  if (la.length !== lb.length) return false;
  for (let i = 0; i < la.length; i++) {
    if (la[i].name !== lb[i].name || la[i].size !== lb[i].size || la[i].lastModified !== lb[i].lastModified) return false;
  }
  return true;
};

function diff(a: FormState, b: FormState, blanks: boolean, rows: boolean): string | null {
  const eq = blanks ? looks : sameValue;
  const keys: string[] = [];
  for (const part of ['path', 'query', 'header', 'matrix', 'form'] as const) {
    const x = (a.values[part] ?? {}) as Record<string, unknown>, y = (b.values[part] ?? {}) as Record<string, unknown>;
    for (const name of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (!eq(own(x, name), own(y, name))) keys.push(part + '.' + name);
    }
  }
  const fx = a.values.files ?? {}, fy = b.values.files ?? {};
  for (const name of new Set([...Object.keys(fx), ...Object.keys(fy)])) {
    if (!sameFiles(own(fx, name) as File[] | undefined, own(fy, name) as File[] | undefined)) keys.push('files.' + name);
  }
  for (const k of ['body', 'contentType', 'accept'] as const) if (!eq(a.values[k], b.values[k])) keys.push(k);
  if (!(rows ? sameRows : sameCustom)(a.custom, b.custom)) keys.push('custom');
  if (a.noXsrfHeader !== b.noXsrfHeader) keys.push('xsrf');
  return keys.length ? keys.join(',') : null;
}

/** Which fields differ as displayed, or null when identical (treats cleared field as unchanged). */
export function changedField(a: FormState, b: FormState): string | null {
  return diff(a, b, true, true);
}

/** Next undo history state after changing `cur` to `next`, coalescing rapid typing within the same field. */
export function record(h: FormHistory, cur: FormState, next: FormState, now: number, separate = false): FormHistory | null {
  const field = diff(cur, next, false, false);
  if (field === null) return null;
  const typing = !separate && h.last?.field === field && now - h.last.at < TYPING_MS && h.undo.length > 0;
  if (typing && diff(next, h.undo[h.undo.length - 1], true, false) === null) return { undo: h.undo.slice(0, -1), redo: [] };
  return {
    undo: typing ? h.undo : [...h.undo, cur].slice(-UNDO_STEPS),
    redo: [],
    last: separate ? undefined : { field, at: now },
  };
}

export function undo(h: FormHistory, cur: FormState): { history: FormHistory; state: FormState } | null {
  if (!h.undo.length) return null;
  return {
    history: { undo: h.undo.slice(0, -1), redo: [...h.redo, cur].slice(-UNDO_STEPS) },
    state: h.undo[h.undo.length - 1],
  };
}

export function redo(h: FormHistory, cur: FormState): { history: FormHistory; state: FormState } | null {
  if (!h.redo.length) return null;
  return {
    history: { undo: [...h.undo, cur].slice(-UNDO_STEPS), redo: h.redo.slice(0, -1) },
    state: h.redo[h.redo.length - 1],
  };
}
