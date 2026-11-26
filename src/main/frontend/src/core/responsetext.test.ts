import { describe, expect, it } from 'vitest';
import { PROXY, addedHeaders, downloadOf, indexIn, textOf, type ResponseData } from './responsetext';

function makeResult(partial: Partial<ResponseData> = {}): ResponseData {
  return {
    method: 'POST',
    url: '/jira/rest/api/2/issue',
    status: 200,
    statusText: 'OK',
    headers: [['Content-Type', 'application/json'], ['X-AUSERNAME', 'admin']],
    requestHeaders: [['Accept', 'application/json']],
    requestBodyBytes: 42,
    contentType: 'application/json',
    size: 20,
    truncated: false,
    kind: 'json',
    text: '{"id":1234567890123456789}',
    ...partial,
  };
}

describe('responsetext', () => {
  it('merges added echo headers and substitutes real requestBodyBytes for content-length', () => {
    const r = makeResult({
      requestHeaders: [['Accept', 'application/json'], ['X-Custom', '1']],
      requestBodyBytes: 128,
    });
    const echo: [string, string][] = [
      ['accept', 'application/json'],
      ['content-length', '0'],
      ['cookie', 'JSESSIONID=(hidden)'],
      ['x-forwarded-for', '10.0.0.1'],
    ];
    expect(addedHeaders(r, echo)).toEqual([
      ['content-length', '128'],
      ['cookie', 'JSESSIONID=(hidden)'],
      ['x-forwarded-for', '10.0.0.1'],
    ]);

    // When echo omitted content-length and app did not set it, append synthetic content-length
    expect(addedHeaders(makeResult({ requestHeaders: [], requestBodyBytes: 99 }), [['host', 'example']])).toEqual([
      ['host', 'example'],
      ['content-length', '99'],
    ]);
  });

  it('recognizes proxy headers case-insensitively', () => {
    expect(PROXY.test('X-Forwarded-For')).toBe(true);
    expect(PROXY.test('traceparent')).toBe(true);
    expect(PROXY.test('cf-ray')).toBe(true);
    expect(PROXY.test('User-Agent')).toBe(false);
  });

  it('formats pretty JSON losslessly without corrupting huge integers and builds downloadable files', async () => {
    const res = makeResult();
    const pretty = await textOf('pretty', res, '');
    expect(pretty).toContain('1234567890123456789');
    expect(pretty).toContain('\n');
    expect(await textOf('raw', res, '')).toBe(res.text);
    expect(await textOf('headers', res, '')).toBe('HTTP 200 OK\nContent-Type: application/json\nX-AUSERNAME: admin\n');

    const sent = await textOf('sent', res, '/jira', async () => [['x-forwarded-host', 'proxy'], ['accept', 'ignored']]);
    expect(sent).toContain('POST /jira/rest/api/2/issue\nAccept: application/json\nx-forwarded-host: proxy\n');

    const sentErr = await textOf('sent', res, '/jira', async () => {
      throw new Error('offline');
    });
    expect(sentErr).toContain('# The headers the browser added could not be read: offline');

    const dl = await downloadOf('pretty', res, '');
    expect(dl?.name).toBe('response.json');
    expect(await downloadOf('pretty', makeResult({ size: 0, text: undefined, blob: undefined, kind: 'empty' }), '')).toBeNull();
  });

  it('binary-searches sorted line indices', () => {
    expect(indexIn([2, 5, 9, 14], 2)).toBe(0);
    expect(indexIn([2, 5, 9, 14], 9)).toBe(2);
    expect(indexIn([2, 5, 9, 14], 14)).toBe(3);
    expect(indexIn([2, 5, 9, 14], 7)).toBe(-1);
    expect(indexIn([], 1)).toBe(-1);
  });
});
