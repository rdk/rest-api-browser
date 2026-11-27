export interface RouteState {
  op?: string;
  path: Record<string, string>;
  q: Record<string, string[]>;
  h: Record<string, string>;
  form?: Record<string, string[]>;
  className?: string;
  method?: string;
  line?: number;
  fromBundle?: number;
  supportedOnly?: boolean;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

// The names come from the URL, so the maps have no prototype: "constructor" or "__proto__" is a name like any other.
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

function positiveInt(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : undefined;
}

function nonNegativeInt(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

export function parseState(search: string): RouteState {
  const state: RouteState = { path: dict(), q: dict(), h: dict() };
  for (const pair of search.replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = decode(eq < 0 ? pair : pair.slice(0, eq));
    const value = eq < 0 ? '' : decode(pair.slice(eq + 1));
    if (key === 'op') state.op = value;
    else if (key === 'class' && value.trim()) state.className = value.trim();
    else if (key === 'method' && value.trim()) state.method = value.trim();
    else if (key === 'line') {
      const n = positiveInt(value);
      if (n !== undefined) state.line = n;
    } else if (key === 'fromBundle') {
      const n = nonNegativeInt(value);
      if (n !== undefined) state.fromBundle = n;
    } else if (key === 'supportedOnly') {
      if (value === '1' || value === 'true') state.supportedOnly = true;
      else if (value === '0' || value === 'false') state.supportedOnly = false;
    } else if (key.startsWith('path.')) state.path[key.slice(5)] = value;
    else if (key.startsWith('q.')) (state.q[key.slice(2)] ??= []).push(value);
    else if (key.startsWith('h.')) state.h[key.slice(2)] = value;
    else if (key.startsWith('form.')) {
      state.form ??= dict();
      (state.form[key.slice(5)] ??= []).push(value);
    }
  }
  return state;
}

export function formatState(state: RouteState): string {
  const e = encodeURIComponent;
  const parts: string[] = [];
  if (state.op !== undefined) parts.push(`op=${e(state.op)}`);
  if (state.className) parts.push(`class=${e(state.className)}`);
  if (state.method) parts.push(`method=${e(state.method)}`);
  if (state.line !== undefined) parts.push(`line=${e(String(state.line))}`);
  if (state.fromBundle !== undefined) parts.push(`fromBundle=${e(String(state.fromBundle))}`);
  if (state.supportedOnly !== undefined) parts.push(`supportedOnly=${state.supportedOnly ? '1' : '0'}`);
  for (const [k, v] of Object.entries(state.path)) parts.push(`${e('path.' + k)}=${e(v)}`);
  for (const [k, list] of Object.entries(state.q)) for (const v of list) parts.push(`${e('q.' + k)}=${e(v)}`);
  for (const [k, v] of Object.entries(state.h)) parts.push(`${e('h.' + k)}=${e(v)}`);
  for (const [k, list] of Object.entries(state.form ?? {})) for (const v of list) parts.push(`${e('form.' + k)}=${e(v)}`);
  return parts.length ? '?' + parts.join('&') : '';
}
