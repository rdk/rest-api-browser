import { describe, expect, it } from 'vitest';
import { changedField, NO_HISTORY, record, redo, undo, UNDO_STEPS, type FormHistory, type FormState } from './formhistory';

const form = (path: Record<string, string> = {}, body?: string): FormState =>
  ({ values: { path, query: {}, header: {}, matrix: {}, body }, custom: [], noXsrfHeader: false });

describe('form history', () => {
  it('names the field that changed, or none', () => {
    expect(changedField(form({ a: '1' }), form({ a: '2' }))).toBe('path.a');
    expect(changedField(form({}, 'x'), form({}, 'y'))).toBe('body');
    expect(changedField(form({ a: '1' }), form({ a: '1' }))).toBeNull();
  });

  it('makes one step of a run of keys in one field, and a new one for another field or after a pause', () => {
    let h: FormHistory = NO_HISTORY;
    h = record(h, form(), form({ a: '1' }), 0)!;
    h = record(h, form({ a: '1' }), form({ a: '12' }), 300)!;
    h = record(h, form({ a: '12' }), form({ a: '123' }), 600)!;
    expect(h.undo).toEqual([form()]);
    h = record(h, form({ a: '123' }), form({ a: '123', b: 'x' }), 700)!;
    expect(h.undo).toEqual([form(), form({ a: '123' })]);
    h = record(h, form({ a: '123', b: 'x' }), form({ a: '123', b: 'xy' }), 5000)!;
    expect(h.undo.length).toBe(3);
    expect(record(h, form({ a: '1' }), form({ a: '1' }), 6000)).toBeNull();
  });

  it('undoes and redoes; a new change drops the redo steps', () => {
    let h: FormHistory = record(NO_HISTORY, form(), form({ a: '1' }), 0)!;
    h = record(h, form({ a: '1' }), form({ a: '1' }, 'b'), 10)!;
    let cur = form({ a: '1' }, 'b');
    const u1 = undo(h, cur)!;
    expect(u1.state).toEqual(form({ a: '1' }));
    const u2 = undo(u1.history, u1.state)!;
    expect(u2.state).toEqual(form());
    expect(undo(u2.history, u2.state)).toBeNull();
    const r1 = redo(u2.history, u2.state)!;
    expect(r1.state).toEqual(form({ a: '1' }));
    cur = r1.state;
    const changed = record(r1.history, cur, form({ a: '9' }), 20, true)!;
    expect(changed.redo).toEqual([]);
    expect(redo(changed, form({ a: '9' }))).toBeNull();
  });

  it('keeps the last UNDO_STEPS steps', () => {
    let h: FormHistory = NO_HISTORY;
    for (let i = 0; i < UNDO_STEPS + 30; i++) h = record(h, form({ a: String(i) }), form({ a: String(i + 1) }), i, true)!;
    expect(h.undo.length).toBe(UNDO_STEPS);
    expect(h.undo[0]).toEqual(form({ a: '30' }));
    expect(UNDO_STEPS).toBeGreaterThanOrEqual(50);
  });
});

describe('form history review fixes', () => {
  const empty: FormState = { values: { path: {}, query: { q: [''] }, header: {}, matrix: {} }, custom: [], noXsrfHeader: false };
  const cleared: FormState = {
    values: { path: { a: '' }, query: { q: [], r: [''] }, header: { h: '' }, matrix: { m: '' }, body: '', accept: '' },
    custom: [{ name: '', value: '' }, { name: '', value: '' }],
    noXsrfHeader: false,
  };

  it('does not count a field typed into and cleared as a change from the empty form', () => {
    expect(changedField(cleared, empty)).toBeNull();
    expect(changedField(empty, cleared)).toBeNull();
    expect(changedField({ ...cleared, values: { ...cleared.values, query: { q: ['', ''] } } }, empty)).toBe('query.q');
    expect(changedField({ ...cleared, values: { ...cleared.values, path: { a: ' ' } } }, empty)).toBe('path.a');
    expect(changedField({ ...cleared, custom: [{ name: 'X-A', value: '' }] }, empty)).toBe('custom');
  });

  it('reads only a name\'s own value, so a parameter called "constructor" compares like any other', () => {
    expect(changedField(form({ constructor: '' }), form())).toBeNull();
    expect(changedField(form({ toString: 'x' }), form())).toBe('path.toString');
  });

  it('still records adding or removing an empty header row, so the form shows it', () => {
    const one = { ...form(), custom: [{ name: '', value: '' }] };
    expect(record(NO_HISTORY, form(), one, 0)).not.toBeNull();
    expect(record(NO_HISTORY, one, form(), 0)).not.toBeNull();
  });
});

describe('form history second review', () => {
  it('drops the step when typing goes back to its value, and the next key makes a new one', () => {
    let h: FormHistory = record(NO_HISTORY, form({ b: '1' }), form({ b: '2' }), 0, true)!;   // an older step
    h = record(h, form({ b: '2' }), form({ b: '2', a: 'x' }), 100)!;
    expect(h.undo).toEqual([form({ b: '1' }), form({ b: '2' })]);
    h = record(h, form({ b: '2', a: 'x' }), form({ b: '2', a: '' }), 400)!;   // back to blank within a second
    expect(h.undo).toEqual([form({ b: '1' })]);
    h = record(h, form({ b: '2', a: '' }), form({ b: '2', a: 'y' }), 500)!;
    expect(h.undo).toEqual([form({ b: '1' }), form({ b: '2', a: '' })]);
    // after a pause it is a step of its own, kept
    const later = record(h, form({ b: '2', a: 'y' }), form({ b: '2', a: '' }), 5000)!;
    expect(later.undo.length).toBe(3);
  });
});
