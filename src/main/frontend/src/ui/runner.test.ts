import { describe, expect, it } from 'vitest';
import { RequestRunner } from './runner';

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
    expect(r.blob?.size).toBe(7);
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
});
