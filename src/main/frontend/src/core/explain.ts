/**
 * Plain-language explanations of the codes the new UI shows: the reason a module of the catalog could not be read,
 * and a response's HTTP status, with what to try in this browser. For the rich tooltips and the hover card.
 */
import type { Module } from './types';

/** How a module that could not be read is shown: waiting to start, left out on purpose, or failed. */
export type ReasonKind = 'waiting' | 'skipped' | 'failed';

export interface ReasonInfo {
  /** The reason code, "error" when the server sent none. */
  code: string;
  kind: ReasonKind;
  /** What it means and what to do, for the hover card. */
  text: string;
  /** Optional row override when a reason within a kind has its own short wording. */
  row?: string;
  /** Optional hover-card header override. */
  card?: string;
}

/** What the list's row and the hover card say of each kind (a failure adds its code to the row). */
export const KIND_TEXT: Record<ReasonKind, { row: string; card: string }> = {
  waiting: { row: 'not started', card: 'Not started yet on this node' },
  skipped: { row: 'not described', card: 'Not described (left out on purpose)' },
  failed: { row: 'failed', card: 'Could not be described' },
};

const known = (code: string, kind: ReasonKind, text: string, row?: string, card?: string): ReasonInfo =>
  Object.freeze({ code, kind, text, ...(row ? { row } : {}), ...(card ? { card } : {}) });

const REASONS: Record<string, ReasonInfo> = Object.fromEntries([
  known('not-started', 'waiting',
    'Some products (Confluence) start a module\'s REST API on the first request to it, on each node of a cluster; '
    + 'until then its operations cannot be read. Select the module to start it: the browser sends one OPTIONS request to a path the '
    + 'module does not have, which starts it on this node, and the catalog reads it again. A few modules start only '
    + 'for their own kind of login (OAuth tokens): those stay not started.'),
  known('not-startable', 'skipped',
    'This module did not start on a normal browser request; some modules (such as OAuth token endpoints) start only '
    + 'for their own kind of login. It is checked again on the next catalog rebuild.',
    'needs its own login',
    'Needs its own login (did not start)'),
  known('excluded', 'skipped',
    'Left out on purpose: an API for other applications, which log in with Crowd application credentials, not for users.'),
  known('rest-v1', 'skipped',
    'A REST v1 module (Jersey 1). The new UI reads the REST v2 modules of the product\'s runtime; the classic page '
    + 'lists REST v1 modules from their WADL.'),
  known('no-source', 'failed', 'No source could describe this REST v2 module: its Jersey model was not found.'),
  known('timeout', 'failed',
    'Reading the module took longer than 30 seconds; it is read again on the next rebuild of the catalog.'),
  known('busy', 'failed',
    'An earlier attempt to read the module is still running; the next rebuild after it ends reads it again.'),
  known('interrupted', 'failed', 'The catalog\'s build was stopped before this module was read; a rebuild reads it.'),
  known('container-unavailable', 'failed',
    'The module\'s Jersey container could not be reached: the product may have changed how REST modules run.'),
  known('model-unavailable', 'failed', 'The module started, but its Jersey resource model could not be read.'),
  known('error', 'failed', 'Reading the module failed; administrators see the error below.'),
].map((r) => [r.code, r]));

/** The kind and explanation of a module's failure reason; an unknown reason is a failure with its code. */
export function reasonInfo(reason: string | undefined): ReasonInfo {
  const code = reason || 'error';
  return Object.hasOwn(REASONS, code) ? REASONS[code] : { code, kind: 'failed', text: `The module could not be read (${code}).` };
}

/** Why a module could not be read; null for a module that was read or is being read. */
export const moduleReason = (m: Module): ReasonInfo | null => (m.state === 'failed' ? reasonInfo(m.reason) : null);

/** A module whose REST API has not started yet on this node (Confluence starts one on the first request to it). */
export const isWaiting = (m: Module) => moduleReason(m)?.kind === 'waiting';

/** The list row's short text: "not started", "not described", "needs its own login", "failed: timeout". */
export const rowLabel = (r: ReasonInfo) => r.row ?? (r.kind === 'failed' ? `failed: ${r.code}` : KIND_TEXT[r.kind].row);

/** The hover card's short status text for a reason. */
export const cardLabel = (r: ReasonInfo) => r.card ?? KIND_TEXT[r.kind].card;

