import { describe, expect, it } from 'vitest';
import { DetailsError } from './details';
import { describeCatalogError, describeDetailsError, formatIsoTime } from './detailserror';

describe('detailserror', () => {
  it('describes 403 and reason-specific DetailsErrors for both details and source views', () => {
    expect(describeDetailsError(new DetailsError(403, 'decompile-disabled'))).toContain('Decompiling is disabled');
    expect(describeDetailsError(new DetailsError(403, 'forbidden'), 'details')).toContain('Java behind an operation');
    expect(describeDetailsError(new DetailsError(403, 'forbidden'), 'source')).toContain('decompiled source');
    expect(describeDetailsError(new DetailsError(404, 'class-not-found'), 'source')).toContain('not on the classpath');
    expect(describeDetailsError(new DetailsError(404, 'class-not-found'), 'details')).toContain('generated at runtime');
    expect(describeDetailsError(new DetailsError(400, 'invalid-class'), 'source')).toBe('Invalid class name.');
    expect(describeDetailsError(new DetailsError(401, 'session-expired'))).toContain('session has expired');
    expect(describeDetailsError(new DetailsError(500, 'boom'), 'source')).toBe('The server could not decompile it (boom).');
    expect(describeDetailsError(new Error('network'))).toBe('The request failed: network');
  });

  it('describes catalog errors and preserves invalid date strings safely', () => {
    const expired = new Error('401');
    expired.name = 'SessionExpired';
    expect(describeCatalogError(expired)).toContain('session has expired');
    expect(describeCatalogError(new Error('timeout'))).toBe('Could not load the catalog: timeout');

    expect(formatIsoTime('not-a-date')).toBe('not-a-date');
    expect(formatIsoTime('2026-01-15T10:30:00Z')).not.toBe('Invalid Date');
  });
});
