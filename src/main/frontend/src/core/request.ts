import { findTemplates } from './template';
import type { Operation, Summary } from './types';

export interface RequestValues {
  path: Record<string, string>;
  query: Record<string, string[]>;
  header: Record<string, string>;
  matrix: Record<string, string>;
  body?: string;
  contentType?: string;
  accept?: string;
}

export interface RequestOptions {
  accept?: string;
  noXsrfHeader?: boolean;
}

export interface BuiltRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

// Slashes stay only for a parameter whose regex lets it span segments.
const encodePath = (value: string, spans: boolean) =>
  spans ? value.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(value);

const WILDCARD_FALLBACK = ['application/json', 'application/xml', 'text/plain'];

// The concrete types of a list, plus the usual ones when the list is empty or has a wildcard.
export function mediaChoices(list: string[], fallback: string[] = WILDCARD_FALLBACK): string[] {
  const concrete = list.filter((t) => !t.includes('*'));
  const all = concrete.length === list.length && list.length ? concrete : [...concrete, ...fallback];
  return [...new Set(all)];
}

const defaultType = (list: string[]) => (list[0] && !list[0].includes('*') ? list[0] : 'application/json');

// Header names are case-insensitive: replace an existing one whatever its case.
export function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) if (key.toLowerCase() === lower) delete headers[key];
  headers[name] = value;
}

function fillPath(op: Operation, values: Record<string, string>): string {
  const templates = findTemplates(op.path);
  let out = '';
  let last = 0;
  for (const t of templates) {
    const value = values[t.name] ?? '';
    const param = op.params.find((p) => p.in === 'path' && p.name === t.name);
    if (value === '' && (!param || param.required)) throw new Error(`Missing required path parameter: ${t.name}`);
    out += op.path.slice(last, t.start) + encodePath(value, /\.\*|\.\+|\//.test(t.regex ?? ''));
    last = t.end;
  }
  return out + op.path.slice(last);
}

export function buildRequest(summary: Summary, op: Operation, values: RequestValues, options: RequestOptions = {}): BuiltRequest {
  const module = summary.modules.find((m) => m.id === op.module);
  const modulePath = (module?.path ?? '').replace(/^\/+|\/+$/g, '');
  const method = op.method.toUpperCase();

  let url = `${summary.baseUrl}/rest/${modulePath ? modulePath + '/' : ''}${fillPath(op, values.path)}`;
  for (const [name, value] of Object.entries(values.matrix)) {
    if (value !== '') url += `;${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  }

  const pairs: string[] = [];
  for (const [name, list] of Object.entries(values.query)) {
    for (const value of list) {
      if (value !== '') pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
    }
  }
  if (pairs.length) url += '?' + pairs.join('&');

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(values.header)) {
    if (value !== '') headers[name] = value;
  }
  setHeader(headers, 'Accept', options.accept ?? values.accept ?? defaultType(op.produces));

  const req: BuiltRequest = { method, url, headers };
  const bodyAllowed = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  if (bodyAllowed && values.body !== undefined && values.body !== '') {
    req.body = values.body;
    setHeader(headers, 'Content-Type', values.contentType ?? defaultType(op.consumes));
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !options.noXsrfHeader) {
    setHeader(headers, 'X-Atlassian-Token', 'no-check');
  }
  return req;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function toCurl(req: BuiltRequest): string {
  const parts = ['curl'];
  if (req.method !== 'GET') parts.push('-X', req.method);
  parts.push('-u', '"$USER:$PASSWORD"');
  for (const [name, value] of Object.entries(req.headers)) parts.push('-H', quote(`${name}: ${value}`));
  if (req.body !== undefined) parts.push('--data-raw', quote(req.body));
  parts.push(quote(req.url));
  return parts.join(' ');
}
