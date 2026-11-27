import type { Index, Module, Summary } from './types';
import { trimModulePath } from '../lib/jaxrs-router';
import { reasonInfo } from './explain';

/**
 * Starting a module (see startModule): an OPTIONS request to a path the module does not have (Jersey usually answers
 * it with a 404; it passes the module's filters like any request); how long a start the server queued is followed:
 * longer than the server reads a module at most (CatalogService.MODULE_TIMEOUT_MS, 30 s), so that a read ends while it
 * is followed. A read queued behind a build is shown by the store's own polling: the catalog is incomplete till then.
 */
export const START_PATH = 'rest-api-browser-start';
export const START_WAIT_MS = 45_000;
const START_POLL_MS = 1000;
const DID_NOT_START = 'it did not start on that request; some modules start only for their own kind of login (OAuth tokens)';

/** Why the last start of a module failed: `notStarted` when the product did not start it on that request. */
export interface StartFailure {
  message: string;
  notStarted: boolean;
}

/** A start that ended because the store was stopped (the page went away, the session expired): nothing to show. */
export class StartStopped extends Error {
  constructor() {
    super('stopped');
    this.name = 'StartStopped';
  }
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export const POLL_DELAYS_MS = [1000, 2000, 4000, 8000];

// Waits before asking again when the index 404s: on a cluster the nodes may briefly disagree on the hash.
export const RETRY_DELAYS_MS = [250, 500, 1000];

class NotFound extends Error {}

function sessionExpired(path: string, status: number): Error {
  const e = new Error(`${path}: HTTP ${status}, the session has expired`);
  e.name = 'SessionExpired';
  return e;
}

/**
 * Whether an answer is the product telling that the session expired: a 401, a login reason header saying so (OUT,
 * AUTHENTICATION_DENIED, AUTHENTICATED_FAILED), or a redirect to a login page. Where JSON was expected
 * (`jsonExpected`), an HTML page counts too: it is the login page. For a request that sent its own credentials
 * (`ownCredentials`), a 401 alone is those credentials failing, not the session.
 */
export function isLoginAnswer(res: Response, jsonExpected = false, ownCredentials = false): boolean {
  if (res.status === 401 && !ownCredentials) return true;
  const reason = (res.headers.get('x-seraph-loginreason') ?? '').toUpperCase();
  if (reason.includes('OUT') || reason.includes('AUTHENTICAT')) return true;
  const html = /text\/html/i.test(res.headers.get('content-type') ?? '');
  if (res.redirected && /login/i.test(res.url) && (html || jsonExpected)) return true;
  return jsonExpected && res.ok && html;
}

// What the UI shows of a summary besides its operations: progress, completion and each module's state and count.
function sameView(a: Summary, b: Summary): boolean {
  if (a.complete !== b.complete || a.progress.done !== b.progress.done || a.progress.total !== b.progress.total) return false;
  if (a.admin !== b.admin || a.sysadmin !== b.sysadmin || a.modules.length !== b.modules.length) return false;
  return a.modules.every((m, i) => {
    const n = b.modules[i];
    return m.id === n.id && m.path === n.path && m.state === n.state && m.opCount === n.opCount && m.reason === n.reason
      && m.error === n.error && m.stability === n.stability && m.origin === n.origin;
  });
}

export const isSessionExpired = (e: unknown) => e instanceof Error && e.name === 'SessionExpired';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class CatalogStore {
  summary: Summary | null = null;
  index: Index | null = null;
  error: Error | null = null;   // set when the session expired; polling has stopped
  /** The modules being started, and why the last start of a module failed (this page only); new objects on change. */
  starting: ReadonlySet<string> = new Set();
  startFailures: ReadonlyMap<string, StartFailure> = new Map();

  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;
  private generation = 0;
  private stopEpoch = 0;
  private waitingForVisible = false;
  private starts = new Map<string, Promise<void>>();

  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchFn = (url, init) => fetch(url, init),
  ) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async load(): Promise<void> {
    this.cancelPending();
    this.attempt = 0;
    this.stopped = false;
    this.error = null;
    const generation = ++this.generation;
    try {
      const summary = await this.fetchSummary();
      if (generation !== this.generation) return;
      // the index of an unchanged hash is the one we have
      if (this.index && summary.hash === this.index.hash) this.update(summary);
      else await this.refresh(summary, generation);
    } catch (e) {
      if (generation === this.generation) {
        if (isSessionExpired(e)) this.expire(e as Error);
        else this.schedulePoll(true);   // a transient failure: asked again, also when the catalog was complete
      }
      throw e;
    }
    if (generation !== this.generation) return;
    this.schedulePoll();
  }

  // Re-runs load(), e.g. after an admin triggered a rebuild.
  refreshSoon(): Promise<void> {
    return this.load();
  }

