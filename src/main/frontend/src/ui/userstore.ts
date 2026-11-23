import { maskJson } from '../core/jsonlines';
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
const HIDDEN = '"(hidden)"';

/**
 * The words of a header name that make its value a secret, the same as the server's echo has (EchoResource): keys,
 * tokens and passwords, and what a proxy adds about the user. Whole words once runs of other characters are dashes,
 * so X-Author-Id and X-Processor stay; "api-key" is two words.
 */
const SECRET_WORDS = new Set([
  'secret', 'secrets', 'password', 'passwords', 'passwd', 'pwd', 'session', 'sessions', 'sessionid', 'api-key', 'api-keys',
  'apikey', 'apikeys', 'token', 'tokens', 'credential', 'credentials', 'jwt', 'assertion', 'assertions', 'signature',
  'signatures', 'auth', 'authorization', 'authn', 'cert', 'certs', 'certificate', 'certificates', 'oidc', 'sso', 'saml',
  'principal',
]);

/**
 * Whether a header carries a credential, by its name: the server's echo rule (X_API_KEY, x-api-key and X-ApiKey
 * alike; X-Atlassian-Token is not one, it says "no-check"), and cookies, which the echo shows by name only.
 */
export function isCredentialHeader(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (n === 'x-atlassian-token') return false;
  if (n === 'cookie' || n === 'set-cookie') return true;
  const words = n.split('-');
  return words.some((w, i) => SECRET_WORDS.has(w) || (i + 1 < words.length && SECRET_WORDS.has(w + '-' + words[i + 1])));
}

// Compared without case and separators: api_key, api-key and apiKey are one name.
const SECRET_PARAMS = new Set([
  'password', 'passwd', 'pwd', 'secret', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'apikey', 'apitoken',
  'atltoken', 'clientsecret', 'authorization', 'authcode', 'jwt', 'sessionid', 'jsessionid',
]);

/**
 * Whether a query, matrix or path parameter carries a credential, by its name: one of a few exact names (password,
 * token, access_token, api_key, atl_token, ...) or one ending in "password" or "secret". Narrower than the header
 * rule, so author, pageToken or syncToken stay and the history shows the request that was sent.
 */
export function isCredentialParam(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  return SECRET_PARAMS.has(n) || n.endsWith('password') || n.endsWith('secret');
}

// The members of a JSON body whose values are hidden: the credential parameter names, and any with password, secret
// or token in it.
const isSecretMember = (name: string) => isCredentialParam(name) || /password|passwd|secret|token/i.test(name);

const filled = (v: unknown): boolean => (Array.isArray(v) ? v.some(filled) : typeof v === 'string' && v.trim() !== '');

/** The values without credentials, and whether one that was filled in was left out. */
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
  if (values.body) {
    const masked = maskJson(values.body, isSecretMember, HIDDEN);
    if (masked?.masked) {
      out.body = masked.text;
      redacted = true;
    }
  }
  return { values: out, redacted };
}

/**
 * The path with a value replaced by `mark`: where it is whole segments, or, when it is nowhere whole (a value that is
 * part of a segment, "{token}.json"), wherever it is.
 */
function replaceValue(path: string, value: string, mark: string): string {
  const at: number[] = [];
  for (let i = path.indexOf(value); i >= 0; i = path.indexOf(value, i + value.length)) at.push(i);
  const whole = (i: number) => path[i - 1] === '/' && (i + value.length === path.length || '/;'.includes(path[i + value.length]));
  const hits = at.some(whole) ? at.filter(whole) : at;
  let out = '';
  let last = 0;
  for (const i of hits) {
    out += path.slice(last, i) + mark;
    last = i + value.length;
  }
  return out + path.slice(last);
}

/**
 * Removes credentials from a URL: query parameters and matrix parameters (";token=...") by name, and the values of
 * credential path parameters (`secrets`), which become their {template}.
 */
