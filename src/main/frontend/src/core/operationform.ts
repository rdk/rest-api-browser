import type { FormHistory } from './formhistory';
import { buildRequest, mediaChoices, setHeader, urlParts, type BuiltRequest, type RequestValues, type UrlPart } from './request';
import { findTemplates } from '../lib/jaxrs-router';
import type { RunResult } from './responsetext';
import type { Operation, Param, Summary } from './types';
import { checkValue, type Check } from './validate';

/** What the user has typed for one operation; kept per operation while the page is open. */
export interface Draft {
  values: RequestValues;
  custom: { name: string; value: string }[];
  noXsrfHeader: boolean;
  result: RunResult | null;
  /** The form's undo and redo steps. */
  history?: FormHistory;
}

export function emptyDraft(op: Operation): Draft {
  const query: Record<string, string[]> = {};
  const form: Record<string, string[]> = {};
  for (const p of op.params) {
    if (p.in === 'query') query[p.name] = [''];
    else if (p.in === 'form' && p.type !== 'File') form[p.name] = [''];
  }
  return {
    values: {
      path: {}, query, header: {}, matrix: {}, form, files: {},
      contentType: mediaChoices(op.consumes)[0], accept: mediaChoices(op.produces)[0],
    },
    custom: [],
    noXsrfHeader: false,
    result: null,
  };
}

/** The operation's parameters, plus a required path parameter for any template no parameter declares. */
export function withTemplateParams(op: Operation): Param[] {
  const declared = new Set(op.params.filter((p) => p.in === 'path').map((p) => p.name));
  const missing = [...new Set(findTemplates(op.path).map((t) => t.name))]
    .filter((name) => !declared.has(name))
    .map((name): Param => ({ name, in: 'path', type: 'string', required: true }));
  return missing.length ? [...op.params, ...missing] : op.params;
}

/** The template's regex applies to the path parameter of that name only, not to a query or header one. */
export const regexOf = (p: Param, regexes: Record<string, string>): string | undefined =>
  p.in === 'path' && Object.hasOwn(regexes, p.name) ? regexes[p.name] : undefined;

/** The regex of each path template that has one: "{mode: view|edit}". */
export function templateRegexes(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of findTemplates(path)) if (t.regex) out[t.name] = t.regex;
  return out;
}

/** A parameter's values as the form shows them: a query or form parameter's list (at least one field), else its one value. */
export function valuesOf(p: Param, values: RequestValues): string[] {
  const map = (values as unknown as Record<string, Record<string, unknown> | undefined>)[p.in];
  const v = map && Object.hasOwn(map, p.name) ? map[p.name] : undefined;
  if (p.in === 'query' || p.in === 'form') return Array.isArray(v) && v.length ? (v as string[]) : [''];
  return [typeof v === 'string' ? v : ''];
}

/** The check of one of a parameter's values; an empty extra value of a repeating one is fine. */
export function checkAt(p: Param, v: string, i: number, all: string[], regex?: string): Check {
  if (!v.trim() && (i > 0 || all.some((x) => x.trim()))) return null;
  return checkValue(p, v, regex);
}

/** Counts parameter values that currently show a validation warning (missing required or invalid syntax/range). */
export function countFormWarnings(visibleParams: Param[], values: RequestValues, regexes: Record<string, string>): number {
  return visibleParams.reduce((n, p) => {
    if (p.in === 'form' && p.type === 'File') {
      const hasFiles = !!values.files && Object.hasOwn(values.files, p.name) && (values.files[p.name]?.length ?? 0) > 0;
      const hasText = valuesOf(p, values).some((v) => v.trim());
      return n + (p.required && !hasFiles && !hasText ? 1 : 0);
    }
    return n + valuesOf(p, values).filter((v, i, all) => checkAt(p, v, i, all, regexOf(p, regexes))?.state === 'warn').length;
  }, 0);
}

export function tryBuild(summary: Summary, op: Operation, draft: Draft): {
  request?: BuiltRequest; url: string; parts: UrlPart[]; error?: string;
} {
  // Include URL parts even when a required path param is missing so the URL bar stays informative.
  const { parts } = urlParts(summary, op, draft.values);
  const url = parts.map((p) => p.text).join('');
  try {
    const req = buildRequest(summary, op, draft.values, { accept: draft.values.accept, noXsrfHeader: draft.noXsrfHeader });
    for (const h of draft.custom) if (h.name.trim()) setHeader(req.headers, h.name.trim(), h.value);
    return { request: req, url: req.url, parts };
  } catch (e) {
    return { url, parts, error: e instanceof Error ? e.message : String(e) };
  }
}
