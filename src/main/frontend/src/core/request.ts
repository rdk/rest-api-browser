import { findTemplates } from './template';
import { pathKinds, type PartKind } from './pathparts';
import type { Operation, ParamIn, Summary } from './types';

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

// Slashes stay only for a parameter whose regex lets it span segments: ".*", ".+" or a "/" outside a [^...] class.
const spansSegments = (regex: string | undefined) => /\.\*|\.\+|\//.test((regex ?? '').replace(/\[\^[^\]]*\]/g, ''));

const encodePath = (value: string, spans: boolean) =>
  spans ? value.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(value);

/** A value that is empty or only spaces counts as not filled in, here and in the form's check (validate.ts). */
export const isBlank = (value: string | undefined): boolean => !value || !value.trim();

// The value of a name in a map from the form or a link: its own, never one Object.prototype has ("constructor").
const own = <T>(map: Record<string, T>, name: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined;

// The names of the parameters the operation declares in one place: a draft may hold values for ones it no longer has.
const declared = (op: Operation, where: ParamIn) => new Set(op.params.filter((p) => p.in === where).map((p) => p.name));

const hasHeader = (headers: Record<string, string>, name: string) =>
  Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());

const WILDCARD_FALLBACK = ['application/json', 'application/xml', 'text/plain'];

// The concrete types of a list, plus the usual ones when the list is empty or has a wildcard.
export function mediaChoices(list: string[], fallback: string[] = WILDCARD_FALLBACK): string[] {
  const concrete = list.filter((t) => !t.includes('*'));
  const all = concrete.length === list.length && list.length ? concrete : [...concrete, ...fallback];
  return [...new Set(all)];
}

// The same first choice the UI offers (mediaChoices), so the default is never a wildcard.
const defaultType = (list: string[]) => mediaChoices(list)[0];

// Header names are case-insensitive: replace an existing one whatever its case.
export function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) if (key.toLowerCase() === lower) delete headers[key];
  headers[name] = value;
}

/**
 * A part of a request URL, for display: the path's kinds (pathKinds), base (the context path and "/rest/"), value (a
 * path value filled in), param (a required path value still missing: the template as written), qsep ("?", "&", "=",
 * ";"), qname and qvalue (a query parameter), mname and mvalue (a matrix parameter).
 */
export type UrlKind = PartKind | 'base' | 'value' | 'qsep' | 'qname' | 'qvalue' | 'mname' | 'mvalue';
export interface UrlPart { text: string; kind: UrlKind; }

/**
 * The request URL in parts; joined, they are the URL buildRequest sends. `missing` names the required path values
 * that are empty or blank. Only the parameters the operation declares are in it (path templates count as declared).
 * `error` says why no request can be built: the operation's module is not in the summary (it can be missing for a
 * moment while the catalog is rebuilt); its path then shows as "{module}", like a value still to fill in.
 */
export function urlParts(summary: Summary, op: Operation, values: RequestValues): { parts: UrlPart[]; missing: string[]; error?: string } {
  const module = summary.modules.find((m) => m.id === op.module);
  const modulePath = module ? module.path.replace(/^\/+|\/+$/g, '') : '{module}';
  const head = modulePath ? modulePath + '/' : '';
  const path = head + op.path;
  const kinds = pathKinds(path, { prefix: modulePath.length });
  const parts: UrlPart[] = [];
  const push = (text: string, kind: UrlKind) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ text, kind });
  };
  push(`${summary.baseUrl}/rest/`, 'base');
  const missing: string[] = [];
  let i = 0;
  for (const t of findTemplates(op.path)) {
    const start = head.length + t.start;
    for (; i < start; i++) push(path[i], kinds[i]);
    const raw = own(values.path, t.name);
    const value = isBlank(raw) ? '' : raw!;
    const param = op.params.find((p) => p.in === 'path' && p.name === t.name);
    if (value === '' && (!param || param.required)) {
      missing.push(t.name);
      push(op.path.slice(t.start, t.end), 'param');
    } else {
      push(encodePath(value, spansSegments(t.regex)), 'value');
    }
    i = head.length + t.end;
  }
  for (; i < path.length; i++) push(path[i], kinds[i]);

  const matrixNames = declared(op, 'matrix');
  for (const [name, value] of Object.entries(values.matrix)) {
    if (!matrixNames.has(name) || isBlank(value)) continue;
    push(';', 'qsep');
    push(encodeURIComponent(name), 'mname');
    push('=', 'qsep');
    push(encodeURIComponent(value), 'mvalue');
  }
  const queryNames = declared(op, 'query');
  let first = true;
  for (const [name, list] of Object.entries(values.query)) {
    if (!queryNames.has(name) || !Array.isArray(list)) continue;
    for (const value of list) {
      if (isBlank(value)) continue;
      push(first ? '?' : '&', 'qsep');
      push(encodeURIComponent(name), 'qname');
      push('=', 'qsep');
      push(encodeURIComponent(value), 'qvalue');
      first = false;
    }
  }
  const error = module ? undefined : `The catalog has no module ${op.module} right now (it may be being rebuilt): try again in a moment`;
  return error ? { parts, missing, error } : { parts, missing };
}

export function buildRequest(summary: Summary, op: Operation, values: RequestValues, options: RequestOptions = {}): BuiltRequest {
  const method = op.method.toUpperCase();
  const { parts, missing, error } = urlParts(summary, op, values);
  if (error) throw new Error(error);
  if (missing.length) throw new Error(`Missing required path parameter: ${missing[0]}`);
  const url = parts.map((p) => p.text).join('');

  // the declared headers that are filled in (names compare case-insensitively)
  const headerNames = new Set([...declared(op, 'header')].map((n) => n.toLowerCase()));
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(values.header)) {
    if (headerNames.has(name.toLowerCase()) && !isBlank(value)) headers[name] = value;
  }
  // then the usual ones, unless the user filled in a declared header of the same name: what was typed wins
  if (!hasHeader(headers, 'Accept')) setHeader(headers, 'Accept', options.accept ?? values.accept ?? defaultType(op.produces));

  const req: BuiltRequest = { method, url, headers };
  const bodyAllowed = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  if (bodyAllowed && values.body !== undefined && values.body !== '') {
    req.body = values.body;
    if (!hasHeader(headers, 'Content-Type')) setHeader(headers, 'Content-Type', values.contentType ?? defaultType(op.consumes));
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !options.noXsrfHeader && !hasHeader(headers, 'X-Atlassian-Token')) {
    setHeader(headers, 'X-Atlassian-Token', 'no-check');
  }
  return req;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The request as a curl command. HEAD is -I (with -X HEAD curl waits for a body that never comes); the credentials
 * are placeholders, unless the request has an Authorization header of its own.
 */
export function toCurl(req: BuiltRequest): string {
  const parts = ['curl'];
  if (req.method === 'HEAD') parts.push('-I');
  else if (req.method !== 'GET') parts.push('-X', req.method);
  if (!hasHeader(req.headers, 'Authorization')) parts.push('-u', '"$USER:$PASSWORD"');
  for (const [name, value] of Object.entries(req.headers)) parts.push('-H', quote(`${name}: ${value}`));
  if (req.body !== undefined) parts.push('--data-raw', quote(req.body));
  parts.push(quote(req.url));
  return parts.join(' ');
}
