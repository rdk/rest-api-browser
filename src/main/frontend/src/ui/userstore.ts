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
  bodyPreview?: string;
  custom?: { name: string; value: string }[];   // custom headers, credentials removed
  noXsrfHeader?: boolean;
}

export interface Prefs {
  sidebarWidth?: number;
  split?: number;
  collapsed?: string[];
  supportedOnly?: boolean;
  methods?: string[];
}

const PER_OP = 20;
const OVERALL = 500;
const PREVIEW_MAX = 2000;

const ALWAYS_DROP = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);

export function isCredentialHeader(name: string): boolean {
  const n = name.toLowerCase();
  if (n === 'x-atlassian-token') return false;
  return ALWAYS_DROP.has(n) || /token|secret|password/.test(n);
}

function cleanValues(values: RequestValues): RequestValues {
  const header: Record<string, string> = {};
  for (const [name, value] of Object.entries(values.header ?? {})) {
    if (!isCredentialHeader(name)) header[name] = value;
  }
  // Authorization can also be typed as a query or matrix parameter
  const dropAuth = <T>(rec: Record<string, T>) =>
    Object.fromEntries(Object.entries(rec).filter(([k]) => k.toLowerCase() !== 'authorization'));
  return { ...values, header, query: dropAuth(values.query ?? {}), matrix: dropAuth(values.matrix ?? {}), path: values.path ?? {} };
}

function defaultStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

let counter = 0;
const newId = () => `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export class UserStore {
  private readonly prefix: string;
  private readonly storage: Storage | null;
  private readonly memory = new Map<string, string>();

  constructor(namespace: string, storage?: Storage | null) {
    this.prefix = `rab-next:${namespace}:`;
    this.storage = storage === undefined ? defaultStorage() : storage;
  }

  private read<T>(key: string, fallback: T): T {
    const k = this.prefix + key;
    let raw: string | null | undefined;
    try {
      raw = this.storage?.getItem(k);
    } catch {
      raw = undefined;
    }
    raw = raw ?? this.memory.get(k);
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private write(key: string, value: unknown): void {
    const k = this.prefix + key;
    const raw = JSON.stringify(value);
    try {
      if (!this.storage) throw new Error('no storage');
      this.storage.setItem(k, raw);
      this.memory.delete(k);
    } catch {
      this.memory.set(k, raw);
    }
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
      values: cleanValues(entry.values),
      custom: entry.custom?.filter((h) => h.name.trim() && !isCredentialHeader(h.name.trim())),
      bodyPreview: entry.bodyPreview === undefined ? undefined : entry.bodyPreview.slice(0, PREVIEW_MAX),
    };
    const kept: HistoryEntry[] = [];
    let forOp = 0;
    for (const e of [saved, ...this.all()]) {
      if (e.opKey === saved.opKey && ++forOp > PER_OP) continue;
      kept.push(e);
    }
    this.write('history', kept.slice(0, OVERALL));
    return saved;
  }

  async clearHistory(opKey: string): Promise<void> {
    this.write('history', this.all().filter((e) => e.opKey !== opKey));
  }

  async prefs(): Promise<Prefs> {
    return this.read<Prefs>('prefs', {});
  }

  async setPrefs(patch: Partial<Prefs>): Promise<void> {
    this.write('prefs', { ...(await this.prefs()), ...patch });
  }
}
