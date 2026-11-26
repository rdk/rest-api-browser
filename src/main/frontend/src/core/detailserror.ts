import { DetailsError } from './details';

/** Formats a server details/decompiler failure into a plain-language message for the user. */
export function describeDetailsError(e: unknown, target: 'details' | 'source' = 'details'): string {
  if (e instanceof DetailsError) {
    if (e.status === 403 && e.reason === 'decompile-disabled') {
      return 'Decompiling is disabled on this instance (-Drest.api.browser.decompile=false).';
    }
    if (e.status === 403) {
      return target === 'source'
        ? 'Only system administrators see decompiled source.'
        : 'Only system administrators see the Java behind an operation.';
    }
    if (e.reason === 'unknown-operation') {
      return 'This operation is not in the module any more: the catalog may be out of date. Rebuild it from the menu.';
    }
    if (e.reason === 'not-described') {
      return 'This module is not read from Jersey, so its Java is unknown.';
    }
    if (e.reason === 'class-not-found') {
      return target === 'source'
        ? 'The bytecode of this class could not be found (it may be generated at runtime or not on the classpath).'
        : 'The bytecode of this class could not be read (it may be generated at runtime).';
    }
    if (e.reason === 'invalid-class') return 'Invalid class name.';
    if (e.reason === 'session-expired') return 'Your session has expired: reload the page to log in again.';
    if (e.reason === 'not-details' || e.reason === 'not-source') {
      return target === 'source'
        ? 'The server answered with something other than the decompiled source.'
        : 'The server answered with something other than the details (a proxy or login page?).';
    }
    return target === 'source'
      ? `The server could not decompile it (${e.reason}).`
      : `The server could not read it (${e.reason}).`;
  }
  return 'The request failed: ' + (e instanceof Error ? e.message : String(e));
}

export function describeCatalogError(e: unknown): string {
  if (e instanceof Error && e.name === 'SessionExpired') {
    return 'Your session has expired: reload the page to log in again.';
  }
  return 'Could not load the catalog: ' + (e instanceof Error ? e.message : String(e));
}

/** Formats an ISO timestamp or epoch millis safely without emitting `"Invalid Date"`. */
export function formatIsoTime(value: string | number): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}
