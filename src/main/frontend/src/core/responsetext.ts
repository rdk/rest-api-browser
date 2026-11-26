import { formatJson } from '../lib/json-lines';

export type ResponseViewKind = 'pretty' | 'raw' | 'headers' | 'sent';

/** Pretty formats bodies up to this size; larger ones are shown as received in Raw view. */
export const PRETTY_MAX = 5 * 1024 * 1024;

/** Headers that proxies add on the way, told apart from the browser's. */
export const PROXY = /^(x-forwarded-|forwarded$|via$|x-real-ip$|x-request-id$|x-amzn-|x-b3-|traceparent$|true-client-ip$|cf-)/i;

const EXTENSIONS: Record<string, string> = { json: '.json', xml: '.xml', html: '.html', text: '.txt' };

export type ResultKind = 'json' | 'xml' | 'html' | 'text' | 'binary' | 'empty';

export interface ResponseData {
  method: string;
  url: string;
  status: number;
  statusText: string;
  headers: [string, string][];
  requestHeaders: [string, string][];
  requestBodyBytes?: number;
  contentType: string;
  size: number;
  truncated: boolean;
  kind: ResultKind;
  text?: string;
  blob?: Blob;
}

export interface RunResult extends ResponseData {
  ok: boolean;
  durationMs: number;
  sessionExpired: boolean;
  error?: string;
}

export type EchoFetcher<T extends ResponseData = ResponseData> = (baseUrl: string, result: T) => Promise<[string, string][]>;

/**
 * The headers the browser and proxies added, from the echo: those the app did not set itself, with the real body's
 * Content-Length (the echo's copy of the request has no body).
 */
export function addedHeaders(result: Pick<ResponseData, 'requestHeaders' | 'requestBodyBytes'>, echo: [string, string][]): [string, string][] {
  const ownNames = new Set((result.requestHeaders ?? []).map(([k]) => k.toLowerCase()));
  const added = echo
    .filter(([k]) => !ownNames.has(k.toLowerCase()))
    .map(([k, v]): [string, string] =>
      k.toLowerCase() === 'content-length' && result.requestBodyBytes ? [k, String(result.requestBodyBytes)] : [k, v]);
  if (result.requestBodyBytes && !ownNames.has('content-length') && !added.some(([k]) => k.toLowerCase() === 'content-length')) {
    added.push(['content-length', String(result.requestBodyBytes)]);
  }
  return added;
}

/**
 * What the open tab shows as text: headers as "name: value" lines, Pretty JSON indented (numbers and keys
 * preserved verbatim), else the body as received. Null for a body that is empty or binary.
 */
export async function textOf<T extends ResponseData>(
  view: ResponseViewKind,
  result: T,
  baseUrl: string,
  fetchEchoFn?: EchoFetcher<T>,
): Promise<string | null> {
  const lines = (pairs: [string, string][]) => pairs.map(([k, v]) => `${k}: ${v}\n`).join('');
  if (view === 'headers') return `HTTP ${result.status} ${result.statusText}\n${lines(result.headers)}`;
  if (view === 'sent') {
    let added: string;
    try {
      const echo = fetchEchoFn ? await fetchEchoFn(baseUrl, result) : [];
      added = lines(addedHeaders(result, echo));
    } catch (e) {
      added = `# The headers the browser added could not be read: ${e instanceof Error ? e.message : String(e)}\n`;
    }
    return `${result.method} ${result.url}\n${lines(result.requestHeaders ?? [])}${added}`;
  }
  if (result.size === 0 || result.text === undefined) return null;
  if (view === 'pretty' && result.kind === 'json' && !result.truncated && result.text.length <= PRETTY_MAX) {
    const formatted = formatJson(result.text);
    if (formatted !== null) return formatted + '\n';
  }
  return result.text;
}

/** The raw download Blob of a response result, without converting pretty JSON. */
export function responseBlob(result: Pick<ResponseData, 'blob' | 'text' | 'contentType'>): Blob | null {
  if (result.blob) return result.blob;
  if (result.text !== undefined) return new Blob([result.text], { type: result.contentType });
  return null;
}

/** The open tab as a downloadable file, or null when there is nothing to save. */
export async function downloadOf<T extends ResponseData>(
  view: ResponseViewKind,
  result: T,
  baseUrl: string,
  fetchEchoFn?: EchoFetcher<T>,
): Promise<{ blob: Blob; name: string } | null> {
  if (view === 'headers' || view === 'sent') {
    const text = await textOf(view, result, baseUrl, fetchEchoFn);
    return text === null
      ? null
      : { blob: new Blob([text], { type: 'text/plain' }), name: view === 'headers' ? 'response-headers.txt' : 'request-headers.txt' };
  }
  if (view === 'pretty' && result.kind === 'json') {
    const text = await textOf(view, result, baseUrl, fetchEchoFn);
    if (text !== null && text !== result.text) return { blob: new Blob([text], { type: 'application/json' }), name: 'response.json' };
  }
  const blob = responseBlob(result);
  return blob && result.size > 0 ? { blob, name: 'response' + (EXTENSIONS[result.kind] ?? '') } : null;
}

/** Index of value in a sorted array, or -1. */
export function indexIn(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] === value) return mid;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
