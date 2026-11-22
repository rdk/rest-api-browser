import type { Module, Operation } from '../core/types';

/**
 * What the list shows as small color ticks and the hover card spells out: one place, so the ticks, their colors
 * and the words always agree.
 */
export type Tone = 'supported' | 'app' | 'bundled' | 'deprecated' | 'open' | 'unlicensed' | 'licensed' | 'admin' | 'sysadmin';
export interface Fact { tone: Tone; label: string; detail?: string; }

const ACCESS: Record<string, Omit<Fact, 'detail'> & { detail: string }> = {
  unrestrictedaccess: { tone: 'open', label: 'UnrestrictedAccess', detail: 'Anyone, no checks' },
  anonymoussiteaccess: { tone: 'open', label: 'AnonymousSiteAccess', detail: 'Anyone, when the site allows anonymous access' },
  anonymousallowed: { tone: 'open', label: 'AnonymousAllowed', detail: 'Anonymous users allowed' },
  unlicensedsiteaccess: { tone: 'unlicensed', label: 'UnlicensedSiteAccess', detail: 'Logged-in users, also without a license' },
  licensedonly: { tone: 'licensed', label: 'LicensedOnly', detail: 'Licensed users' },
  adminonly: { tone: 'admin', label: 'AdminOnly', detail: 'Administrators only' },
  systemadminonly: { tone: 'sysadmin', label: 'SystemAdminOnly', detail: 'System administrators only' },
};

/** The access annotation, explained; LicensedOnly is the default of REST v2, so it gets no tick. */
export function accessFact(access: string | undefined): Fact | undefined {
  if (!access) return undefined;
  const known = ACCESS[access.toLowerCase()];
  if (!known) return { tone: 'licensed', label: access };
  return known;
}

/** The module's kind: supported product API, app, bundled app; the product's internal APIs have none. */
export function moduleFact(m: Module): Fact | undefined {
  if (m.stability === 'supported') return { tone: 'supported', label: 'Supported', detail: 'Public API of the product' };
  if (m.stability === 'app' || m.origin === 'user') return { tone: 'app', label: 'App', detail: 'From an installed app' };
  if (m.origin === 'bundled') return { tone: 'bundled', label: 'Bundled', detail: 'From an app bundled with the product' };
  return undefined;
}

/** The ticks of a list row: the module's kind (only where no module header shows it), deprecation, access. */
export function rowTicks(op: Operation, m: Module | undefined, withModule: boolean): Fact[] {
  const out: Fact[] = [];
  const kind = withModule && m ? moduleFact(m) : undefined;
  if (kind) out.push(kind);
  if (op.deprecated) out.push({ tone: 'deprecated', label: 'Deprecated' });
  const access = accessFact(op.access);
  if (access && access.tone !== 'licensed') out.push(access);
  return out;
}

export function originLabel(m: Module): string {
  return m.origin === 'product' ? 'The product' : m.origin === 'bundled' ? 'App bundled with the product' : 'Installed app';
}

export function stabilityLabel(m: Module): string {
  return m.stability === 'supported' ? 'Supported public API' : m.stability === 'app' ? 'App API' : 'Internal API, may change';
}

export function sourceLabel(source: string | undefined): string | undefined {
  if (!source) return undefined;
  return source === 'jersey' ? 'Jersey runtime model' : source === 'wadl' ? 'WADL' : source;
}

/** "2 path, 1 query" */
export function paramSummary(op: Operation): string {
  const counts = new Map<string, number>();
  for (const p of op.params) counts.set(p.in, (counts.get(p.in) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${n} ${k}`).join(', ');
}
