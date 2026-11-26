import { describe, expect, it } from 'vitest';
import { RequestRunner, downloadBlob, fetchEcho, kindOf } from './runner';

const req = { method: 'GET', url: '/rest/api/2/x', headers: { Accept: 'application/json' } };
const fakeFetch = (make: (init?: RequestInit) => Response | Promise<Response>) =>
  ((_url: unknown, init?: RequestInit) => Promise.resolve(make(init))) as unknown as typeof fetch;

function streamed(chunks: string[], type: string): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      chunks.forEach((s) => c.enqueue(enc.encode(s)));
      c.close();
    },
  });
  return new Response(body, { headers: { 'content-type': type } });
}

describe('RequestRunner', () => {
  it('reads a JSON response', async () => {
    const r = await new RequestRunner(fakeFetch(() =>
      new Response('{"a":1}', { status: 200, headers: { 'Content-Type': 'application/json;charset=UTF-8' } })),
    ).run(req);
    expect(r.status).toBe(200);
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('json');
    expect(r.text).toBe('{"a":1}');
    expect(r.size).toBe(7);
    expect(r.truncated).toBe(false);
    expect(r.blob?.size).toBe(7);   // the bytes as received, for the download
    expect(r.headers.some(([n]) => n === 'content-type')).toBe(true);
    expect(r.sessionExpired).toBe(false);
  });

  it('truncates a streamed body at the cap', async () => {
    const r = await new RequestRunner(fakeFetch(() => streamed(['aaaa', 'bbbb', 'cccc'], 'text/plain')), 6).run(req);
    expect(r.truncated).toBe(true);
    expect(r.size).toBe(6);
    expect(r.text).toBe('aaaabb');
    expect(r.kind).toBe('text');
  });

  it('treats binary as binary without text', async () => {
    const r = await new RequestRunner(fakeFetch(() =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } })),
    ).run(req);
    expect(r.kind).toBe('binary');
    expect(r.text).toBeUndefined();
    expect(r.blob?.size).toBe(3);
  });

  it('reports an empty body', async () => {
    const r = await new RequestRunner(fakeFetch(() => new Response(null, { status: 204 }))).run(req);
    expect(r.kind).toBe('empty');
    expect(r.size).toBe(0);
    expect(r.blob).toBeUndefined();
  });

  it('resolves with error "aborted" when aborted', async () => {
    const f = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init!.signal!.addEventListener('abort', () => rej(new DOMException('x', 'AbortError')));
      })) as unknown as typeof fetch;
    const runner = new RequestRunner(f);
    const p = runner.run(req);
    expect(runner.running).toBe(true);
    runner.abort();
    expect(runner.running).toBe(false);
    const r = await p;
    expect(r.status).toBe(0);
    expect(r.error).toBe('aborted');
    expect(runner.running).toBe(false);
  });

  it('aborts the previous request when a new one starts', async () => {
    let calls = 0;
    const f = ((_u: unknown, init?: RequestInit) => {
      if (calls++ === 0) {
        return new Promise((_res, rej) => init!.signal!.addEventListener('abort', () => rej(new Error('x'))));
      }
      return Promise.resolve(new Response('ok', { headers: { 'content-type': 'text/plain' } }));
    }) as unknown as typeof fetch;
    const runner = new RequestRunner(f);
    const first = runner.run(req);
    const second = await runner.run(req);
    expect((await first).error).toBe('aborted');
    expect(second.text).toBe('ok');
  });

  it('resolves network errors', async () => {
    const f = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    const r = await new RequestRunner(f).run(req);
    expect(r.status).toBe(0);
    expect(r.error).toBe('Failed to fetch');
  });

  it('flags session expiry on 401', async () => {
    const r = await new RequestRunner(fakeFetch(() => new Response('', { status: 401 }))).run(req);
    expect(r.sessionExpired).toBe(true);
  });

  it('flags session expiry on a login reason header', async () => {
    const r = await new RequestRunner(fakeFetch(() =>
      new Response('x', { headers: { 'X-Seraph-LoginReason': 'OUT', 'content-type': 'text/plain' } })),
    ).run(req);
    expect(r.sessionExpired).toBe(true);
  });

  it('flags session expiry on a redirect to an HTML login page', async () => {
    const res = new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
    Object.defineProperty(res, 'redirected', { value: true });
    Object.defineProperty(res, 'url', { value: 'http://h/login.jsp?x=1' });
    const r = await new RequestRunner(fakeFetch(() => res)).run(req);
    expect(r.kind).toBe('html');
    expect(r.sessionExpired).toBe(true);
  });

  it('downloadBlob uses the binary blob or builds one from the text', async () => {
    const bin = await new RequestRunner(fakeFetch(() =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } })),
    ).run(req);
    expect(downloadBlob(bin)).toBe(bin.blob);
    const txt = await new RequestRunner(fakeFetch(() =>
      new Response('{"a":1}', { headers: { 'content-type': 'application/json' } })),
    ).run(req);
    const blob = downloadBlob({ ...txt, blob: undefined })!;
    expect(blob.size).toBe(7);
    expect(blob.type).toBe('application/json');
    expect(downloadBlob(txt)).toBe(txt.blob);
    expect(downloadBlob({ ...txt, text: undefined, blob: undefined })).toBeNull();
  });
});

