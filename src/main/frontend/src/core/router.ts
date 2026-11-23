export interface RouteState {
  op?: string;
  path: Record<string, string>;
  q: Record<string, string[]>;
  h: Record<string, string>;
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

export function parseState(search: string): RouteState {
  const state: RouteState = { path: dict(), q: dict(), h: dict() };
  for (const pair of search.replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = decode(eq < 0 ? pair : pair.slice(0, eq));
    const value = eq < 0 ? '' : decode(pair.slice(eq + 1));
    if (key === 'op') state.op = value;
    else if (key.startsWith('path.')) state.path[key.slice(5)] = value;
    else if (key.startsWith('q.')) (state.q[key.slice(2)] ??= []).push(value);
    else if (key.startsWith('h.')) state.h[key.slice(2)] = value;
  }
  return state;
}

export function formatState(state: RouteState): string {
  const e = encodeURIComponent;
  const parts: string[] = [];
  if (state.op !== undefined) parts.push(`op=${e(state.op)}`);
  for (const [k, v] of Object.entries(state.path)) parts.push(`${e('path.' + k)}=${e(v)}`);
  for (const [k, list] of Object.entries(state.q)) for (const v of list) parts.push(`${e('q.' + k)}=${e(v)}`);
  for (const [k, v] of Object.entries(state.h)) parts.push(`${e('h.' + k)}=${e(v)}`);
  return parts.length ? '?' + parts.join('&') : '';
}
