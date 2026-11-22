// Path templates as written in JAX-RS: "issue/{key}", "file/{path: .+}", "x/{id: [0-9]{3}}".

export interface TemplateMatch {
  start: number;
  end: number;
  name: string;
  regex?: string;
}

// A fresh RegExp each call: a shared global one would carry lastIndex between users.
function templateRegExp(): RegExp {
  return /\{\s*([^:{}\s]+)\s*(?::\s*((?:[^{}]|\{[^{}]*\})*?))?\s*\}/g;
}

export function findTemplates(path: string): TemplateMatch[] {
  const out: TemplateMatch[] = [];
  for (const m of path.matchAll(templateRegExp())) {
    out.push({ start: m.index, end: m.index + m[0].length, name: m[1], regex: m[2]?.trim() || undefined });
  }
  return out;
}

// Split on "/" but not inside braces, because a regex may contain one.
export function splitSegments(path: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < path.length; i++) {
    const c = path[i];
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