  /**
   * Asks the server to rebuild the catalog (system administrators), then loads it to follow the rebuild. Rejects with
   * a message for the user; an expired session expires the store, and the page says so.
   */
  async rebuild(): Promise<void> {
    const path = '/rest/restbrowser/1/catalog/refresh';
    let res: Response;
    try {
      res = await this.fetchFn(this.baseUrl + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Atlassian-Token': 'no-check' },
      });
    } catch (e) {
      throw new Error('The rebuild could not be started: ' + message(e));
    }
    if (isLoginAnswer(res)) {
      const e = sessionExpired(path, res.status);
      this.expire(e);
      throw e;
    }
    if (res.status === 403) throw new Error('Only system administrators can rebuild the catalog.');
    if (!res.ok) throw new Error(`The rebuild could not be started (HTTP ${res.status}).`);
    try {
      await this.load();
    } catch (e) {
      if (isSessionExpired(e)) throw e; // load() expired the store
      throw new Error('The rebuild started, but the catalog could not be read again: ' + message(e));
    }
  }

  /**
   * Starts a module that had not started (failed, reason not-started): Confluence starts a module's REST API on the
   * first request to it, on each node. A request to the module starts it on this node (the session sticks to one node
   * of a cluster); then the server checks that it runs and reads that module again, and answers how it went. One
   * start per module at a time: a second call gets the first one's promise. Rejects with what went wrong, which
   * startFailures keeps; with StartStopped when the store stopped meanwhile.
   */
  startModule(module: Module): Promise<void> {
    if (this.stopped) return Promise.reject(new StartStopped());
    const running = this.starts.get(module.id);
    if (running) return running;
    const epoch = this.stopEpoch;
    const failures = (change: (m: Map<string, StartFailure>) => void) => {
      if (this.stopped || epoch !== this.stopEpoch) return;
      const next = new Map(this.startFailures);
      change(next);
      this.startFailures = next;
    };
    const start = this.start(module, epoch).then(
      () => failures((m) => m.delete(module.id)),
      (e: unknown) => {
        if (!(e instanceof StartStopped) && !isSessionExpired(e)) {
          failures((m) => m.set(module.id, { message: message(e), notStarted: message(e) === DID_NOT_START }));
        }
        throw e;
      },
    ).finally(() => {
      if (this.starts.get(module.id) === start) this.starts.delete(module.id);
      this.starting = new Set(this.starts.keys());
      this.listeners.forEach((l) => l());
    });
    this.starts.set(module.id, start);
    this.starting = new Set(this.starts.keys());
    this.listeners.forEach((l) => l());
    return start;
  }

  private async start(module: Module, epoch: number): Promise<void> {
    const segments = trimModulePath(module.path).split('/');
    if (!segments.some((s) => s === '' || s === '.' || s === '..')) {
      try {
        await this.fetchFn(`${this.baseUrl}/rest/${segments.map(encodeURIComponent).join('/')}/${START_PATH}`, {
          method: 'OPTIONS',
          credentials: 'same-origin',
          redirect: 'manual',
        });
      } catch {
        // the answer does not matter (a 404), only that the request reached the module
      }
    }
    this.checkStopped(epoch);
    const path = '/rest/restbrowser/1/catalog/started?module=' + encodeURIComponent(module.id);
    const res = await this.fetchFn(this.baseUrl + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-Atlassian-Token': 'no-check' },
    });
    this.checkStopped(epoch);
    if (isLoginAnswer(res, true)) {
      const e = sessionExpired(path, res.status);
      this.expire(e);
      throw e;
    }
    if (res.status === 200) return this.outcome((await res.json()) as { state: string; reason?: string }, epoch);
    if (res.status === 204) return this.reload(epoch);
    if (res.status === 202) return this.follow(module.id, epoch);
    if (res.status === 404) {
      await this.reload(epoch);
      throw new Error('it is no longer on this instance');
    }
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      this.checkStopped(epoch);
      if (body.error === 'still-not-started') {
        try {
          await this.reload(epoch);
        } catch (err) {
          if (err instanceof StartStopped || isSessionExpired(err)) throw err;
        }
        this.checkStopped(epoch);
        throw new Error(DID_NOT_START);
      }
      await this.reload(epoch);
      throw new Error('it is not waiting to start any more');
    }
    throw new Error(`HTTP ${res.status}`);
  }

  private async outcome(entry: { state: string; reason?: string }, epoch: number): Promise<void> {
    await this.reload(epoch);
    if (entry.state === 'ok') return;
    const reason = reasonInfo(entry.reason);
    throw new Error(reason.kind === 'waiting' ? DID_NOT_START : `it started, but could not be read (${reason.code})`);
  }

  private async follow(id: string, epoch: number): Promise<void> {
    const deadline = Date.now() + START_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(START_POLL_MS);
      this.checkStopped(epoch);
      let summary: Summary;
      try {
        summary = await this.fetchSummary();
      } catch (e) {
        if (!isSessionExpired(e)) continue;
        this.expire(e as Error);
        throw e;
      }
      this.checkStopped(epoch);
      const now = summary.modules.find((m) => m.id === id);
      if (!now) {
        await this.reload(epoch);
        throw new Error('it is no longer on this instance');
      }
      if (now.state === 'ok') return this.reload(epoch);
      if (now.state === 'failed' && reasonInfo(now.reason).kind !== 'waiting') return this.outcome(now, epoch);
    }
    await this.reload(epoch);
    throw new Error('it is still being read: it shows when the catalog has read it');
  }

  private async reload(epoch: number): Promise<void> {
    this.checkStopped(epoch);
    try {
      await this.load();
    } catch (e) {
      this.checkStopped(epoch);
      throw new Error('the catalog could not be loaded again: ' + message(e));
    }
    this.checkStopped(epoch);
  }

  private checkStopped(expectedEpoch?: number): void {
    if (this.stopped || (expectedEpoch !== undefined && expectedEpoch !== this.stopEpoch)) throw new StartStopped();
  }

  private expire(e: Error): void {
    this.error = e;
    this.stop();
    this.listeners.forEach((l) => l());
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.stopEpoch++;
    this.starts.clear();
    this.starting = new Set();
    this.cancelPending();
  }

  // Drops the poll timer and a pending visibilitychange listener.
  private cancelPending(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.waitingForVisible = false;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchFn(this.baseUrl + path, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (isLoginAnswer(res, true)) throw sessionExpired(path, res.status);
    if (res.status === 404) throw new NotFound(path);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private fetchSummary(): Promise<Summary> {
    return this.getJson<Summary>('/rest/restbrowser/1/catalog');
  }

  // Loads the index for the summary's hash. A 404 means the hash moved on, so ask for the summary again, a few times.
  private async refresh(summary: Summary, generation = this.generation): Promise<void> {
    let current = summary;
    let index: Index;
    for (let retry = 0; ; retry++) {
      try {
        index = await this.getJson<Index>(`/rest/restbrowser/1/catalog/index/${encodeURIComponent(current.hash)}`);
        if (generation !== this.generation) return;
        break;
      } catch (e) {
        if (!(e instanceof NotFound) || retry >= RETRY_DELAYS_MS.length) throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[retry]));
      if (generation !== this.generation) return;
      current = await this.fetchSummary();
      if (generation !== this.generation) return;
    }
    if (generation !== this.generation) return;
    this.summary = current;
    this.index = index;
    this.pruneFailures();
    this.listeners.forEach((l) => l());
  }

  // The same operations, but progress, completion or a module's state may have changed: show it if so.
  private update(summary: Summary): void {
    const changed = !this.summary || !sameView(this.summary, summary);
    this.summary = summary;
    if (changed) {
      this.pruneFailures();
      this.listeners.forEach((l) => l());
    }
  }

  // The failure of a start says why a module is still waiting: it goes when the module is read, fails otherwise or is gone.
  private pruneFailures(): void {
    if (!this.startFailures.size || !this.summary) return;
    const waiting = new Set(this.summary.modules.filter((m) => reasonInfo(m.reason).kind === 'waiting' && m.state === 'failed').map((m) => m.id));
    if ([...this.startFailures.keys()].every((id) => waiting.has(id))) return;
    this.startFailures = new Map([...this.startFailures].filter(([id]) => waiting.has(id)));
  }

  // Polls while the catalog is incomplete, and after a failure (`retry`) also when it is complete: what failed to load
  // may be newer than what the page shows.
  private schedulePoll(retry = false): void {
    if (this.stopped || (!this.summary && !retry) || (this.summary?.complete && !retry)) return;
    const delay = POLL_DELAYS_MS[Math.min(this.attempt, POLL_DELAYS_MS.length - 1)];
    this.attempt++;
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private onVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    document.removeEventListener('visibilitychange', this.onVisible);
    this.waitingForVisible = false;
    if (!this.stopped) void this.poll();
  };

  private async poll(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      if (!this.waitingForVisible) {
        this.waitingForVisible = true;
        document.addEventListener('visibilitychange', this.onVisible);
      }
      return;
    }
    const generation = this.generation;
    try {
      const summary = await this.fetchSummary();
      if (generation !== this.generation) return;
      if (summary.hash !== this.summary?.hash) {
        await this.refresh(summary, generation);
        if (generation !== this.generation) return;
        this.attempt = 0;
      } else {
        this.update(summary);
      }
    } catch (e) {
      if (generation !== this.generation) return;
      if (isSessionExpired(e)) return this.expire(e as Error);
      // Transient failure: keep what we have and try again on the next tick.
      return this.schedulePoll(true);
    }
    this.schedulePoll();
  }
}