describe('fetchEcho', () => {
  const result = (method: string) => ({
    method, url: '/jira/rest/x', status: 200, statusText: 'OK', ok: true, headers: [], contentType: '', durationMs: 1, size: 0,
    truncated: false, kind: 'empty' as const, sessionExpired: false,
    requestHeaders: [['Accept', 'text/plain'], ['X-Atlassian-Token', 'no-check']] as [string, string][],
  });

  it('sends a copy with the same method and headers (JSON accepted), once per response', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"method":"PUT","headers":[["user-agent","UA"]]}', { status: 200 });
    }) as unknown as typeof fetch;
    const r = result('PUT');
    expect(await fetchEcho('/jira', r, f)).toEqual([['user-agent', 'UA']]);
    await fetchEcho('/jira', r, f);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('/jira/rest/restbrowser/1/echo');
    expect(calls[0].init.method).toBe('PUT');
    expect(calls[0].init.headers).toEqual({ 'X-Atlassian-Token': 'no-check', Accept: 'application/json' });
    await fetchEcho('/jira', result('OPTIONS'), f);
    expect(calls[1].init.method).toBe('GET');
  });

  it('asks again after a failure', async () => {
    let n = 0;
    const f = (async () => { n++; return new Response('', { status: 500 }); }) as unknown as typeof fetch;
    const r = result('GET');
    await expect(fetchEcho('', r, f)).rejects.toThrow('HTTP 500');
    await new Promise((res) => setTimeout(res, 0));
    await expect(fetchEcho('', r, f)).rejects.toThrow();
    expect(n).toBe(2);
  });
});

describe('RequestRunner review fixes', () => {
  it('takes only XML types for XML, so Office files stay binary', () => {
    expect(kindOf('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 10)).toBe('binary');
    expect(kindOf('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 10)).toBe('binary');
    expect(kindOf('application/xml; charset=UTF-8', 10)).toBe('xml');
    expect(kindOf('text/xml', 10)).toBe('xml');
    expect(kindOf('application/atom+xml', 10)).toBe('xml');
    expect(kindOf('image/svg+xml', 10)).toBe('xml');
  });

  it('decodes text in the charset of its Content-Type and keeps the bytes for the download', async () => {
    const bytes = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);   // "café" in ISO-8859-1
    const r = await new RequestRunner(fakeFetch(() =>
      new Response(bytes, { headers: { 'content-type': 'text/plain; charset="ISO-8859-1"' } })),
    ).run(req);
    expect(r.kind).toBe('text');
    expect(r.text).toBe('café');
    expect(new Uint8Array(await downloadBlob(r)!.arrayBuffer())).toEqual(bytes);
    const unknown = await new RequestRunner(fakeFetch(() =>
      new Response('é', { headers: { 'content-type': 'text/plain; charset=x-no-such-charset' } })),
    ).run(req);
    expect(unknown.text).toBe('é');
  });
});

describe('RequestRunner second review', () => {
  const result = (method: string) => ({
    method, url: '/jira/rest/x', status: 200, statusText: 'OK', ok: true, headers: [], contentType: '', durationMs: 1, size: 0,
    truncated: false, kind: 'empty' as const, sessionExpired: false, requestHeaders: [] as [string, string][],
  });

  it('fetchEcho says so when the session expired, and checks the answer', async () => {
    const login = (async () => new Response('<html>Log in</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    await expect(fetchEcho('', result('GET'), login)).rejects.toThrow(/session has expired/);
    const odd = (async () => new Response('{"headers":{"a":"b"}}', { status: 200 })) as unknown as typeof fetch;
    await expect(fetchEcho('', result('GET'), odd)).rejects.toThrow(/headers/);
    const pairs = (async () => new Response('{"headers":[["a"]]}', { status: 200 })) as unknown as typeof fetch;
    await expect(fetchEcho('', result('GET'), pairs)).rejects.toThrow(/headers/);
  });

  it('gives an empty body no text, so there is nothing to download', async () => {
    const r = await new RequestRunner(fakeFetch(() => new Response(null, { status: 204 }))).run(req);
    expect(r.kind).toBe('empty');
    expect(r.text).toBeUndefined();
    expect(downloadBlob(r)).toBeNull();
  });

  it('does not take a plain 401 for an expired session when the request sent its own Authorization', async () => {
    const own = { ...req, headers: { ...req.headers, authorization: 'Bearer x' } };
    const plain = await new RequestRunner(fakeFetch(() => new Response('', { status: 401 }))).run(own);
    expect(plain.sessionExpired).toBe(false);
    const seraph = await new RequestRunner(fakeFetch(() =>
      new Response('', { status: 401, headers: { 'X-Seraph-LoginReason': 'AUTHENTICATED_FAILED' } }))).run(own);
    expect(seraph.sessionExpired).toBe(true);
    expect((await new RequestRunner(fakeFetch(() => new Response('', { status: 401 }))).run(req)).sessionExpired).toBe(true);
  });

  it('classifies YAML/form content-types as text and releases stream lock on error', async () => {
    expect(kindOf('application/yaml', 10)).toBe('text');
    expect(kindOf('application/x-www-form-urlencoded', 10)).toBe('text');

    const failing = new ReadableStream<Uint8Array>({
      pull() {
        return Promise.reject(new Error('stream boom'));
      },
    });
    const res = new Response(failing, { headers: { 'content-type': 'text/plain' } });
    const r = await new RequestRunner(fakeFetch(() => res)).run(req);
    expect(r.error).toBe('stream boom');
    expect(failing.locked).toBe(false);
  });
});
