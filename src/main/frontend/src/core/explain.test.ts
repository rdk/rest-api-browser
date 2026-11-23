import { describe, expect, it } from 'vitest';
import { isWaiting, moduleReason, reasonInfo, rowLabel, statusInfo, statusTone } from './explain';
import { module } from './fixtures';

describe('reasonInfo', () => {
  it('tells a module waiting to start, one left out on purpose and one that failed apart', () => {
    expect(reasonInfo('not-started')).toMatchObject({ code: 'not-started', kind: 'waiting' });
    expect(reasonInfo('not-started').text).toMatch(/first request/);
    expect(reasonInfo('excluded').kind).toBe('skipped');
    expect(reasonInfo('rest-v1').kind).toBe('skipped');
    expect(reasonInfo('timeout').kind).toBe('failed');
    expect(['not-started', 'excluded', 'timeout'].map((c) => rowLabel(reasonInfo(c))))
      .toEqual(['not started', 'not described', 'failed: timeout']);
  });
  it('shows an unknown or missing reason as a failure with its code', () => {
    expect(rowLabel(reasonInfo('something-new'))).toBe('failed: something-new');
    expect(reasonInfo(undefined)).toMatchObject({ code: 'error', kind: 'failed' });
    expect(reasonInfo('toString')).toMatchObject({ code: 'toString', kind: 'failed' });
  });
  it('does not claim that starting a module runs nothing of it', () => {
    expect(reasonInfo('not-started').text).not.toMatch(/nothing of it runs|answers 404/);
  });
});

describe('moduleReason', () => {
  it('has a reason only for a module that could not be read', () => {
    expect(moduleReason(module('a', 'a/1'))).toBeNull();
    expect(moduleReason(module('a', 'a/1', { state: 'pending' }))).toBeNull();
    expect(moduleReason(module('a', 'a/1', { state: 'failed', reason: 'excluded' }))?.kind).toBe('skipped');
    expect(isWaiting(module('a', 'a/1', { state: 'failed', reason: 'not-started' }))).toBe(true);
    expect(isWaiting(module('a', 'a/1', { state: 'ok', reason: 'not-started' }))).toBe(false);
  });
});

describe('statusInfo', () => {
  it('explains the usual codes with what to try here', () => {
    expect(statusInfo(403).text).toMatch(/X-Atlassian-Token/);
    expect(statusInfo(415).text).toMatch(/Body tab/);
    expect(statusInfo(404).title).toBe('Not Found');
    expect(statusInfo(404).text).toMatch(/may not see/);
    expect(statusInfo(307).text).toBe(statusInfo(302).text);
  });
  it('falls back on the class of an unknown code, without making up a title', () => {
    expect(statusInfo(418, "I'm a teapot")).toMatchObject({ title: "I'm a teapot" });
    expect(statusInfo(418).title).toBe('');
    expect(statusInfo(418).text).toMatch(/refused/);
    expect(statusInfo(599).text).toMatch(/failed/);
    expect(statusInfo(103).text).toMatch(/interim/);
    expect(statusInfo(0).text).toMatch(/No answer/);
  });
  it('gives each class its tone', () => {
    expect([undefined, 0, 200, 302, 404, 503].map(statusTone)).toEqual(['info', 'info', 'ok', 'info', 'warn', 'err']);
  });
});
