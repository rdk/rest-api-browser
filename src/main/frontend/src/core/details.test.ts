import { describe, expect, it } from 'vitest';
import {
  clearDetails, DetailsError, fetchClassInfo, fetchDetails, fetchPluginInfo, fetchSource,
  forgetDetails, forgetSource, isError, peekDetails, peekSource, shortJava, type BundleInfo,
} from './details';

const DETAILS = {
  format: 1, key: 'k', method: { error: 'm' }, locators: [], resourceClass: { error: 'c' }, types: [],
  bundle: { none: 'not in a bundle' }, plugin: null, module: { error: 'r' },
};
const answer = (body: string, init: ResponseInit = {}) => (async () => new Response(body, init)) as typeof fetch;

describe('details', () => {
  it('drops packages from Java names, not from quoted text', () => {
    expect(shortJava('java.util.Map<java.lang.String, java.util.List<java.lang.Thread$State>>')).toBe('Map<String, List<Thread.State>>');
    expect(shortJava('@jakarta.ws.rs.PathParam("id")')).toBe('@PathParam("id")');
    expect(shortJava('@jakarta.ws.rs.Path("com.example.Thing")')).toBe('@Path("com.example.Thing")');
    expect(shortJava('com.atlassian.jira.rest.v2.issue.IssueResource')).toBe('IssueResource');
    expect(shortJava('int')).toBe('int');
  });

  it('tells a section that failed from one that did not', () => {
    expect(isError({ error: 'x' })).toBe(true);
    expect(isError({ name: 'a', error: 'not alone' } as never)).toBe(false);
    expect(isError([])).toBe(false);
    expect(isError(undefined)).toBe(false);
  });

  it('fetches once per key, and asks again after a failure', async () => {
    let calls = 0;
    const ok = (async () => { calls++; return new Response(JSON.stringify(DETAILS), { status: 200 }); }) as typeof fetch;
    await fetchDetails('/jira', 'k', ok);
    await fetchDetails('/jira', 'k', ok);
    expect(calls).toBe(1);
    forgetDetails('k');

    const denied = (async () => { calls++; return new Response('{"error":"system-admin-only"}', { status: 403 }); }) as typeof fetch;
    await expect(fetchDetails('/jira', 'd', denied)).rejects.toEqual(new DetailsError(403, 'system-admin-only'));
    await new Promise((r) => setTimeout(r, 0));
    await expect(fetchDetails('/jira', 'd', denied)).rejects.toBeInstanceOf(DetailsError);
    expect(calls).toBe(3);
  });

  it('takes a login page for an expired session and says so', async () => {
    const page = answer('<html>Log in</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const e = await fetchDetails('/jira', 'login', page).catch((x) => x);
    expect(e).toBeInstanceOf(DetailsError);
    expect(e).toMatchObject({ status: 401, reason: 'session-expired' });
    expect(e.message).toMatch(/session has expired/);
    const denied = answer('{}', { status: 403, headers: { 'X-Seraph-LoginReason': 'AUTHENTICATION_DENIED' } });
    await expect(fetchDetails('/jira', 'denied', denied)).rejects.toMatchObject({ reason: 'session-expired' });
  });

  it('rejects a 200 answer that is not the details', async () => {
    for (const [i, body] of ['{}', 'not json', '[]', 'null', JSON.stringify({ ...DETAILS, types: {} }), JSON.stringify({ ...DETAILS, bundle: null }),
      JSON.stringify({ ...DETAILS, method: undefined }), JSON.stringify({ ...DETAILS, locators: 'x' })].entries()) {
      const e = await fetchDetails('/jira', 'shape' + i, answer(body, { status: 200 })).catch((x) => x);
      expect(e, body).toBeInstanceOf(DetailsError);
      expect(e.reason, body).toBe('not-details');
    }
    const fine = { ...DETAILS, method: { name: 'get' }, types: { error: 'x' }, locators: { error: 'y' }, definition: { error: 'z' } };
    expect(await fetchDetails('/jira', 'fine', answer(JSON.stringify(fine)))).toEqual(fine);
  });

  it('clearDetails() empties the cache', async () => {
    let calls = 0;
    const ok = (async () => { calls++; return new Response(JSON.stringify(DETAILS)); }) as typeof fetch;
    await fetchDetails('/jira', 'c1', ok);
    await fetchDetails('/jira', 'c2', ok);
    clearDetails();
    await fetchDetails('/jira', 'c1', ok);
    await fetchDetails('/jira', 'c2', ok);
    expect(calls).toBe(4);
  });
});

describe('details second review', () => {
  it('leaves char literals and a clipped string as written', () => {
    expect(shortJava('@x.y.Op(summary = "Uses java.lang.String and…')).toBe('@Op(summary = "Uses java.lang.String and…');
    expect(shortJava(`@x.y.A(a = '"', b = java.lang.String.class, c = '"')`)).toBe(`@A(a = '"', b = String.class, c = '"')`);
    expect(shortJava(`@x.y.B(c = 'x', d = java.util.List.class)`)).toBe(`@B(c = 'x', d = List.class)`);
  });

  it('a bundle may say it has no wiring', () => {
    const b: BundleInfo = { id: 1, symbolicName: 's', version: '1', state: 'ACTIVE', location: 'l', lastModified: 0, headers: {}, wiring: false };
    expect(b.wiring).toBe(false);
  });

  it('fetchSource caches by key, handles errors, and clears with clearDetails', async () => {
    clearDetails();
    let calls = 0;
    const ok = (async () => {
      calls++;
      return new Response(JSON.stringify({ format: 1, key: 'k', class: 'C', method: 'm', decompiler: 'CFR 0.152', source: 'void m() {}' }));
    }) as typeof fetch;
    const s1 = await fetchSource('/jira', 'k', ok);
    const s2 = await fetchSource('/jira', 'k', ok);
    expect(s1.source).toBe('void m() {}');
    expect(s2).toEqual(s1);
    expect(calls).toBe(1);
    clearDetails();
    await fetchSource('/jira', 'k', ok);
    expect(calls).toBe(2);

    const disabled = answer('{"error":"decompile-disabled"}', { status: 403 });
    await expect(fetchSource('/jira', 'dis', disabled)).rejects.toMatchObject({ status: 403, reason: 'decompile-disabled' });
    await expect(fetchSource('/jira', 'bad', answer('{}'))).rejects.toMatchObject({ reason: 'not-source' });

    let lastUrl = '';
    const spy = (async (url: string) => {
      lastUrl = String(url);
      return new Response(JSON.stringify({ format: 1, class: 'com.example.Foo', scope: 'class', decompilerId: 'vineflower', decompiler: 'Vineflower 1.12.0', bundleId: 7, source: 'class Foo {}', refs: [] }));
    }) as typeof fetch;
    const vf = await fetchSource('/jira', { op: 'k', classCandidates: ['com.example.Foo'], fromBundle: 4, scope: 'class', decompiler: 'vineflower' }, spy);
    expect(vf.decompilerId).toBe('vineflower');
    expect(lastUrl).toContain('class=com.example.Foo');
    expect(lastUrl).toContain('fromBundle=4');
    expect(lastUrl).toContain('decompiler=vineflower');
    expect(peekSource({ op: 'k', classCandidates: ['com.example.Foo'], fromBundle: 4, scope: 'class', decompiler: 'vineflower' })).toEqual(vf);
    clearDetails();
    expect(peekSource({ op: 'k', classCandidates: ['com.example.Foo'], fromBundle: 4, scope: 'class', decompiler: 'vineflower' })).toBeNull();
  });

  it('peekDetails returns cached details synchronously and clears on forgetDetails/clearDetails', async () => {
    clearDetails();
    expect(peekDetails('sync-k')).toBeNull();
    const d = await fetchDetails('/jira', 'sync-k', answer(JSON.stringify(DETAILS)));
    expect(peekDetails('sync-k')).toEqual(d);
    forgetDetails('sync-k');
    expect(peekDetails('sync-k')).toBeNull();
  });

  it('scopes cache by baseUrl, guards stale writes after clearDetails, and checks error string', async () => {
    clearDetails();
    expect(isError({ error: 123 } as never)).toBe(false);
    let calls = 0;
    const f = (async (url: string) => {
      calls++;
      return new Response(JSON.stringify({ ...DETAILS, key: url }));
    }) as typeof fetch;
    const a = await fetchDetails('/jira', 'k1', f);
    const b = await fetchDetails('/wiki', 'k1', f);
    expect(a.key).toContain('/jira');
    expect(b.key).toContain('/wiki');
    expect(calls).toBe(2);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async () => {
      await gate;
      return new Response(JSON.stringify(DETAILS));
    }) as typeof fetch;
    const inflight = fetchDetails('/jira', 'race-k', slow);
    clearDetails();
    release();
    await inflight;
    expect(peekDetails('race-k', '/jira')).toBeNull();
  });

  it('aliases multi-candidate fetchSource under the resolved class name and forgets both resolved and promise maps', async () => {
    clearDetails();
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(JSON.stringify({
        format: 1,
        class: 'com.example.Real',
        decompiler: 'Vineflower 1.12.0',
        decompilerId: 'vineflower',
        source: 'public class Real {}',
        refs: [],
      }));
    }) as typeof fetch;

    const query = { op: 'op:1', classCandidates: ['com.example.Alt', 'com.example.Real'], fromBundle: 2, scope: 'class' as const, decompiler: 'vineflower' as const };
    const loaded = await fetchSource('/jira', query, f);
    expect(loaded.class).toBe('com.example.Real');

    const canonical = { op: 'op:1', classCandidates: ['com.example.Real'], fromBundle: 2, scope: 'class' as const, decompiler: 'vineflower' as const };
    expect(peekSource(canonical, '/jira')).toEqual(loaded);
    await fetchSource('/jira', canonical, f);
    expect(calls).toBe(1);

    forgetDetails('op:1', '/jira');
    expect(peekSource(query, '/jira')).toBeNull();
    expect(peekSource(canonical, '/jira')).toBeNull();

    // forgetSource with a SourceQuery also evicts aliased resolved class entries
    await fetchSource('/jira', query, f);
    expect(peekSource(canonical, '/jira')).not.toBeNull();
    forgetSource(query, '/jira');
    expect(peekSource(query, '/jira')).toBeNull();
    expect(peekSource(canonical, '/jira')).toBeNull();
  });

  it('fetchClassInfo and fetchPluginInfo cache per baseUrl, evict on failure, and validate response shapes', async () => {
    clearDetails();
    let classCalls = 0;
    const classPayload = {
      format: 1,
      name: 'com.example.Demo',
      simpleName: 'Demo',
      package: 'com.example',
      kind: 'class',
      modifiers: 'public',
      deprecated: false,
      superclasses: [],
      interfaces: [],
      annotations: [],
      innerClasses: [],
      fieldCount: 1,
      constructorCount: 1,
      methodCount: 2,
      methods: ['a()'],
      bytecodeBytes: 120,
      codeSource: null,
      classLoader: 'BundleClassLoader',
      origin: 'bundle',
      bundleId: 5,
      refCount: 0,
      refs: [],
    };
    const classFetch = (async () => {
      classCalls++;
      return new Response(JSON.stringify(classPayload), { status: 200 });
    }) as typeof fetch;
    const c1 = await fetchClassInfo('/jira', { classCandidates: ['com.example.Demo'], fromBundle: 5 }, classFetch);
    const c2 = await fetchClassInfo('/jira', { classCandidates: ['com.example.Demo'], fromBundle: 5 }, classFetch);
    expect(c1.name).toBe('com.example.Demo');
    expect(c2).toEqual(c1);
    expect(classCalls).toBe(1);

    await expect(fetchClassInfo('/jira', { classCandidates: ['bad.Shape'] }, answer('{}'))).rejects.toMatchObject({
      reason: 'not-class-info',
    });

    let pluginCalls = 0;
    const pluginPayload = {
      format: 1,
      key: 'com.example.plugin',
      name: 'Example Plugin',
      state: 'ENABLED',
      pluginsVersion: 2,
      moduleCount: 3,
      enabledModuleCount: 3,
      dependsOn: [],
      optionallyDependsOn: [],
    };
    const pluginFetch = (async () => {
      pluginCalls++;
      return new Response(JSON.stringify(pluginPayload), { status: 200 });
    }) as typeof fetch;
    const p1 = await fetchPluginInfo('/jira', 'com.example.plugin', pluginFetch);
    const p2 = await fetchPluginInfo('/jira', 'com.example.plugin', pluginFetch);
    expect(p1.name).toBe('Example Plugin');
    expect(p2).toEqual(p1);
    expect(pluginCalls).toBe(1);

    await expect(fetchPluginInfo('/jira', 'bad.plugin', answer('{}'))).rejects.toMatchObject({
      reason: 'not-plugin-info',
    });
  });
});
