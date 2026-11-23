import { describe, expect, it } from 'vitest';
import { reasonInfo, statusInfo } from './explain';

describe('reasonInfo', () => {
  it('tells a module waiting to start, one left out on purpose and one that failed apart', () => {
    expect(reasonInfo('not-started')).toMatchObject({ kind: 'waiting', label: 'not started' });
    expect(reasonInfo('not-started').text).toMatch(/first request/);
    expect(reasonInfo('excluded')).toMatchObject({ kind: 'skipped', label: 'not described' });
    expect(reasonInfo('rest-v1')).toMatchObject({ kind: 'skipped', label: 'not described' });
    expect(reasonInfo('timeout')).toMatchObject({ kind: 'failed', label: 'failed: timeout' });
  });
  it('shows an unknown or missing reason as a failure with its code', () => {
    expect(reasonInfo('something-new')).toMatchObject({ kind: 'failed', label: 'failed: something-new' });
    expect(reasonInfo(undefined)).toMatchObject({ kind: 'failed', label: 'failed: error' });
    expect(reasonInfo('toString')).toMatchObject({ kind: 'failed', label: 'failed: toString' });
  });
});

describe('statusInfo', () => {
  it('explains the usual codes with what to try here', () => {
    expect(statusInfo(403).text).toMatch(/X-Atlassian-Token/);
    expect(statusInfo(415).text).toMatch(/Body tab/);
    expect(statusInfo(404).title).toBe('Not Found');
  });
  it('falls back on the class of an unknown code', () => {
    expect(statusInfo(418, "I'm a teapot")).toMatchObject({ title: "I'm a teapot" });
    expect(statusInfo(418).text).toMatch(/refused/);
    expect(statusInfo(599).text).toMatch(/failed/);
    expect(statusInfo(0).text).toMatch(/No answer/);
  });
});
