import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogStore, type FetchFn } from './catalog';
import { index, module, summary } from './fixtures';
import type { Index, Summary } from './types';

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

function server(handlers: { summary: () => Summary; index: (hash: string) => Index | null }) {
  const calls: string[] = [];
  const fetchFn: FetchFn = (url) => {
    calls.push(url);
    const m = /\/index\/(.+)$/.exec(url);
    if (m) {
      const ix = handlers.index(m[1]);
      return ix ? json(ix) : json({}, 404);
    }
    return json(handlers.summary());
  };
  return { calls, fetchFn };
}

const mods = [module('a', 'api/1')];

describe('CatalogStore', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('loads the summary then the index for its hash and emits once', async () => {
    const srv = server({ summary: () => summary(mods, { hash: 'h7' }), index: (h) => index([], h) });
    const store = new CatalogStore('http://host/jira', srv.fetchFn);
    const onChange = vi.fn();
    store.onChange(onChange);
    await store.load();
    expect(srv.calls).toEqual([
      'http://host/jira/rest/restbrowser/1/catalog',
      'http://host/jira/rest/restbrowser/1/catalog/index/h7',
    ]);
    expect(store.index?.hash).toBe('h7');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('refetches the summary once when the index answers 404', async () => {
    let current = 'old';
    let served = 0;
    const srv = server({
      summary: () => summary(mods, { hash: served++ === 0 ? 'stale' : current }),
      index: (h) => (h === 'stale' ? null : index([], h)),
    });
    current = 'fresh';
    const store = new CatalogStore('http://host/jira', srv.fetchFn);
    await store.load();
    expect(store.summary?.hash).toBe('fresh');
    expect(srv.calls.filter((c) => !c.includes('/index/'))).toHaveLength(2);
  });

  it('gives up when the retry also 404s', async () => {
    const srv = server({ summary: () => summary(mods), index: () => null });
    const store = new CatalogStore('http://host/jira', srv.fetchFn);
    await expect(store.load()).rejects.toThrow();
  });

  it('polls with 1, 2, 4, 8, 8 second backoff while incomplete', async () => {
    const srv = server({ summary: () => summary(mods, { complete: false }), index: (h) => index([], h) });
    const store = new CatalogStore('http://host/jira', srv.fetchFn);
    await store.load();
    const summaries = () => srv.calls.filter((c) => !c.includes('/index/')).length;
    expect(summaries()).toBe(1);
    for (const delay of [1000, 2000, 4000, 8000, 8000]) {
      const before = summaries();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(summaries()).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(summaries()).toBe(before + 1);
    }
    store.stop();
  });

  it('follows a changed hash, emits, and stops polling when complete', async () => {
    let n = 0;
    const srv = server({
      summary: () => (n++ === 0 ? summary(mods, { hash: 'h1', complete: false }) : summary(mods, { hash: 'h2', complete: true })),
      index: (h) => index([], h),
    });
    const store = new CatalogStore('http://host/jira', srv.fetchFn);
    const onChange = vi.fn();
    store.onChange(onChange);
    await store.load();
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.index?.hash).toBe('h2');
    expect(onChange).toHaveBeenCalledTimes(2);
    const calls = srv.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(srv.calls.length).toBe(calls);
  });

  it('pauses while the document is hidden and resumes when visible', async () => {
    const listeners: Record<string, () => void> = {};
    const doc = {
      visibilityState: 'hidden',
      addEventListener: (t: string, f: () => void) => (listeners[t] = f),
      removeEventListener: (t: string) => delete listeners[t],
    };
    vi.stubGlobal('document', doc);
    try {
      const srv = server({ summary: () => summary(mods, { complete: false }), index: (h) => index([], h) });
      const store = new CatalogStore('http://host/jira', srv.fetchFn);
      await store.load();
      const before = srv.calls.length;
      await vi.advanceTimersByTimeAsync(30000);
      expect(srv.calls.length).toBe(before);
      doc.visibilityState = 'visible';
      listeners.visibilitychange();
      await vi.advanceTimersByTimeAsync(0);
      expect(srv.calls.length).toBe(before + 1);
      store.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
