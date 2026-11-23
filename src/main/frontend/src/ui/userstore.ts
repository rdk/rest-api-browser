import { maskJson } from '../core/jsonlines';
import { urlParts, type RequestValues } from '../core/request';
import type { Operation, Summary } from '../core/types';

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
  'principal', 'jsessionid', 'oauth', 'csrf', 'xsrf', 'cookie2',
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
  return words.some((w, i) => SECRET_WORDS.has(w) || (i + 1 < words.length && SECRET_WORDS.has(w + '-' + words[i + 1]))
    || SECRET_ENDINGS.some((e) => w.length > e.length && w.endsWith(e)));
}

/**
 * Endings that make a run-together word a secret too (the echo's SECRET_ENDINGS): HTTP/2 lowercases header names, so
 * X-AccessToken arrives as x-accesstoken, one word.
 */
const SECRET_ENDINGS = ['token', 'tokens', 'secret', 'secrets', 'password', 'passwords', 'passwd', 'apikey', 'apikeys',
  'credential', 'credentials', 'sessionid', 'signature'];

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

// The members of a JSON body whose string values are hidden: the credential parameter names, and any with password,
// secret or token in it. Any value (a number, an object) only when the name ends with one: "tokenCount": 5 stays.
const isSecretMember = (name: string) => isCredentialParam(name) || /password|passwd|secret|token/i.test(name);
const isSecretAny = (name: string) => isCredentialParam(name) || /(password|passwd|secret|secrets|token|tokens)$/i.test(name);

/** Words that make a body that is not JSON (or not valid JSON) too risky to keep: it is left out instead. */
const SECRET_TEXT = /pass(word|wd)?\b|passwd|secret|token|api[-_]?key|credential|authorization/i;

/**
 * A body as history may keep it: JSON with its secret values hidden; a form body (x-www-form-urlencoded) without its
 * secret fields' values; any other text whole, unless it looks like it carries a secret, then not at all.
 */
function cleanBody(body: string, contentType: string | undefined): { body: string | undefined; redacted: boolean } {
  const masked = maskJson(body, isSecretMember, HIDDEN, isSecretAny);
  if (masked) return masked.masked ? { body: masked.text, redacted: true } : { body, redacted: false };
  if (/x-www-form-urlencoded/i.test(contentType ?? '')) {
    let redacted = false;
    const decode = (s: string) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
      } catch {
        return s;   // keep it raw
      }
    };
    const pairs = body.split('&').map((pair) => {
      const eq = pair.indexOf('=');
      const n = decode(eq < 0 ? pair : pair.slice(0, eq));
      // an empty value, or only spaces, has nothing to hide
      if (eq < 0 || !isSecretMember(n) || !decode(pair.slice(eq + 1)).trim()) return pair;
      redacted = true;
      return pair.slice(0, eq + 1) + encodeURIComponent('(hidden)');
    });
    return { body: pairs.join('&'), redacted };
  }
  return SECRET_TEXT.test(body) ? { body: undefined, redacted: true } : { body, redacted: false };
}

/**
 * The URL as history keeps it, built from the operation's template: a credential path value stays its {template}
 * (it is not stored), every other part as sent. Built rather than searched for, so a value that also appears as a
 * literal part of the path ("rest") does not touch that part.
 */
export function historyUrl(summary: Summary, op: Operation, values: RequestValues): string {
  const path = Object.fromEntries(Object.entries(values.path ?? {}).map(([k, v]) => [k, isCredentialParam(k) ? '' : v]));
  return urlParts(summary, op, { ...values, path }).parts.map((p) => p.text).join('');
}

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
    const clean = cleanBody(values.body, values.contentType);
    if (clean.redacted) {
      out.body = clean.body;
      redacted = true;
    }
  }
  return { values: out, redacted };
}

/**
 * Removes credentials from a URL: query parameters and matrix parameters (";token=...") by name. Credential path
 * values are not searched for here: the caller builds the URL with historyUrl, which leaves them out.
 */
function cleanUrl(url: string): { url: string; redacted: boolean } {
  const q0 = url.search(/[?#]/);
  const path = q0 < 0 ? url : url.slice(0, q0);
  const cleanPath = path.replace(/;([^;/?#=]*)(=[^;/?#]*)?/g, (m, name: string) => {
    let n = name;
    try {
      n = decodeURIComponent(name);
    } catch {
      // keep the raw name
    }
    return isCredentialParam(n) ? '' : m;
  });
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

  // On a failed write (quota) the value is shrunk and tried again, as long as shrinking makes it smaller; when nothing
  // fits, the key lives in memory only.
  private write(key: string, value: unknown, shrink?: (v: any) => unknown): void {
    const k = this.prefix + key;
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
    const url = cleanUrl(entry.url);
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

  // No shrinking here: it would drop other operations' entries to make room for a shorter list.
  async clearHistory(opKey: string): Promise<void> {
    this.write(this.historyKey, this.all().filter((e) => e.opKey !== opKey));
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
