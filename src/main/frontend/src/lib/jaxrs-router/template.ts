// Path templates as written in JAX-RS: "issue/{key}", "file/{path: .+}", "x/{id: [0-9]{3}}".

export interface TemplateMatch {
  start: number;
  end: number;
  name: string;
  regex?: string;
}

// Removes negated character classes `[^...]` linearly, handling `\\` escapes and leading `]` inside `[^]...]`,
// while leaving positive `[a-z/]` classes intact because `/` in `[a-z/]` genuinely matches slashes.
function stripNegatedClasses(regex: string): string {
  let out = '';
  for (let i = 0; i < regex.length; ) {
    const ch = regex[i];
    if (ch === '\\') {
      out += regex.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '[' && regex[i + 1] === '^') {
      let j = i + 2;
      if (j < regex.length && regex[j] === ']') j++;
      while (j < regex.length) {
        if (regex[j] === '\\') j += 2;
        else if (regex[j] === ']') {
          j++;
          break;
        } else j++;
      }
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Whether a template's regex lets its value span segments: ".*", ".+" or a "/" outside a [^...] class. Such a value
 * keeps its slashes in a URL, and matches the rest of a path.
 */
export const spansSegments = (regex: string | undefined): boolean =>
  /\.\*|\.\+|\//.test(stripNegatedClasses(regex ?? ''));

/** A module's path without slashes at its ends: "/api/2/" is "api/2". */
export const trimModulePath = (path: string): string => path.replace(/^\/+|\/+$/g, '');

/** An operation's path without a slash at its start: "/issue" is "issue". */
export const trimOpPath = (path: string): string => path.replace(/^\/+/, '');

/** The path below "/rest/": the module's and the operation's joined by one slash, none after an operation on the root. */
export function joinPaths(modulePath: string, opPath: string): string {
  const m = trimModulePath(modulePath);
  const o = trimOpPath(opPath);
  return m && o ? m + '/' + o : m || o;
}

/**
 * Linear single-pass balanced-brace JAX-RS template scanner ( immune to ReDoS on malformed inputs and supports
 * arbitrarily nested regex quantifiers like `{id: [0-9]{1,3}}`).
 */
export function findTemplates(path: string): TemplateMatch[] {
  const out: TemplateMatch[] = [];
  const n = path.length;
  // Single O(n) pre-pass maps each balanced '{' to its matching '}' so malformed `{a:{a:...` stays strictly O(n).
  const matchClose = new Map<number, number>();
  const stack: number[] = [];
  for (let k = 0; k < n; k++) {
    const ch = path[k];
    if (stack.length > 0 && ch === '\\' && k + 1 < n) {
      k++;
      continue;
    }
    if (ch === '{') stack.push(k);
    else if (ch === '}' && stack.length > 0) matchClose.set(stack.pop()!, k);
  }
  for (let i = 0; i < n; ) {
    if (path[i] !== '{') {
      i++;
      continue;
    }
    const start = i;
    let p = i + 1;
    while (p < n && /\s/.test(path[p])) p++;
    const nameStart = p;
    while (p < n && path[p] !== ':' && path[p] !== '{' && path[p] !== '}' && !/\s/.test(path[p])) p++;
    const name = path.slice(nameStart, p);
    if (!name) {
      i++;
      continue;
    }
    while (p < n && /\s/.test(path[p])) p++;
    let regex: string | undefined;
    let close = -1;
    if (path[p] === ':') {
      close = matchClose.get(start) ?? -1;
      if (close < 0) {
        i++;
        continue;
      }
      regex = path.slice(p + 1, close).trim() || undefined;
    } else if (path[p] === '}') {
      close = p;
    } else {
      i++;
      continue;
    }
    const end = close + 1;
    out.push({ start, end, name, regex });
    i = end;
  }
  return out;
}

/** Split on "/" outside braces, because a JAX-RS template regex may contain slashes. */
export function splitSegments(path: string): string[] {
  if (path === '') return [];
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
    if (depth > 0 && c === '\\' && i + 1 < path.length) {
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === '/' && depth === 0) {
      out.push(path.slice(start, i));
      start = i + 1;
    }
  }
  out.push(path.slice(start));
  return out;
}
