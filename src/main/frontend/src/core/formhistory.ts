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

/** Which fields differ ("path.issueIdOrKey", "body", …, joined by commas), or null when nothing does. */
export function changedField(a: FormState, b: FormState): string | null {
  const keys: string[] = [];
  for (const part of ['path', 'query', 'header', 'matrix'] as const) {
    const x = a.values[part] as Record<string, unknown>, y = b.values[part] as Record<string, unknown>;
    for (const name of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (!same(x[name], y[name])) keys.push(part + '.' + name);
    }
  }
  for (const k of ['body', 'contentType', 'accept'] as const) if (!same(a.values[k], b.values[k])) keys.push(k);
  if (!same(a.custom, b.custom)) keys.push('custom');
  if (a.noXsrfHeader !== b.noXsrfHeader) keys.push('xsrf');
  return keys.length ? keys.join(',') : null;
}

/**
 * The history after the form changes from `cur` to `next`: a new undo step, unless the same field changed less than
 * a second ago (then the step before the typing stays the one to go back to). A change clears the redo steps.
 * `separate` makes a step in any case (a restore from the history, a reset). Null when nothing changed.
 */
export function record(h: FormHistory, cur: FormState, next: FormState, now: number, separate = false): FormHistory | null {
  const field = changedField(cur, next);
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
