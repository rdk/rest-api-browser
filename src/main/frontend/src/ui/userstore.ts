import type { RequestValues } from '../core/request';

export interface HistoryEntry {
  id: string;
  opKey: string;
  at: number;
  method: string;
  url: string;
  values: RequestValues;
  status?: number;
  durationMs?: number;
  size?: number;
  bodyPreview?: string;   // old entries only
  bodyTruncated?: boolean;
  custom?: { name: string; value: string }[];   // custom headers, credentials removed
  noXsrfHeader?: boolean;
}

export interface Prefs {
  sidebarWidth?: number;
  split?: number;
  collapsed?: string[];
  supportedOnly?: boolean;
  /** The skin chosen in the menu (see skins.css). */
  skin?: string;
  /** The colour mode chosen in the menu: light, dark or system; absent, the product's. */
  mode?: string;
}

const PER_OP = 20;
const OVERALL = 500;
const BODY_MAX = 10_000;

const ALWAYS_DROP = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);

export function isCredentialHeader(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (n === 'x-atlassian-token') return false;
  return ALWAYS_DROP.has(n) || /token|secret|password|api[-_]?key|^auth/i.test(n);
}

function cleanValues(values: RequestValues): RequestValues {
  const header: Record<string, string> = {};
  for (const [name, value] of Object.entries(values.header ?? {})) {
    if (!isCredentialHeader(name)) header[name] = value;
  }
  // Credentials can also be typed as query or matrix parameters
  const dropAuth = <T>(rec: Record<string, T>) =>
    Object.fromEntries(Object.entries(rec).filter(([k]) => !isCredentialHeader(k)));
  return { ...values, header, query: dropAuth(values.query ?? {}), matrix: dropAuth(values.matrix ?? {}), path: values.path ?? {} };
}

/** Removes credential parameters from a URL: query parameters, and matrix parameters (";token=...") in its path. */
function cleanUrl(url: string): string {
  const q0 = url.indexOf('?');
  const path = q0 < 0 ? url : url.slice(0, q0);
  const cleanPath = path.replace(/;([^;/?#=]*)(=[^;/?#]*)?/g, (m, name: string) => {
    let n = name;
    try {
      n = decodeURIComponent(name);
    } catch {
      // keep the raw name
    }
    return isCredentialHeader(n) ? '' : m;
  });
  if (cleanPath !== path) url = cleanPath + (q0 < 0 ? '' : url.slice(q0));
  const q = url.indexOf('?');
  if (q < 0) return url;
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  const kept = query.split('&').filter((pair) => {
    let name = pair.split('=')[0].replace(/\+/g, ' ');
    try {
      name = decodeURIComponent(name);
    } catch {
      // keep the raw name
    }
    return !isCredentialHeader(name);
  });
  return url.slice(0, q) + (kept.length ? '?' + kept.join('&') : '') + (hash < 0 ? '' : url.slice(hash));
}

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

const dropOldest = (list: HistoryEntry[]) => list.slice(0, Math.ceil(list.length / 2));

let counter = 0;
const newId = () => `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export class UserStore {
  private readonly prefix: string;
  private readonly storage: Storage | null;
  private readonly memory = new Map<string, string>();
  private readonly memoryOnly = new Set<string>();   // keys whose last write failed: memory wins over storage

  constructor(namespace: string, storage?: Storage | null) {
    this.prefix = `rab-next:${namespace}:`;
    this.storage = storage === undefined ? defaultStorage() : storage;
  }

  private read<T>(key: string, fallback: T): T {
    const k = this.prefix + key;
    let raw: string | null | undefined;
    if (this.memoryOnly.has(k)) raw = this.memory.get(k);
    else {
      try {
        raw = this.storage?.getItem(k);
      } catch {
        raw = undefined;
      }
      raw = raw ?? this.memory.get(k);
    }
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  // On a failed write (quota) the shrunk value gets one retry; otherwise the key lives in memory only.
  private write(key: string, value: unknown, shrink?: (v: any) => unknown): void {
    const k = this.prefix + key;
    const raw = JSON.stringify(value);
    const attempt = (text: string) => {
      if (!this.storage) throw new Error('no storage');
      this.storage.setItem(k, text);
    };
    try {
      attempt(raw);
    } catch {
      try {
        if (!shrink) throw new Error('cannot shrink');
        attempt(JSON.stringify(shrink(value)));
      } catch {
        this.memory.set(k, raw);
        this.memoryOnly.add(k);
        return;
      }
    }
    this.memory.delete(k);
    this.memoryOnly.delete(k);
  }

  // One list for everything (newest first), so the overall cap is a single slice
  private all(): HistoryEntry[] {
    const list = this.read<HistoryEntry[]>('history', []);
    return Array.isArray(list) ? list : [];
  }

  async history(opKey: string): Promise<HistoryEntry[]> {
    return this.all().filter((e) => e.opKey === opKey);
  }

  async addHistory(entry: Omit<HistoryEntry, 'id' | 'at'>): Promise<HistoryEntry> {
    const saved: HistoryEntry = {
      ...entry,
      id: newId(),
      at: Date.now(),
      url: cleanUrl(entry.url),
      values: cleanValues(entry.values),
      custom: entry.custom?.filter((h) => h.name.trim() && !isCredentialHeader(h.name)),
    };
    delete saved.bodyPreview;
    const body = saved.values.body;
    if (body !== undefined && body.length > BODY_MAX) {
      saved.values = { ...saved.values, body: body.slice(0, BODY_MAX) };
      saved.bodyTruncated = true;
    }
    const kept: HistoryEntry[] = [];
    let forOp = 0;
    for (const e of [saved, ...this.all()]) {
      if (e.opKey === saved.opKey && ++forOp > PER_OP) continue;
      kept.push(e);
    }
    this.write('history', kept.slice(0, OVERALL), dropOldest);
    return saved;
  }

  async clearHistory(opKey: string): Promise<void> {
    this.write('history', this.all().filter((e) => e.opKey !== opKey), dropOldest);
  }

  async prefs(): Promise<Prefs> {
    return this.read<Prefs>('prefs', {});
  }

  async setPrefs(patch: Partial<Prefs>): Promise<void> {
    this.write('prefs', { ...(await this.prefs()), ...patch });
  }
}
