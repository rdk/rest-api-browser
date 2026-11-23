/**
 * Plain-language explanations of the codes the new UI shows: the reason a module of the catalog could not be read,
 * and a response's HTTP status, with what to try in this browser. For the rich tooltips and the hover card.
 */

/** How a module that could not be read is shown: waiting to start, left out on purpose, or failed. */
export type ReasonKind = 'waiting' | 'skipped' | 'failed';

export interface ReasonInfo {
  /** Short, for the list's row: "not started", "not described", "failed: timeout". */
  label: string;
  /** What it means and what to do, for the tooltip and the hover card. */
  text: string;
  kind: ReasonKind;
}

const REASONS: Record<string, Omit<ReasonInfo, 'label'> & { label?: string }> = {
  'not-started': {
    kind: 'waiting',
    label: 'not started',
    text: 'The product starts this module\'s REST API on its first request, on each node of a cluster (Confluence '
      + 'does). Until then its operations cannot be read. Click the module to start it: the browser sends one GET to '
      + 'a path the module does not have (it answers 404, nothing of it runs), then the catalog reads the module again. '
      + 'A few modules start only for their own kind of login (OAuth tokens): those stay not started.',
  },
  excluded: {
    kind: 'skipped',
    label: 'not described',
    text: 'Left out on purpose: an API for other applications, which log in with Crowd application credentials, '
      + 'not for users.',
  },
  'rest-v1': {
    kind: 'skipped',
    label: 'not described',
    text: 'A REST v1 module (Jersey 1). The new UI reads the REST v2 modules of the product\'s runtime; the '
      + 'classic page lists REST v1 modules from their WADL.',
  },
  'no-source': {
    kind: 'failed',
    text: 'No source could describe this REST v2 module: its Jersey model was not found.',
  },
  timeout: {
    kind: 'failed',
    text: 'Reading the module took longer than 30 seconds; it is read again on the next rebuild of the catalog.',
  },
  busy: {
    kind: 'failed',
    text: 'An earlier attempt to read the module is still running; it is read again once that ends.',
  },
  interrupted: {
    kind: 'failed',
    text: 'The catalog\'s build was stopped before this module was read; a rebuild reads it.',
  },
  'container-unavailable': {
    kind: 'failed',
    text: 'The module\'s Jersey container could not be reached: the product may have changed how REST modules run.',
  },
  'model-unavailable': {
    kind: 'failed',
    text: 'The module started, but its Jersey resource model could not be read.',
  },
  error: {
    kind: 'failed',
    text: 'Reading the module failed; the error is in the details below (system administrators see them).',
  },
};

/** The label, explanation and kind of a module's failure reason; an unknown reason is a failure with its code. */
export function reasonInfo(reason: string | undefined): ReasonInfo {
  const code = reason || 'error';
  const known = Object.hasOwn(REASONS, code) ? REASONS[code] : undefined;
  if (!known) {
    return { kind: 'failed', label: 'failed: ' + code, text: `The module could not be read (${code}).` };
  }
  return { kind: known.kind, label: known.label ?? 'failed: ' + code, text: known.text };
}

export interface StatusInfo {
  /** "Not Found", when the code is known. */
  title: string;
  /** What it means here, and what to try. */
  text: string;
}

const STATUS: Record<number, StatusInfo> = {
  200: { title: 'OK', text: 'The request worked; the body is the answer.' },
  201: { title: 'Created', text: 'The item was created; the Location response header usually names it.' },
  202: { title: 'Accepted', text: 'The server took the request and finishes it later.' },
  204: { title: 'No Content', text: 'The request worked and there is no body to show.' },
  301: { title: 'Moved Permanently', text: 'A redirect the browser did not follow; the Location response header says where.' },
  302: { title: 'Found', text: 'A redirect the browser did not follow; the Location response header says where.' },
  304: { title: 'Not Modified', text: 'Nothing changed since the version the request named (If-None-Match).' },
  400: {
    title: 'Bad Request',
    text: 'The server could not use the request: a parameter or the body is missing or has the wrong form. The body '
      + 'of the answer often says which.',
  },
  401: {
    title: 'Unauthorized',
    text: 'Not logged in: the session expired, or credentials sent in an Authorization header were rejected. Reload '
      + 'the page to log in again.',
  },
  403: {
    title: 'Forbidden',
    text: 'Logged in, but not allowed: the operation needs a permission you do not have (see its access mark), a '
      + 'secure administrator session, or, for a write, the XSRF header X-Atlassian-Token: no-check (Headers tab).',
  },
  404: {
    title: 'Not Found',
    text: 'No such item (an id or key that does not exist), or no such resource on this instance.',
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
  const title = statusText || 'HTTP ' + status;
  if (status >= 200 && status < 300) return { title, text: 'A success: the request worked.' };
  if (status >= 300 && status < 400) return { title, text: 'A redirect the browser did not follow.' };
  if (status >= 400 && status < 500) return { title, text: 'The request was refused: something in it is wrong or not allowed.' };
  if (status >= 500) return { title, text: 'The product failed to answer; its log has the details.' };
  return { title, text: 'No answer was received.' };
}
