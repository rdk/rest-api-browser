import { describe, expect, it } from 'vitest';
import { clearDetails, DetailsError, fetchDetails, forgetDetails, isError, shortJava } from './details';

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
