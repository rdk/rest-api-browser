import { isLoginAnswer } from '../core/catalog';
import type { BuiltRequest } from '../core/request';
import { responseBlob, type ResultKind, type RunResult } from '../core/responsetext';

export type { ResultKind, RunResult };

const DEFAULT_CAP = 20 * 1024 * 1024;
const ENCODER = new TextEncoder();

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function kindOf(contentType: string, size: number): ResultKind {
  if (size === 0) return 'empty';
  const ct = contentType.toLowerCase().split(';')[0].trim();
  if (ct === 'application/json' || ct.endsWith('+json')) return 'json';
  // XML itself only: Office files (application/vnd.openxmlformats-...) have "xml" in their type but are zips
  if (ct === 'application/xml' || ct === 'text/xml' || ct.endsWith('+xml')) return 'xml';
  if (ct === 'text/html') return 'html';
  if (
    ct.startsWith('text/')
    || ct === 'application/javascript'
    || ct === 'application/ecmascript'
    || ct === 'application/x-www-form-urlencoded'
    || ct === 'application/yaml'
    || ct === 'application/x-yaml'
    || ct === 'application/graphql'
  ) return 'text';
  return 'binary';
}

/** The charset a Content-Type names ("text/plain; charset=ISO-8859-1"), if any. */
function charsetOf(contentType: string): string | undefined {
  return /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1];
}

// The chunks are never joined: a Blob takes them as parts and the text decoder streams over them.
async function readCapped(res: Response, cap: number): Promise<{ chunks: Uint8Array[]; size: number; truncated: boolean }> {
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    const truncated = all.length > cap;
    return { chunks: [truncated ? all.slice(0, cap) : all], size: Math.min(all.length, cap), truncated };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > cap) {
        chunks.push(value.slice(0, cap - size));
        size = cap;
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      size += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  return { chunks, size, truncated };
}

// In the charset of the Content-Type when the browser knows it, else UTF-8.
function decode(chunks: Uint8Array[], contentType: string): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charsetOf(contentType) ?? 'utf-8');
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  let out = '';
  for (const c of chunks) out += decoder.decode(c, { stream: true });
  return out + decoder.decode();
}

/**
 * The headers the server receives for a request like this one: a copy (same method and the headers the app set, no
 * body) goes to the plugin's echo resource, which answers what arrived, the browser's and proxies' headers included.
 * Cookie values and credentials come back hidden. Asked once per response, when its Request headers tab opens.
 */
const echoes = new WeakMap<RunResult, Promise<[string, string][]>>();
const ECHO_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const hasAuthorization = (headers: Iterable<string>) => [...headers].some((k) => k.toLowerCase() === 'authorization');

const isPair = (h: unknown) => Array.isArray(h) && h.length === 2 && typeof h[0] === 'string' && typeof h[1] === 'string';

export function fetchEcho(baseUrl: string, result: RunResult, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<[string, string][]> {
  let p = echoes.get(result);
  if (!p) {
    const method = ECHO_METHODS.has(result.method.toUpperCase()) ? result.method.toUpperCase() : 'GET';
    p = (async () => {
      const res = await fetchFn(`${baseUrl}/rest/restbrowser/1/echo`, {
        method,
        headers: Object.fromEntries(result.requestHeaders.filter(([k]) => k.toLowerCase() !== 'accept').concat([['Accept', 'application/json']])),
        credentials: 'same-origin',
      });
      // the copy carries the request's headers: a 401 to its own Authorization is not the session
      if (isLoginAnswer(res, true, hasAuthorization(result.requestHeaders.map(([k]) => k)))) {
        const e = new Error('Your session has expired: reload the page to log in again.');
        e.name = 'SessionExpired';
        throw e;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const headers = ((await res.json().catch(() => null)) as { headers?: unknown } | null)?.headers;
      if (!Array.isArray(headers) || !headers.every(isPair)) {
        throw new Error('The server answered with something other than the headers it received.');
      }
      return headers as [string, string][];
    })();
    p.catch(() => echoes.delete(result));
    echoes.set(result, p);
  }
  return p;
}

// What a download should save: the bytes as received, or, for a result without them, the text as a Blob made on demand.
export function downloadBlob(result: RunResult): Blob | null {
  return responseBlob(result);
}

function bodyBytes(body: string | FormData | undefined): number | undefined {
  if (body === undefined) return undefined;
  if (typeof body === 'string') return ENCODER.encode(body).length;
  let total = 0;
  for (const [, v] of body.entries()) {
    total += typeof v === 'string' ? ENCODER.encode(v).length : v.size;
  }
  return total;
}

export class RequestRunner {
  private controller: AbortController | null = null;

  constructor(
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
    private readonly capBytes: number = DEFAULT_CAP,
  ) {}

  get running(): boolean {
    return this.controller !== null;
  }

  abort(): void {
    const c = this.controller;
    this.controller = null;
    c?.abort();
  }

  async run(req: BuiltRequest): Promise<RunResult> {
    this.abort();
    const controller = new AbortController();
    this.controller = controller;
    const start = now();
    const base = {
      method: req.method,
      url: req.url,
      requestHeaders: Object.entries(req.headers),
      requestBodyBytes: bodyBytes(req.body),
    };
    try {
      const res = await this.fetchFn(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        credentials: 'same-origin',
        signal: controller.signal,
      });
      const { chunks, size, truncated } = await readCapped(res, this.capBytes);
      const durationMs = now() - start;
      const contentType = res.headers.get('content-type') ?? '';
      const kind = kindOf(contentType, size);
      const headers: [string, string][] = [];
      res.headers.forEach((value, name) => headers.push([name.toLowerCase(), value]));
      return {
        ...base,
        status: res.status,
        statusText: res.statusText,
        ok: res.ok,
        headers,
        contentType,
        durationMs,
        size,
        truncated,
        kind,
        text: kind === 'binary' || kind === 'empty' ? undefined : decode(chunks, contentType),
        blob: size > 0 ? new Blob(chunks as BlobPart[], { type: contentType }) : undefined,
        // a 401 to the request's own Authorization header is those credentials failing, not the session
        sessionExpired: isLoginAnswer(res, false, hasAuthorization(Object.keys(req.headers))),
      };
    } catch (e) {
      const aborted = controller.signal.aborted;
      return {
        ...base,
        status: 0,
        statusText: '',
        ok: false,
        headers: [],
        contentType: '',
        durationMs: now() - start,
        size: 0,
        truncated: false,
        kind: 'empty',
        sessionExpired: false,
        error: aborted ? 'aborted' : e instanceof Error ? e.message : String(e),
      };
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
