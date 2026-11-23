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

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// What the form shows the same: '' as no value, [] and [''] as no query value, rows of empty headers as none.
const blankValue = (v: unknown) => v === undefined || v === '' || (Array.isArray(v) && (v.length === 0 || (v.length === 1 && v[0] === '')));
const looks = (a: unknown, b: unknown) => (blankValue(a) && blankValue(b)) || same(a, b);
const noRows = (rows: FormState['custom']) => rows.every((h) => !h.name.trim() && !h.value.trim());
const sameRows = (a: FormState['custom'], b: FormState['custom']) => (noRows(a) && noRows(b)) || same(a, b);

// A name's own value: names come from links too, and "constructor" must not read Object.prototype's.
const own = (map: Record<string, unknown>, name: string) => (Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined);

function diff(a: FormState, b: FormState, loose: boolean): string | null {
  const eq = loose ? looks : same;
  const keys: string[] = [];
  for (const part of ['path', 'query', 'header', 'matrix'] as const) {
    const x = a.values[part] as Record<string, unknown>, y = b.values[part] as Record<string, unknown>;
    for (const name of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (!eq(own(x, name), own(y, name))) keys.push(part + '.' + name);
    }
  }
  for (const k of ['body', 'contentType', 'accept'] as const) if (!eq(a.values[k], b.values[k])) keys.push(k);
  if (!(loose ? sameRows : same)(a.custom, b.custom)) keys.push('custom');
  if (a.noXsrfHeader !== b.noXsrfHeader) keys.push('xsrf');
  return keys.length ? keys.join(',') : null;
}

/**
 * Which fields differ ("path.issueIdOrKey", "body", …, joined by commas), or null when nothing does, as the form
 * shows them: a field typed into and cleared is the same as one never touched, so Reset does not stay on for it.
 */
export function changedField(a: FormState, b: FormState): string | null {
  return diff(a, b, true);
}

/**
 * The history after the form changes from `cur` to `next`: a new undo step, unless the same field changed less than
 * a second ago (then the step before the typing stays the one to go back to). A change clears the redo steps.
 * `separate` makes a step in any case (a restore from the history, a reset). Null when nothing changed.
 */
export function record(h: FormHistory, cur: FormState, next: FormState, now: number, separate = false): FormHistory | null {
  // every change counts here, an added empty header row too: the form only shows what is recorded
  const field = diff(cur, next, false);
  if (field === null) return null;
  const typing = !separate && h.last?.field === field && now - h.last.at < TYPING_MS && h.undo.length > 0;
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
