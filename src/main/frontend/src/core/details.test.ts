import { describe, expect, it } from 'vitest';
import { DetailsError, fetchDetails, forgetDetails, isError, shortJava } from './details';

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
    const ok = (async () => { calls++; return new Response('{"format":1,"key":"k"}', { status: 200 }); }) as typeof fetch;
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
});
