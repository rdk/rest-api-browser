import { describe, expect, it } from 'vitest';
import { cleanRequestBody, cleanUrlSecrets, isCredentialHeader, isCredentialParam, isSecretAny, isSecretMember } from './redact';

describe('http-redact', () => {
  it('detects credential headers while keeping safe headers visible', () => {
    for (const h of ['Authorization', 'Proxy-Authorization', 'Cookie', 'Set-Cookie2', 'X-Api-Key', 'X-MyCookies', 'X-CSRF-Token']) {
      expect(isCredentialHeader(h), h).toBe(true);
    }
    for (const h of ['X-Atlassian-Token', 'Accept', 'Content-Type', 'X-Author-Id', 'X-Request-Id']) {
      expect(isCredentialHeader(h), h).toBe(false);
    }
  });

  it('detects credential parameters without flagging benign pagination names', () => {
    for (const p of ['password', 'os_password', 'userPasswd', 'adminPwd', 'clientSecret', 'access_token', 'auth_code', 'authorization']) {
      expect(isCredentialParam(p), p).toBe(true);
    }
    for (const p of ['pageToken', 'syncToken', 'author', 'os_username', 'session']) {
      expect(isCredentialParam(p), p).toBe(false);
    }
  });

  it('classifies secret JSON/form members and non-scalar containers', () => {
    for (const m of ['password', 'proxyAuthorization', 'authCode', 'authKey', 'apiToken', 'bearer']) {
      expect(isSecretMember(m), m).toBe(true);
    }
    expect(isSecretMember('tokenCount')).toBe(true); // member stem matches, filtered at scalar vs non-scalar check
    expect(isSecretAny('tokenCount')).toBe(false);
    for (const a of ['passwords', 'tokens', 'apiKeys', 'authKey', 'authKeys', 'authorization']) {
      expect(isSecretAny(a), a).toBe(true);
    }
  });

  it('redacts JSON objects/arrays, form payloads, text secrets, and quoted JSON strings without modifying benign payloads', () => {
    expect(cleanRequestBody('{"password":"abc","authKey":"xyz","tokenCount":3}', 'application/json')).toEqual({
      body: '{"password":"(hidden)","authKey":"(hidden)","tokenCount":3}',
      redacted: true,
    });
    expect(cleanRequestBody('"os_password=hunter2"', 'application/json')).toEqual({
      body: undefined,
      redacted: true,
    });
    expect(cleanRequestBody('"userPassword: foo"', 'text/plain')).toEqual({
      body: undefined,
      redacted: true,
    });
    expect(cleanRequestBody('["Bearer eyJhbGciOi...", "password=secret"]', 'application/json')).toEqual({
      body: undefined,
      redacted: true,
    });
    expect(cleanRequestBody('["item1", "item2"]', 'application/json')).toEqual({
      body: '["item1", "item2"]',
      redacted: false,
    });
    expect(cleanRequestBody('bypass=true&compass=north', 'text/plain')).toEqual({
      body: 'bypass=true&compass=north',
      redacted: false,
    });
    expect(cleanRequestBody('user=alice&authKey=k1&os_password=pw', 'application/x-www-form-urlencoded')).toEqual({
      body: 'user=alice&authKey=(hidden)&os_password=(hidden)',
      redacted: true,
    });
  });

  it('strips secret matrix and query parameters while preserving hashes and safe parameters', () => {
    expect(cleanUrlSecrets('/rest/x;token=1;ok=2/y?os_password=pw&pageToken=next&secret=s#frag')).toEqual({
      url: '/rest/x;ok=2/y?pageToken=next#frag',
      redacted: true,
    });
    expect(cleanUrlSecrets('/rest/x?pageToken=next&author=alice%ZZ')).toEqual({
      url: '/rest/x?pageToken=next&author=alice%ZZ',
      redacted: false,
    });
  });
});
