import { isCredentialHeader } from '../lib/http-redact/redact';
import type { Draft } from './operationform';
import type { RouteState } from './router';
import { findTemplates } from '../lib/jaxrs-router';
import type { Operation } from './types';

export const REPO = 'https://github.com/rdk/rest-api-browser';

/** The body of a new GitHub issue: the questions, and the versions that help to reproduce it. */
export function issueBody(version: string, product: string): string {
  return [
    '**What happened?**', '', '', '**What did you expect?**', '', '', '**Steps to reproduce**', '', '', '---',
    `REST API Browser ${version || '(version unknown)'}, new UI, on ${product || '(product unknown)'}`,
  ].join('\n');
}

/**
 * Values from a deep link fill the form; they are never sent by themselves. Only parameters the operation declares
 * are taken, so a link cannot add anything the form does not show; other headers go to the visible custom headers,
 * and credential headers are dropped.
 */
export function prefill(op: Operation, draft: Draft, state: RouteState): Draft {
  if (state.op !== op.key) return draft;
  const declared = (where: string) => new Set(op.params.filter((p) => p.in === where).map((p) => p.name));
  const pathNames = new Set([...declared('path'), ...findTemplates(op.path).map((t) => t.name)]);
  const queryNames = declared('query');
  const formNames = declared('form');
  // Header names compare case-insensitively; a declared header keeps the operation's spelling.
  const headerNames = new Map(op.params.filter((p) => p.in === 'header').map((p) => [p.name.toLowerCase(), p.name]));
  const path = Object.fromEntries(Object.entries(state.path).filter(([k]) => pathNames.has(k)));
  const query = Object.fromEntries(Object.entries(state.q).filter(([k]) => queryNames.has(k)));
  const form = Object.fromEntries(Object.entries(state.form ?? {}).filter(([k]) => formNames.has(k)));
  const header: Record<string, string> = {};
  const custom: { name: string; value: string }[] = [];
  for (const [raw, value] of Object.entries(state.h)) {
    const name = raw.trim();
    if (!name || isCredentialHeader(name)) continue; // never from a link, declared or not
    const declaredName = headerNames.get(name.toLowerCase());
    if (declaredName) header[declaredName] = value;
    else custom.push({ name, value });
  }
  return {
    ...draft,
    values: {
      ...draft.values,
      path,
      query: { ...draft.values.query, ...query },
      form: { ...(draft.values.form ?? {}), ...form },
      header,
    },
    custom,
  };
}
