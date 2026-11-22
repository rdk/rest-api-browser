import type { Index, Summary } from './types';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export const POLL_DELAYS_MS = [1000, 2000, 4000, 8000];

// Waits before asking again when the index 404s: on a cluster the nodes may briefly disagree on the hash.
export const RETRY_DELAYS_MS = [250, 500, 1000];

class NotFound extends Error {}

function sessionExpired(path: string): Error {
  const e = new Error(`${path}: HTTP 401`);
  e.name = 'SessionExpired';
  return e;
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
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    this.stopped = false;
    this.error = null;
    const generation = ++this.generation;
    try {
      const summary = await this.fetchSummary();
      if (generation !== this.generation) return;
      await this.refresh(summary, generation);
    } catch (e) {
      if (isSessionExpired(e)) this.expire(e as Error);
      throw e;
    }
    if (generation !== this.generation) return;
    this.schedulePoll();
  }

  // Re-runs load(), e.g. after an admin triggered a rebuild.
  refreshSoon(): Promise<void> {
    return this.load();
  }

  private expire(e: Error): void {
    this.error = e;
    this.stop();
    this.listeners.forEach((l) => l());
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.waitingForVisible = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchFn(this.baseUrl + path, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (res.status === 401) throw sessionExpired(path);
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
        break;
      } catch (e) {
        if (!(e instanceof NotFound) || retry >= RETRY_DELAYS_MS.length) throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[retry]));
      if (generation !== this.generation) return;
      current = await this.fetchSummary();
    }
    if (generation !== this.generation) return;
    this.summary = current;
    this.index = index;
    this.listeners.forEach((l) => l());
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
    try {
      const generation = this.generation;
      const summary = await this.fetchSummary();
      if (summary.hash !== this.summary?.hash) {
        await this.refresh(summary, generation);
        this.attempt = 0;
      } else {
        this.summary = summary;
      }
    } catch (e) {
      if (isSessionExpired(e)) return this.expire(e as Error);
      // Transient failure: keep what we have and try again on the next tick.
    }
    this.schedulePoll();
  }
}