function cleanUrl(url: string, secrets: [string, string][]): { url: string; redacted: boolean } {
  const q0 = url.search(/[?#]/);
  const path = q0 < 0 ? url : url.slice(0, q0);
  let cleanPath = path.replace(/;([^;/?#=]*)(=[^;/?#]*)?/g, (m, name: string) => {
    let n = name;
    try {
      n = decodeURIComponent(name);
    } catch {
      // keep the raw name
    }
    return isCredentialParam(n) ? '' : m;
  });
  for (const [name, value] of secrets) {
    // as buildRequest writes it: slashes kept when the template spans segments, else encoded
    for (const encoded of new Set([value.split('/').map(encodeURIComponent).join('/'), encodeURIComponent(value)])) {
      cleanPath = replaceValue(cleanPath, encoded, `{${name}}`);
    }
  }
  let redacted = cleanPath !== path;
  if (redacted) url = cleanPath + (q0 < 0 ? '' : url.slice(q0));
  const q = url.indexOf('?');
  if (q < 0) return { url, redacted };
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  const kept = query.split('&').filter((pair) => {
    let name = pair.split('=')[0].replace(/\+/g, ' ');
    try {
      name = decodeURIComponent(name);
    } catch {
      // keep the raw name
    }
    return !isCredentialParam(name);
  });
  if (kept.length !== query.split('&').length) redacted = true;
  return { url: url.slice(0, q) + (kept.length ? '?' + kept.join('&') : '') + (hash < 0 ? '' : url.slice(hash)), redacted };
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
  private readonly historyKey: string;
  private readonly storage: Storage | null;
  private readonly memory = new Map<string, string>();
  private readonly memoryOnly = new Set<string>();   // keys whose last write failed: memory wins over storage

  /**
   * `namespace` is the site: the preferences are kept per site. With a `user` the history is kept per user as well,
   * so someone else in the same browser profile does not see it, and the site's shared history of older versions is
   * removed. Without one (anonymous, tests) the history is the site's.
   */
  constructor(namespace: string, storage?: Storage | null);
  constructor(namespace: string, user: string | undefined, storage?: Storage | null);
  constructor(namespace: string, userOrStorage?: string | Storage | null, storage?: Storage | null) {
    const user = typeof userOrStorage === 'string' && userOrStorage ? userOrStorage : undefined;
    const given = typeof userOrStorage === 'object' ? userOrStorage : storage;   // null is an object: no storage
    this.prefix = `rab-next:${namespace}:`;
    this.storage = given === undefined ? defaultStorage() : given;
    this.historyKey = user ? 'history:' + encodeURIComponent(user) : 'history';
    if (user) this.remove('history');
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

  private remove(key: string): void {
    const k = this.prefix + key;
    this.memory.delete(k);
    this.memoryOnly.delete(k);
    try {
      this.storage?.removeItem(k);
    } catch {
      // nothing more to do
    }
  }

  // One list for everything (newest first), so the overall cap is a single slice
  private all(): HistoryEntry[] {
    const list = this.read<HistoryEntry[]>(this.historyKey, []);
    return Array.isArray(list) ? list : [];
  }

  async history(opKey: string): Promise<HistoryEntry[]> {
    return this.all().filter((e) => e.opKey === opKey);
  }

  async addHistory(entry: Omit<HistoryEntry, 'id' | 'at'>): Promise<HistoryEntry> {
    const values = cleanValues(entry.values);
    const secrets = Object.entries(entry.values.path ?? {}).filter(([name, v]) => isCredentialParam(name) && filled(v));
    const url = cleanUrl(entry.url, secrets);
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
    // cut after the secrets are hidden: a cut JSON body cannot be read to hide them
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
    this.write(this.historyKey, this.all().filter((e) => e.opKey !== opKey), dropOldest);
  }

  /** The preferences, read at once: the first paint can have the user's skin, colour mode and layout. */
  prefsNow(): Prefs {
    const p = this.read<Prefs>('prefs', {});
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  }

  async prefs(): Promise<Prefs> {
    return this.prefsNow();
  }

  // Read and written at once, so two quick calls both count.
  async setPrefs(patch: Partial<Prefs>): Promise<void> {
    this.write('prefs', { ...this.prefsNow(), ...patch });
  }
}
