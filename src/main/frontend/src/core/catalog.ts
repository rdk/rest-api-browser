import type { Index, Summary } from './types';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export const POLL_DELAYS_MS = [1000, 2000, 4000, 8000];

class NotFound extends Error {}

export class CatalogStore {
  summary: Summary | null = null;
  index: Index | null = null;

  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;
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
    this.stopped = false;
    await this.refresh(await this.fetchSummary());
    this.schedulePoll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchFn(this.baseUrl + path, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (res.status === 404) throw new NotFound(path);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private fetchSummary(): Promise<Summary> {
    return this.getJson<Summary>('/rest/restbrowser/1/catalog');
  }

  // Loads the index for the summary's hash. A 404 means the hash moved on, so ask for the summary once more.
  private async refresh(summary: Summary): Promise<void> {
    let current = summary;
    let index: Index;
    try {
      index = await this.getJson<Index>(`/rest/restbrowser/1/catalog/index/${current.hash}`);
    } catch (e) {
      if (!(e instanceof NotFound)) throw e;
      current = await this.fetchSummary();
      index = await this.getJson<Index>(`/rest/restbrowser/1/catalog/index/${current.hash}`);
    }
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
      const summary = await this.fetchSummary();
      if (summary.hash !== this.summary?.hash) {
        await this.refresh(summary);
        this.attempt = 0;
      } else {
        this.summary = summary;
      }
    } catch {
      // Transient failure: keep what we have and try again on the next tick.
    }
    this.schedulePoll();
  }
}
