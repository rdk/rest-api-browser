import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogStore, isLoginAnswer, POLL_DELAYS_MS, RETRY_DELAYS_MS, START_WAIT_MS, StartStopped, type FetchFn } from './catalog';
import { index, module, summary } from './fixtures';
import type { Index, Module, Summary } from './types';

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

describe('CatalogStore.rebuild', () => {
  const answering = (status: number) => {
    const calls: [string, string, string | null][] = [];
    const fetchFn: FetchFn = (url, init) => {
      calls.push([init?.method ?? 'GET', url, new Headers(init?.headers).get('X-Atlassian-Token')]);
      if (url.endsWith('/catalog/refresh')) return Promise.resolve(new Response(null, { status }));
      if (/\/index\//.test(url)) return json(index([], 'h1'));
      return json(summary([module('a', 'api/1')]));
    };
    return { calls, fetchFn };
  };

  it('asks for the rebuild with the XSRF header, then loads the catalog to follow it', async () => {
    const { calls, fetchFn } = answering(204);
    const store = new CatalogStore('', fetchFn);
    await store.rebuild();
    expect(calls[0]).toEqual(['POST', '/rest/restbrowser/1/catalog/refresh', 'no-check']);
    expect(calls[1][1]).toBe('/rest/restbrowser/1/catalog');
    store.stop();
  });

  it('expires the store when the session has expired, and says why otherwise', async () => {
    const expired = new CatalogStore('', answering(401).fetchFn);
    await expect(expired.rebuild()).rejects.toThrow(/session has expired/);
    expect(expired.error?.name).toBe('SessionExpired');
    await expect(new CatalogStore('', answering(403).fetchFn).rebuild()).rejects.toThrow(/Only system administrators/);
    await expect(new CatalogStore('', answering(500).fetchFn).rebuild()).rejects.toThrow(/could not be started \(HTTP 500\)/);
    const offline = new CatalogStore('', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(offline.rebuild()).rejects.toThrow(/could not be started: Failed to fetch/);
  });
});

describe('CatalogStore.startModule', () => {
  const waiting = module('p:m', '/conf/1.0/', { state: 'failed', reason: 'not-started' });
  const started = module('p:m', 'conf/1.0', { opCount: 3 });
  // a product whose /catalog/started answers `answer`; the summary shows `after` once the start was asked for
  function product(answer: () => Response, after: Module[] = [started]) {
    const calls: [string, string][] = [];
    let asked = false;
    const fetchFn: FetchFn = (url, init) => {
      calls.push([init?.method ?? 'GET', url]);
      if (url.endsWith('/rest-api-browser-start')) return json({}, 404);
      if (url.includes('/catalog/started')) {
        asked = true;
        return Promise.resolve(answer());
      }
      const mods = asked ? after : [waiting];
      const hash = asked ? 'h2' : 'h1';
      if (/\/index\//.test(url)) return json(index([], hash));
      return json(summary(mods, { hash }));
    };
    return { calls, fetchFn };
  }
  const status = (code: number, body?: unknown) => () =>
    new Response(body === undefined ? null : JSON.stringify(body), { status: code });

  it('sends an OPTIONS request to the module, asks the server to read it, then loads the catalog with it', async () => {
    const { calls, fetchFn } = product(status(200, { state: 'ok', reason: null, opCount: 3 }));
    const store = new CatalogStore('http://host/wiki', fetchFn);
    await store.startModule(waiting);
    expect(calls.slice(0, 3)).toEqual([
      ['OPTIONS', 'http://host/wiki/rest/conf/1.0/rest-api-browser-start'],
      ['POST', 'http://host/wiki/rest/restbrowser/1/catalog/started?module=p%3Am'],
      ['GET', 'http://host/wiki/rest/restbrowser/1/catalog'],
    ]);
    expect(store.summary?.modules[0].state).toBe('ok');
    expect(store.starting.size).toBe(0);
    expect(store.startFailures.size).toBe(0);
    store.stop();
  });

  it('encodes the module path, and sends nothing to a path that would leave it', async () => {
    const { calls, fetchFn } = product(status(204));
    await new CatalogStore('', fetchFn).startModule(module('p:x', 'a b/1.0', { state: 'failed', reason: 'not-started' }));
    expect(calls[0]).toEqual(['OPTIONS', '/rest/a%20b/1.0/rest-api-browser-start']);
    const other = product(status(204));
    await new CatalogStore('', other.fetchFn).startModule(module('p:y', 'x/../admin', { state: 'failed', reason: 'not-started' }));
    expect(other.calls[0][0]).toBe('POST');
  });

  it('runs one start per module: a second call gets the first one\'s promise', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { calls, fetchFn } = product(status(200, { state: 'ok', opCount: 3 }));
    const store = new CatalogStore('', (url, init) => (url.includes('/catalog/started') ? gate.then(() => fetchFn(url, init)) : fetchFn(url, init)));
    const changes: string[][] = [];
    store.onChange(() => changes.push([...store.starting]));
    const first = store.startModule(waiting);
    expect(store.startModule(waiting)).toBe(first);
    expect(store.starting.has('p:m')).toBe(true);
    release();
    await first;
    expect(calls.filter(([m, u]) => m === 'POST' && u.includes('/catalog/started'))).toHaveLength(1);
    expect(changes[0]).toEqual(['p:m']);
    expect(changes.at(-1)).toEqual([]);
    store.stop();
  });

  it('tells why it did not start, keeps it for the row, and reloads not-startable summary', async () => {
    const notStartable = module('p:m', 'conf/1.0', { state: 'failed', reason: 'not-startable' });
    const store = new CatalogStore('', product(status(409, { error: 'still-not-started' }), [notStartable]).fetchFn);
    await expect(store.startModule(waiting)).rejects.toThrow(/did not start on that request/);
    expect(store.startFailures.get('p:m')).toMatchObject({ notStarted: true, message: expect.stringMatching(/did not start/) });
    expect(store.summary?.modules[0].reason).toBe('not-startable');
    expect(store.starting.size).toBe(0);
  });

  it('tells a module that started but failed, one that is gone and one that failed for another reason apart', async () => {
    const read = product(status(200, { state: 'failed', reason: 'model-unavailable', opCount: 0 }));
    await expect(new CatalogStore('', read.fetchFn).startModule(waiting)).rejects.toThrow(/started, but could not be read \(model-unavailable\)/);
    await expect(new CatalogStore('', product(status(404)).fetchFn).startModule(waiting)).rejects.toThrow(/no longer on this instance/);
    await expect(new CatalogStore('', product(status(409, { error: 'not-waiting-to-start' })).fetchFn).startModule(waiting))
      .rejects.toThrow(/not waiting to start/);
    const failing = new CatalogStore('', product(status(500)).fetchFn);
    await expect(failing.startModule(waiting)).rejects.toThrow(/HTTP 500/);
    expect(failing.startFailures.get('p:m')).toMatchObject({ notStarted: false }); // "start failed", not "did not start"
  });

  describe('with a read the server queued (202)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('follows that module, not the whole catalog, until it is read', async () => {
      let polls = 0;
      const queued = product(status(202), [waiting]);
      const store = new CatalogStore('', (url, init) => {
        // the catalog is complete all along; the module is read on the third look
        if (url.endsWith('/catalog') && polls++ >= 3) return json(summary([started], { hash: 'h3' }));
        if (url.endsWith('/index/h3')) return json(index([], 'h3'));
        return queued.fetchFn(url, init);
      });
      const done = store.startModule(waiting);
      await vi.advanceTimersByTimeAsync(5_000);
      await done;
      expect(store.summary?.modules[0].state).toBe('ok');
      store.stop();
    });

    it('gives up after START_WAIT_MS of real time, saying it is still being read', async () => {
      const store = new CatalogStore('', product(status(202), [waiting]).fetchFn);
      const done = store.startModule(waiting);
      const expectation = expect(done).rejects.toThrow(/still being read/);
      await vi.advanceTimersByTimeAsync(START_WAIT_MS + 2_000);
      await expectation;
      store.stop();
    });
  });

  it('says so when the catalog cannot be loaded after a start that worked', async () => {
    const { fetchFn } = product(status(200, { state: 'ok', opCount: 3 }));
    let asked = false;
    const store = new CatalogStore('', (url, init) => {
      if (url.includes('/catalog/started')) asked = true;
      if (asked && url.endsWith('/catalog')) return Promise.resolve(new Response('', { status: 503 }));
      return fetchFn(url, init);
    });
    await expect(store.startModule(waiting)).rejects.toThrow(/could not be loaded again/);
    expect(store.startFailures.get('p:m')).toMatchObject({ notStarted: false });
    store.stop();
  });

  it('starts nothing on a stopped store', async () => {
    const calls: string[] = [];
    const store = new CatalogStore('', (url) => {
      calls.push(url);
      return json({}, 404);
    });
    const changes = vi.fn();
    store.onChange(changes);
    store.stop();
    await expect(store.startModule(waiting)).rejects.toBeInstanceOf(StartStopped);
    expect(calls).toHaveLength(0);
    expect(changes).not.toHaveBeenCalled();
  });

  it('forgets why a start failed once the module no longer waits', async () => {
    let later = false;
    const store = new CatalogStore('', (url) => {
      if (url.includes('/catalog/started')) return json({ error: 'still-not-started' }, 409);
      if (url.endsWith('/rest-api-browser-start')) return json({}, 404);
      if (/\/index\//.test(url)) return json(index([], later ? 'h2' : 'h1'));
      return json(summary([later ? started : waiting], { hash: later ? 'h2' : 'h1' }));
    });
    await store.load();
    await expect(store.startModule(waiting)).rejects.toThrow(/did not start/);
    expect(store.startFailures.has('p:m')).toBe(true);
    later = true; // started meanwhile by another request (an OAuth one, another tab)
    await store.load();
    expect(store.startFailures.has('p:m')).toBe(false);
    store.stop();
  });

  it('lets an expired session expire the store, and is not kept as the module\'s failure', async () => {
    const store = new CatalogStore('', product(status(401)).fetchFn);
    await expect(store.startModule(waiting)).rejects.toThrow(/session has expired/);
    expect(store.error?.name).toBe('SessionExpired');
    expect(store.startFailures.size).toBe(0);
  });

  it('ends quietly when the store stops meanwhile, without starting it again', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { calls, fetchFn } = product(status(200, { state: 'ok', opCount: 3 }));
    const store = new CatalogStore('', (url, init) => (url.includes('/catalog/started') ? gate.then(() => fetchFn(url, init)) : fetchFn(url, init)));
    const done = store.startModule(waiting);
    expect(store.starting.has('p:m')).toBe(true);
    store.stop();
    expect(store.starting.size).toBe(0);
    release();
    await expect(done).rejects.toBeInstanceOf(StartStopped);
    expect(calls.some(([, u]) => u.endsWith('/catalog'))).toBe(false); // no load(), which would start the store again
    expect(store.startFailures.size).toBe(0);
  });
});

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
    const loading = store.load();
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    await loading;
    expect(store.summary?.hash).toBe('fresh');
    expect(srv.calls.filter((c) => !c.includes('/index/'))).toHaveLength(2);
  });

  it('gives up when the retry also 404s', async () => {
    const srv = server({ summary: () => summary(mods), index: () => null });
    const store = new CatalogStore('http://host/jira', srv.fetchFn);
    const result = expect(store.load()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS.reduce((a, b) => a + b));
    await result;
    expect(srv.calls.filter((c) => !c.includes('/index/'))).toHaveLength(1 + RETRY_DELAYS_MS.length);
  });

  it('retries a 404 up to 3 times, refetching the summary each time', async () => {
    let n = 0;
    const srv = server({ summary: () => summary(mods, { hash: `h${n++}` }), index: (h) => (h === 'h3' ? index([], h) : null) });
    const store = new CatalogStore('http://host/jira', srv.fetchFn);
    const loading = store.load();
    await vi.advanceTimersByTimeAsync(2000);
    await loading;
    expect(store.index?.hash).toBe('h3');
  });

  it('surfaces a 401 as SessionExpired and stops polling', async () => {
    const fetchFn: FetchFn = () => json({}, 401);
    const store = new CatalogStore('http://host/jira', fetchFn);
    await expect(store.load()).rejects.toMatchObject({ name: 'SessionExpired' });
    expect(store.error?.name).toBe('SessionExpired');
    let expired = false;
    const srv = server({ summary: () => summary(mods, { complete: false }), index: (h) => index([], h) });
    const p2 = new CatalogStore('http://host/jira', (url, init) => (expired ? json({}, 401) : srv.fetchFn(url, init)));
    await p2.load();
    expired = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(p2.error?.name).toBe('SessionExpired');
    const before = srv.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(srv.calls.length).toBe(before);
  });

  it('load() again clears the pending timer and the backoff', async () => {
    const srv = server({ summary: () => summary(mods, { complete: false }), index: (h) => index([], h) });
    const store = new CatalogStore('http://host/jira', srv.fetchFn);
    await store.load();
    await vi.advanceTimersByTimeAsync(1000);
    await store.refreshSoon();
    const before = srv.calls.filter((c) => !c.includes('/index/')).length;
    await vi.advanceTimersByTimeAsync(999);
    expect(srv.calls.filter((c) => !c.includes('/index/')).length).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(srv.calls.filter((c) => !c.includes('/index/')).length).toBe(before + 1);
    store.stop();
  });

  it('load() bails out when stop() was called meanwhile', async () => {
    const srv = server({ summary: () => summary(mods, { complete: false }), index: (h) => index([], h) });
    const store = new CatalogStore('http://host/jira', srv.fetchFn);
    const loading = store.load();
    store.stop();
    await loading;
    expect(store.summary).toBeNull();
    await vi.advanceTimersByTimeAsync(60000);
    expect(srv.calls).toHaveLength(1);
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

  it('two quick refreshSoon() calls leave exactly one timer and no duplicate poll loop', async () => {
    const srv = server({ summary: () => summary(mods, { complete: false }), index: (h) => index([], h) });
    const store = new CatalogStore('http://host/jira', srv.fetchFn);
    await store.load();
    await Promise.all([store.refreshSoon(), store.refreshSoon()]);
    expect(vi.getTimerCount()).toBe(1);
    const before = srv.calls.filter((c) => !c.includes('/index/')).length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(srv.calls.filter((c) => !c.includes('/index/')).length).toBe(before + 1);
    store.stop();
  });

  it('a poll in flight when load() starts does not schedule a second loop', async () => {
    let n = 0;
    let release: (() => void) | null = null;
    const base = server({ summary: () => summary(mods, { complete: false }), index: (h) => index([], h) });
    const fetchFn: FetchFn = (url, init) => {
      if (!url.includes('/index/') && ++n === 2) return new Promise((r) => (release = () => r(base.fetchFn(url, init))));
      return base.fetchFn(url, init);
    };
    const store = new CatalogStore('http://host/jira', fetchFn);
    await store.load();
    await vi.advanceTimersByTimeAsync(1000);   // poll starts and hangs on its summary
    await store.load();
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    store.stop();
  });

  it('stop() and load() remove a pending visibilitychange listener', async () => {
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: 'hidden',
      addEventListener: (_t: string, f: () => void) => listeners.add(f),
      removeEventListener: (_t: string, f: () => void) => listeners.delete(f),
    };
    vi.stubGlobal('document', doc);
    try {
      const srv = server({ summary: () => summary(mods, { complete: false }), index: (h) => index([], h) });
      const store = new CatalogStore('http://host/jira', srv.fetchFn);
      await store.load();
      await vi.advanceTimersByTimeAsync(1000);
      expect(listeners.size).toBe(1);
      doc.visibilityState = 'visible';
      await store.load();
      expect(listeners.size).toBe(0);
      doc.visibilityState = 'hidden';
      await vi.advanceTimersByTimeAsync(1000);
      expect(listeners.size).toBe(1);
      store.stop();
      expect(listeners.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('emits when a poll brings new progress, module states or completion under the same hash, not for the same summary', async () => {
    const pending = (done: number) => summary([module('a', 'api/1', { state: 'pending' }), module('b', 'api/2', { state: 'pending' })],
      { complete: false, progress: { done, total: 2 } });
    const answers = [
      pending(0),
      pending(0),
      pending(1),
      summary([module('a', 'api/1', { opCount: 0 }), module('b', 'api/2', { state: 'failed', error: 'x' })], { complete: true, progress: { done: 2, total: 2 } }),
    ];
    let n = 0;
    const srv = server({ summary: () => answers[Math.min(n++, answers.length - 1)], index: (h) => index([], h) });
    const store = new CatalogStore('http://host/jira', srv.fetchFn);
    const onChange = vi.fn();
    store.onChange(onChange);
    await store.load();
    expect(onChange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);   // the same summary: nothing new to show
    expect(onChange).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);   // one module done
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(store.summary?.progress.done).toBe(1);
    await vi.advanceTimersByTimeAsync(4000);   // complete, the last module failed
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(store.summary?.complete).toBe(true);
    expect(store.summary?.modules[1].state).toBe('failed');
    const calls = srv.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(srv.calls.length).toBe(calls);
  });

  it('takes a login page for an expired session: HTML instead of JSON, a redirect to login, a login reason header', async () => {
    const html = () => Promise.resolve(new Response('<html>Log in</html>', { status: 200, headers: { 'content-type': 'text/html;charset=UTF-8' } }));
    const store = new CatalogStore('http://host/jira', html);
    await expect(store.load()).rejects.toMatchObject({ name: 'SessionExpired' });
    expect(store.error?.name).toBe('SessionExpired');

    const redirected: FetchFn = () => {
      const res = new Response('{}', { status: 200 });
      Object.defineProperty(res, 'redirected', { value: true });
      Object.defineProperty(res, 'url', { value: 'http://host/jira/login.jsp?os_destination=x' });
      return Promise.resolve(res);
    };
    await expect(new CatalogStore('http://host/jira', redirected).load()).rejects.toMatchObject({ name: 'SessionExpired' });

    const denied: FetchFn = () => Promise.resolve(new Response('{}', { status: 403, headers: { 'X-Seraph-LoginReason': 'AUTHENTICATION_DENIED' } }));
    await expect(new CatalogStore('http://host/jira', denied).load()).rejects.toMatchObject({ name: 'SessionExpired' });

    // "OK" is what Jira sends on every authenticated request
    const okReason: FetchFn = (url) => Promise.resolve(new Response(
      JSON.stringify(url.includes('/index/') ? index([], 'h1') : summary(mods)), { headers: { 'X-Seraph-LoginReason': 'OK' } }));
    await new CatalogStore('http://host/jira', okReason).load();

    // while polling: it stops and says so
    let expired = false;
    const srv = server({ summary: () => summary(mods, { complete: false }), index: (h) => index([], h) });
    const polled = new CatalogStore('http://host/jira', (url, init) => (expired ? html() : srv.fetchFn(url, init)));
    const onChange = vi.fn();
    polled.onChange(onChange);
    await polled.load();
    expired = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(polled.error?.name).toBe('SessionExpired');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('CatalogStore second review', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps polling after a transient failure of load() while the catalog is incomplete', async () => {
    let fail = false;
    const srv = server({ summary: () => summary(mods, { complete: false }), index: (h) => index([], h) });
    const store = new CatalogStore('http://host/jira', (url, init) => (fail ? Promise.resolve(new Response('', { status: 500 })) : srv.fetchFn(url, init)));
    await store.load();
    fail = true;
    await expect(store.refreshSoon()).rejects.toThrow('HTTP 500');
    fail = false;
    expect(vi.getTimerCount()).toBe(1);
    const before = srv.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(srv.calls.length).toBeGreaterThan(before);
    store.stop();
  });

  it('asks again after a failure of load() also when the catalog was complete, and stops once it has it', async () => {
    let fail = false;
    let hash = 'h1';
    const srv = server({ summary: () => summary(mods, { hash }), index: (h) => index([], h) });
    const store = new CatalogStore('http://host/jira', (url, init) => (fail ? Promise.resolve(new Response('', { status: 502 })) : srv.fetchFn(url, init)));
    await store.load();
    expect(vi.getTimerCount()).toBe(0); // complete: nothing to poll
    fail = true;
    hash = 'h2'; // newer than what the page shows, and its load fails
    await expect(store.refreshSoon()).rejects.toThrow('HTTP 502');
    fail = false;
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.summary?.hash).toBe('h2');
    expect(vi.getTimerCount()).toBe(0);
    store.stop();
  });

  it('does not download the index again when load() finds the same hash, and tells only of a changed view', async () => {
    let n = 0;
    const srv = server({ summary: () => summary(mods, { complete: n++ > 0 }), index: (h) => index([], h) });
    const store = new CatalogStore('http://host/jira', srv.fetchFn);
    const onChange = vi.fn();
    store.onChange(onChange);
    await store.load();
    await store.refreshSoon();   // the same hash, now complete
    expect(srv.calls.filter((c) => c.includes('/index/'))).toHaveLength(1);
    expect(store.summary?.complete).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(2);
    await store.refreshSoon();   // the same again: nothing to tell
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('takes the AUTHENTICATED_FAILED login reason for an expired session', async () => {
    const f: FetchFn = () => Promise.resolve(new Response('{}', { status: 200, headers: { 'X-Seraph-LoginReason': 'AUTHENTICATED_FAILED' } }));
    await expect(new CatalogStore('http://host/jira', f).load()).rejects.toMatchObject({ name: 'SessionExpired' });
  });

  it('isLoginAnswer: a 401 to a request with its own credentials is those credentials failing', () => {
    expect(isLoginAnswer(new Response('', { status: 401 }))).toBe(true);
    expect(isLoginAnswer(new Response('', { status: 401 }), false, true)).toBe(false);
    expect(isLoginAnswer(new Response('', { status: 401, headers: { 'X-Seraph-LoginReason': 'OUT' } }), false, true)).toBe(true);
  });

  it('startModule detects stop() + load() generation change and retries initial transient load() failure', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const store = new CatalogStore('', (url) => {
      if (url.includes('/catalog/started')) return gate.then(() => json({ state: 'ok', opCount: 1 }));
      if (/\/index\//.test(url)) return json(index([], 'h1'));
      return json(summary([module('p:m', 'api/1', { opCount: 1 })], { hash: 'h1' }));
    });
    const p = store.startModule(module('p:m', 'api/1', { state: 'failed', reason: 'not-started' }));
    store.stop();
    await store.load();
    release();
    await expect(p).rejects.toBeInstanceOf(StartStopped);
    store.stop();

    let failOnce = true;
    const srv = server({ summary: () => summary(mods, { complete: true }), index: (h) => index([], h) });
    const recovering = new CatalogStore('http://host/jira', (url, init) => {
      if (failOnce) {
        failOnce = false;
        return Promise.resolve(new Response('', { status: 503 }));
      }
      return srv.fetchFn(url, init);
    });
    await expect(recovering.load()).rejects.toThrow('HTTP 503');
    await vi.advanceTimersByTimeAsync(POLL_DELAYS_MS[0] ?? 1000);
    expect(recovering.summary?.complete).toBe(true);
    recovering.stop();
  });
});
