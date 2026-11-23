import type { Index, Module, Summary } from './types';
import { trimModulePath } from './template';

/** A path no module has: the GET that starts a module answers 404, and nothing of the module runs. */
export const START_PATH = 'rest-api-browser-start';
/** How long starting a module waits for the catalog to read it again. */
export const START_WAIT_MS = 30_000;

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

const isSessionExpired = (e: unknown) => e instanceof Error && e.name === 'SessionExpired';

export class CatalogStore {
  summary: Summary | null = null;
  index: Index | null = null;
  error: Error | null = null;   // set when the session expired; polling has stopped

  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;
  private generation = 0;
  private waitingForVisible = false;

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
        else this.schedulePoll();   // a transient failure: an incomplete catalog is still polled
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
   * Starts a module that had not started (failed, reason not-started): some products (Confluence) start a module's
   * REST API on its first request, on each node. A GET to a path the module does not have starts it on this node
   * (the session sticks to one node of a cluster), then the catalog is asked to read the module again, and followed
   * until it has. Rejects with the reason when the server refuses (a session that expired, a module that failed for
   * another reason).
   */
  async startModule(module: Module): Promise<void> {
    try {
      await this.fetchFn(`${this.baseUrl}/rest/${trimModulePath(module.path)}/${START_PATH}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
    } catch {
      // the answer does not matter, only that the request reached the module
    }
    const path = '/rest/restbrowser/1/catalog/started?module=' + encodeURIComponent(module.id);
    const res = await this.fetchFn(this.baseUrl + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-Atlassian-Token': 'no-check' },
    });
    if (isLoginAnswer(res)) throw sessionExpired(path, res.status);
    if (res.status === 409) throw new Error('it failed for another reason, which starting it does not fix');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await this.load();
    // the catalog reads the module again in the background: wait for it, then tell whether the module started
    for (let waited = 0; this.summary && !this.summary.complete && waited < START_WAIT_MS; waited += 250) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const now = this.summary?.modules.find((m) => m.id === module.id);
    if (now && now.state === 'failed' && now.reason === 'not-started') {
      throw new Error('the product did not start it on that request (some modules start only for their own kind of '
        + 'login, OAuth tokens for example)');
    }
  }

  private expire(e: Error): void {
    this.error = e;
    this.stop();
    this.listeners.forEach((l) => l());
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
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
        index = await this.getJson<Index>(`/rest/restbrowser/1/catalog/index/${current.hash}`);
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
    this.listeners.forEach((l) => l());
  }

  // The same operations, but progress, completion or a module's state may have changed: show it if so.
  private update(summary: Summary): void {
    const changed = !this.summary || !sameView(this.summary, summary);
    this.summary = summary;
    if (changed) this.listeners.forEach((l) => l());
  }

  private schedulePoll(): void {
    if (this.stopped || !this.summary || this.summary.complete) return;
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
    }
    this.schedulePoll();
  }
}