export interface StatusInfo {
  /** "Not Found"; empty for a code this browser does not know and the server gave no text for. */
  title: string;
  /** What it means here, and what to try. */
  text: string;
}

/** The colour of a status: ok, info (redirects, no answer), warn (refused), err (failed). */
export const statusTone = (s: number | undefined) => (!s || s < 200 ? 'info' : s >= 500 ? 'err' : s >= 400 ? 'warn' : s >= 300 ? 'info' : 'ok');

const REDIRECT = 'A redirect that the browser could not follow by itself (it follows the others): the Location response '
  + 'header, if any, says where.';

const STATUS: Record<number, StatusInfo> = {
  200: { title: 'OK', text: 'The request worked; the body is the answer.' },
  201: { title: 'Created', text: 'The item was created; the Location response header usually names it.' },
  202: { title: 'Accepted', text: 'The server took the request and finishes it later.' },
  204: { title: 'No Content', text: 'The request worked and there is no body to show.' },
  301: { title: 'Moved Permanently', text: REDIRECT },
  302: { title: 'Found', text: REDIRECT },
  303: { title: 'See Other', text: REDIRECT },
  304: {
    title: 'Not Modified',
    text: 'Nothing changed since the version the request named (If-None-Match or If-Modified-Since).',
  },
  307: { title: 'Temporary Redirect', text: REDIRECT },
  308: { title: 'Permanent Redirect', text: REDIRECT },
  400: {
    title: 'Bad Request',
    text: 'The server could not use the request: a parameter or the body is missing or has the wrong form. The body '
      + 'of the answer often says which.',
  },
  401: {
    title: 'Unauthorized',
    text: 'Not logged in: the session expired (reload the page to log in again), credentials sent in an Authorization '
      + 'header were rejected, or the resource takes only its own kind of login (OAuth tokens, for example).',
  },
  403: {
    title: 'Forbidden',
    text: 'Logged in, but not allowed: the operation needs a permission you do not have (its access is in the list\'s '
      + 'hover card), a secure administrator session, or, for a write, the header X-Atlassian-Token: no-check, '
      + 'which is sent unless it was switched off in the Headers tab.',
  },
  404: {
    title: 'Not Found',
    text: 'No such item (an id or key that does not exist) or no such resource on this instance. Some products also '
      + 'answer 404 for an item you may not see, so as not to tell that it exists.',
  },
  405: { title: 'Method Not Allowed', text: 'The resource exists, but not with this method.' },
  406: { title: 'Not Acceptable', text: 'The resource cannot answer in the Accept type chosen in the Headers tab.' },
  409: { title: 'Conflict', text: 'The item changed meanwhile or already exists.' },
  413: { title: 'Payload Too Large', text: 'The body is larger than the server accepts.' },
  415: {
    title: 'Unsupported Media Type',
    text: 'The resource does not read the body\'s Content-Type: choose another in the Body tab.',
  },
  422: { title: 'Unprocessable Content', text: 'The body has the right form, but its values are not valid.' },
  429: {
    title: 'Too Many Requests',
    text: 'The product\'s rate limiting: wait and send again (the Retry-After header says how long).',
  },
  500: {
    title: 'Internal Server Error',
    text: 'The request failed inside the product; its log has the error. Often a bug, or a value it did not expect.',
  },
  502: { title: 'Bad Gateway', text: 'A proxy in front of the product got no valid answer from it.' },
  503: { title: 'Service Unavailable', text: 'The product or a node is starting, busy or in maintenance: try again later.' },
  504: { title: 'Gateway Timeout', text: 'A proxy in front of the product waited too long for it.' },
};

/** What an HTTP status means, from the code itself or, for an unknown code, from its class. */
export function statusInfo(status: number, statusText = ''): StatusInfo {
  if (Object.hasOwn(STATUS, status)) return STATUS[status];
  const title = statusText;
  if (status >= 100 && status < 200) return { title, text: 'An interim answer, not the final one.' };
  if (status >= 200 && status < 300) return { title, text: 'A success: the request worked.' };
  if (status >= 300 && status < 400) return { title, text: REDIRECT };
  if (status >= 400 && status < 500) return { title, text: 'The request was refused: something in it is wrong or not allowed.' };
  if (status >= 500) return { title, text: 'The product failed to answer; its log has the details.' };
  return { title, text: 'No answer was received.' };
}
