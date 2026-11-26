import type { TokenKind } from './javatokens';

/** Declaration role for syntax highlighting (bold class/interface/enum/record and method/constructor names). */
export type DeclKind = 'type' | 'method';

/** A token of decompiled Java source, optionally linked to a decompilable Java class. */
export type SourceSpan =
  | { text: string; kind: TokenKind; decl?: DeclKind; target?: undefined; candidates?: undefined }
  | { text: string; kind: 'type' | 'ann'; decl?: DeclKind; target: string; candidates: string[] };

export interface TypePart {
  text: string;
  fqcn?: string;
}

const PRIMITIVES = new Set(['void', 'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double']);

export function packageOf(fqcn: string): string {
  const dot = fqcn.lastIndexOf('.');
  return dot > 0 ? fqcn.slice(0, dot) : '';
}

export function simpleName(fqcn: string): string {
  const sep = Math.max(fqcn.lastIndexOf('.'), fqcn.lastIndexOf('$'));
  return sep >= 0 ? fqcn.slice(sep + 1) : fqcn;
}

/** Short display label for a class tab: "ServerInfoBean" or "Response.Status" for nested classes. */
export function classLabel(fqcn: string): string {
  const dot = fqcn.lastIndexOf('.');
  const tail = dot >= 0 ? fqcn.slice(dot + 1) : fqcn;
  return tail.replace(/\$/g, '.');
}

/**
 * Strips package prefixes outside quoted strings and char literals (linearly, preserving clipped strings).
 */
export function shortJava(s: string): string {
  const shortenCode = (part: string) =>
    part.replace(/\b(?:[a-z_][\w]*\.)+(?=[A-Z_$])/g, '').replace(/(\w)\$(?=[A-Z])/g, '$1.');
  let out = '';
  let buf = '';
  let quote: '"' | '\'' | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < s.length) out += s[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      if (buf) {
        out += shortenCode(buf);
        buf = '';
      }
      quote = ch;
      out += ch;
      continue;
    }
    buf += ch;
  }
  return out + (buf ? shortenCode(buf) : '');
}

/** Splits a generic Java type expression into display fragments carrying optional resolved FQCNs. */
export function parseJavaTypeParts(typeExpr: string, showFull = false): TypePart[] {
  if (!typeExpr) return [];
  const out: TypePart[] = [];
  const re = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)|([^A-Za-z_$]+)/g;
  for (const m of typeExpr.matchAll(re)) {
    const [, ident, other] = m;
    if (other !== undefined) {
      out.push({ text: other });
      continue;
    }
    if (PRIMITIVES.has(ident) || ident === 'extends' || ident === 'super') {
      out.push({ text: ident });
      continue;
    }
    if (ident.length === 1 && !ident.includes('.')) {
      out.push({ text: ident });
      continue;
    }
    const display = showFull ? ident.replace(/\$/g, '.') : classLabel(ident);
    out.push({ text: display, fqcn: ident });
  }
  return out;
}
