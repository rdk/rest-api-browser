import type { BuiltRequest } from '../core/request';

export type ResultKind = 'json' | 'xml' | 'html' | 'text' | 'binary' | 'empty';

export interface RunResult {
  method: string;
  url: string;
  status: number;
  statusText: string;
  ok: boolean;
  headers: [string, string][];
  contentType: string;
  durationMs: number;
  size: number;
  truncated: boolean;
  kind: ResultKind;
  text?: string;
  blob?: Blob;
  sessionExpired: boolean;
  error?: string;
}

const DEFAULT_CAP = 20 * 1024 * 1024;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function kindOf(contentType: string, size: number): ResultKind {
  if (size === 0) return 'empty';
  const ct = contentType.toLowerCase().split(';')[0].trim();
  if (ct === 'application/json' || ct.endsWith('+json')) return 'json';
  if (ct.includes('xml')) return 'xml';
  if (ct === 'text/html') return 'html';
  if (ct.startsWith('text/') || ct === 'application/javascript') return 'text';
  return 'binary';
}

function isSessionExpired(res: Response, contentType: string): boolean {
  if (res.status === 401) return true;
  const reason = (res.headers.get('x-seraph-loginreason') ?? '').toUpperCase();
  if (reason.includes('OUT') || reason.includes('AUTHENTICATION')) return true;
  return !!res.redirected && /login/i.test(res.url) && /text\/html/i.test(contentType);
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
  return { chunks, size, truncated };
}

function decode(chunks: Uint8Array[]): string {
  const decoder = new TextDecoder('utf-8');
  let out = '';
  for (const c of chunks) out += decoder.decode(c, { stream: true });
  return out + decoder.decode();
}

// What a download should save: the binary blob, or the text as a Blob made on demand.
export function downloadBlob(result: RunResult): Blob | null {
  if (result.blob) return result.blob;
  if (result.text !== undefined) return new Blob([result.text], { type: result.contentType });
  return null;
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
    const base = { method: req.method, url: req.url };
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
        text: kind === 'binary' ? undefined : decode(chunks),
        blob: kind === 'binary' ? new Blob(chunks as BlobPart[], { type: contentType }) : undefined,
        sessionExpired: isSessionExpired(res, contentType),
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
