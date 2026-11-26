import {
  cleanRequestBody, cleanUrlSecrets, isCredentialHeader, isCredentialParam, isSecretMember,
} from '../lib/http-redact/redact';
import { urlParts, type RequestValues } from '../core/request';
import type { Operation, Summary } from '../core/types';

export { isCredentialHeader, isCredentialParam };

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
  bodyPreview?: string;   // stored by old versions only: addHistory drops it, and the next write drops the old ones
  bodyTruncated?: boolean;
  custom?: { name: string; value: string }[];   // custom headers, credentials removed
  noXsrfHeader?: boolean;
  /** Something that looked like a credential was left out: a header, a parameter, or a value in the JSON body. */
  redacted?: boolean;
}

export interface Prefs {
  sidebarWidth?: number;
  split?: number;
  /** Width in pixels of the method outline sidebar in the decompiler dialog. */
  outlineWidth?: number;
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

/**
 * The URL as history keeps it, built from the operation's template: a credential path value stays its {template}
 * (it is not stored), every other part as sent.
 */
export function historyUrl(summary: Summary, op: Operation, values: RequestValues): string {
  const path = Object.fromEntries(Object.entries(values.path ?? {}).map(([k, v]) => [k, isCredentialParam(k) ? '' : v]));
  return urlParts(summary, op, { ...values, path }).parts.map((p) => p.text).join('');
}

const filled = (v: unknown): boolean => (Array.isArray(v) ? v.some(filled) : typeof v === 'string' && v.trim() !== '');

function cleanValues(values: RequestValues): { values: RequestValues; redacted: boolean } {
  let redacted = false;
  const keep = <T>(map: Record<string, T> | undefined, secret: (name: string) => boolean): Record<string, T> =>
    Object.fromEntries(Object.entries(map ?? {}).filter(([name, v]) => {
      if (!secret(name)) return true;
      if (filled(v)) redacted = true;
      return false;
    }));
  const out: RequestValues = {
    ...values,
    header: keep(values.header, isCredentialHeader),
    query: keep(values.query, isCredentialParam),
    matrix: keep(values.matrix, isCredentialParam),
    path: keep(values.path, isCredentialParam),
  };
  // Form fields carry the same risk as JSON/form bodies (`passwordConfirm`, `secretKey`, etc.).
  if (values.form) out.form = keep(values.form, isSecretMember);
  delete out.files; // never store uploaded files in history
  if (values.body) {
    const clean = cleanRequestBody(values.body, values.contentType);
    if (clean.redacted) {
      out.body = clean.body;
      redacted = true;
    }
  }
  return { values: out, redacted };
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

const isValidHistoryEntry = (e: unknown): e is HistoryEntry =>
  !!e && typeof e === 'object' && !Array.isArray(e)
  && typeof (e as HistoryEntry).opKey === 'string'
  && typeof (e as HistoryEntry).url === 'string'
  && !!(e as HistoryEntry).values && typeof (e as HistoryEntry).values === 'object';

export class UserStore {
  private readonly prefix: string;
  private readonly historyKey: string;
  private readonly storage: Storage | null;
  private readonly memory = new Map<string, string>();
  private readonly memoryOnly = new Set<string>();   // keys whose last write failed: memory wins over storage
  private cachedHistoryRaw: string | null = null;
  private cachedHistoryList: HistoryEntry[] | null = null;

  constructor(namespace: string, storage?: Storage | null);
  constructor(namespace: string, user: string | undefined, storage?: Storage | null);
  constructor(namespace: string, userOrStorage?: string | Storage | null, storage?: Storage | null) {
    const user = typeof userOrStorage === 'string' && userOrStorage ? userOrStorage : undefined;
    const given = typeof userOrStorage === 'object' ? userOrStorage : storage;
    this.prefix = `rab-next:${namespace}:`;
    this.storage = given === undefined ? defaultStorage() : given;
    this.historyKey = user ? 'history:' + encodeURIComponent(user) : 'history';
    if (user) this.remove('history');
  }

  private readRaw(key: string): string | null {
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
    return raw ?? null;
  }

  private read<T>(key: string, fallback: T): T {
    const raw = this.readRaw(key);
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private write(key: string, value: unknown, shrink?: (v: any) => unknown): void {
    const k = this.prefix + key;
    if (key === this.historyKey) {
      this.cachedHistoryRaw = null;
      this.cachedHistoryList = null;
    }
    const raw = JSON.stringify(value);
    if (this.storage) {
      let current = value;
      let text = raw;
      for (;;) {
        try {
          this.storage.setItem(k, text);
          this.memory.delete(k);
          this.memoryOnly.delete(k);
          return;
        } catch {
          if (!shrink) break;
          const smaller = JSON.stringify((current = shrink(current)));
          if (smaller.length >= text.length) break;
          text = smaller;
        }
      }
    }
    this.memory.set(k, raw);
    this.memoryOnly.add(k);
  }

  private remove(key: string): void {
    const k = this.prefix + key;
    if (key === this.historyKey) {
      this.cachedHistoryRaw = null;
      this.cachedHistoryList = null;
    }
    this.memory.delete(k);
    this.memoryOnly.delete(k);
    try {
      this.storage?.removeItem(k);
    } catch {
      // nothing more to do
    }
  }

  private all(): HistoryEntry[] {
    const raw = this.readRaw(this.historyKey);
    if (raw == null) return [];
    if (raw === this.cachedHistoryRaw && this.cachedHistoryList) return this.cachedHistoryList;
    try {
      const parsed = JSON.parse(raw);
      const valid = Array.isArray(parsed) ? parsed.filter(isValidHistoryEntry) : [];
      this.cachedHistoryRaw = raw;
      this.cachedHistoryList = valid;
      return valid;
    } catch {
      return [];
    }
  }

  async history(opKey: string): Promise<HistoryEntry[]> {
    return this.all().filter((e) => e.opKey === opKey);
  }

  async addHistory(entry: Omit<HistoryEntry, 'id' | 'at'>): Promise<HistoryEntry> {
    const values = cleanValues(entry.values);
    const url = cleanUrlSecrets(entry.url);
    const named = entry.custom?.filter((h) => h.name.trim());
    const saved: HistoryEntry = {
      ...entry,
      id: newId(),
      at: Date.now(),
      url: url.url,
      values: values.values,
      custom: named?.filter((h) => !isCredentialHeader(h.name)),
    };
    delete saved.bodyPreview;
    delete saved.redacted;
    if (values.redacted || url.redacted || named?.some((h) => isCredentialHeader(h.name) && filled(h.value))) saved.redacted = true;
    const body = saved.values.body;
    if (body !== undefined && body.length > BODY_MAX) {
      saved.values = { ...saved.values, body: body.slice(0, BODY_MAX) };
      saved.bodyTruncated = true;
    }
    const kept: HistoryEntry[] = [];
    let forOp = 0;
    for (const e of [saved, ...this.all()]) {
      if (e.opKey === saved.opKey && ++forOp > PER_OP) continue;
      if (e.bodyPreview === undefined) kept.push(e);
      else {
        const { bodyPreview: _, ...rest } = e;
        kept.push(rest);
      }
    }
    this.write(this.historyKey, kept.slice(0, OVERALL), dropOldest);
    return saved;
  }

  async clearHistory(opKey: string): Promise<void> {
    this.write(this.historyKey, this.all().filter((e) => e.opKey !== opKey));
  }

  prefsNow(): Prefs {
    const p = this.read<Prefs>('prefs', {});
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  }

  async prefs(): Promise<Prefs> {
    return this.prefsNow();
  }

  async setPrefs(patch: Partial<Prefs>): Promise<void> {
    this.write('prefs', { ...this.prefsNow(), ...patch });
  }
}
