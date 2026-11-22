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

const encodePath = (value: string) => value.split('/').map(encodeURIComponent).join('/');

function fillPath(op: Operation, values: Record<string, string>): string {
  const templates = findTemplates(op.path);
  let out = '';
  let last = 0;
  for (const t of templates) {
    const value = values[t.name] ?? '';
    const param = op.params.find((p) => p.in === 'path' && p.name === t.name);
    if (value === '' && (!param || param.required)) throw new Error(`Missing required path parameter: ${t.name}`);
    out += op.path.slice(last, t.start) + encodePath(value);
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
  headers['Accept'] = options.accept ?? values.accept ?? op.produces[0] ?? 'application/json';

  const req: BuiltRequest = { method, url, headers };
  const bodyAllowed = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  if (bodyAllowed && values.body !== undefined && values.body !== '') {
    req.body = values.body;
    headers['Content-Type'] = values.contentType ?? op.consumes[0] ?? 'application/json';
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !options.noXsrfHeader) {
    headers['X-Atlassian-Token'] = 'no-check';
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
