import { describe, expect, it } from 'vitest';
import type { RequestValues } from '../core/request';
import { UserStore } from './userstore';

class FakeStorage implements Storage {
  data = new Map<string, string>();
  failWrites = false;
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  setItem(k: string, v: string) {
    if (this.failWrites) throw new DOMException('full', 'QuotaExceededError');
    this.data.set(k, v);
  }
}

const values = (header: Record<string, string> = {}): RequestValues => ({ path: {}, query: {}, header, matrix: {} });
const entry = (opKey: string, extra: Partial<Parameters<UserStore['addHistory']>[0]> = {}) => ({
  opKey, method: 'GET', url: '/rest/x', values: values(), ...extra,
});

describe('UserStore', () => {
  it('returns history newest first, per operation', async () => {
    const s = new UserStore('u', new FakeStorage());
    const a = await s.addHistory(entry('a'));
    await s.addHistory(entry('b'));
    const c = await s.addHistory(entry('a'));
    expect((await s.history('a')).map((e) => e.id)).toEqual([c.id, a.id]);
    expect(await s.history('b')).toHaveLength(1);
  });

  it('keeps 20 per operation and 500 overall, dropping the oldest', async () => {
    const s = new UserStore('u', new FakeStorage());
    for (let i = 0; i < 25; i++) await s.addHistory(entry('a', { status: i }));
    const a = await s.history('a');
    expect(a).toHaveLength(20);
    expect(a[0].status).toBe(24);
    expect(a[19].status).toBe(5);

    for (let i = 0; i < 30; i++) {
      for (let j = 0; j < 20; j++) await s.addHistory(entry(`op${i}`));
    }
    let total = 0;
    for (let i = 0; i < 30; i++) total += (await s.history(`op${i}`)).length;
    total += (await s.history('a')).length;
    expect(total).toBe(500);
    expect(await s.history('a')).toHaveLength(0);
  });

  it('truncates bodyPreview to 2000 characters', async () => {
    const s = new UserStore('u', new FakeStorage());
    const e = await s.addHistory(entry('a', { bodyPreview: 'x'.repeat(5000) }));
    expect(e.bodyPreview).toHaveLength(2000);
  });

  it('strips credential headers but keeps x-atlassian-token', async () => {
    const storage = new FakeStorage();
    const s = new UserStore('u', storage);
    const e = await s.addHistory(entry('a', {
      values: values({
        Authorization: 'Basic abc', 'Proxy-Authorization': 'p', Cookie: 'c', 'Set-Cookie': 's',
        'X-Api-Token': 't', 'client-secret': 'x', 'X-Password': 'p', 'X-Atlassian-Token': 'no-check', Accept: 'a/b',
      }),
    }));
    expect(Object.keys(e.values.header).sort()).toEqual(['Accept', 'X-Atlassian-Token']);
    const raw = [...storage.data.values()].join('');
    expect(raw).not.toContain('Basic abc');
  });

  it('strips an Authorization query parameter', async () => {
    const s = new UserStore('u', new FakeStorage());
    const e = await s.addHistory(entry('a', { values: { ...values(), query: { authorization: ['x'], q: ['1'] } } }));
    expect(e.values.query).toEqual({ q: ['1'] });
  });

  it('falls back to memory when storage throws', async () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    const s = new UserStore('u', storage);
    await s.addHistory(entry('a'));
    await s.setPrefs({ split: 0.4 });
    expect(await s.history('a')).toHaveLength(1);
    expect((await s.prefs()).split).toBe(0.4);
  });

  it('works with no storage at all', async () => {
    const s = new UserStore('u', null);
    await s.addHistory(entry('a'));
    expect(await s.history('a')).toHaveLength(1);
  });

  it('merges prefs and namespaces keys', async () => {
    const storage = new FakeStorage();
    const s = new UserStore('inst:bob', storage);
    await s.setPrefs({ split: 0.5, methods: ['GET'] });
    await s.setPrefs({ split: 0.6 });
    expect(await s.prefs()).toEqual({ split: 0.6, methods: ['GET'] });
    expect([...storage.data.keys()].every((k) => k.startsWith('rab-next:inst:bob:'))).toBe(true);
    expect(await new UserStore('other', storage).prefs()).toEqual({});
  });

  it('clears history for one operation only', async () => {
    const s = new UserStore('u', new FakeStorage());
    await s.addHistory(entry('a'));
    await s.addHistory(entry('b'));
    await s.clearHistory('a');
    expect(await s.history('a')).toHaveLength(0);
    expect(await s.history('b')).toHaveLength(1);
  });
});
