import { describe, expect, it } from 'vitest';
import type { RequestValues } from '../core/request';
import { UserStore, historyUrl, isCredentialHeader, isCredentialParam } from './userstore';
import { module, op, summary } from '../core/fixtures';

class FakeStorage implements Storage {
  data = new Map<string, string>();
  failWrites = false;
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  setItem(k: string, v: string) {
    if (this.failWrites) throw new DOMException('full', 'QuotaExceededError');
    this.data.set(k, v);
  }
}

const values = (header: Record<string, string> = {}): RequestValues => ({ path: {}, query: {}, header, matrix: {} });
const entry = (opKey: string, extra: Partial<Parameters<UserStore['addHistory']>[0]> = {}) => ({
  opKey, method: 'GET', url: '/rest/x', values: values(), ...extra,
});

describe('UserStore', () => {
  it('returns history newest first, per operation', async () => {
    const s = new UserStore('u', new FakeStorage());
    const a = await s.addHistory(entry('a'));
    await s.addHistory(entry('b'));
    const c = await s.addHistory(entry('a'));
    expect((await s.history('a')).map((e) => e.id)).toEqual([c.id, a.id]);
    expect(await s.history('b')).toHaveLength(1);
  });

  it('keeps 20 per operation and 500 overall, dropping the oldest', async () => {
    const s = new UserStore('u', new FakeStorage());
    for (let i = 0; i < 25; i++) await s.addHistory(entry('a', { status: i }));
    const a = await s.history('a');
    expect(a).toHaveLength(20);
    expect(a[0].status).toBe(24);
    expect(a[19].status).toBe(5);

    for (let i = 0; i < 30; i++) {
      for (let j = 0; j < 20; j++) await s.addHistory(entry(`op${i}`));
    }
    let total = 0;
    for (let i = 0; i < 30; i++) total += (await s.history(`op${i}`)).length;
    total += (await s.history('a')).length;
    expect(total).toBe(500);
    expect(await s.history('a')).toHaveLength(0);
  });

  it('strips credential headers but keeps x-atlassian-token', async () => {
    const storage = new FakeStorage();
    const s = new UserStore('u', storage);
    const e = await s.addHistory(entry('a', {
      values: values({
        Authorization: 'Basic abc', 'Proxy-Authorization': 'p', Cookie: 'c', 'Set-Cookie': 's',
        'X-Api-Token': 't', 'client-secret': 'x', 'X-Password': 'p', 'X-Atlassian-Token': 'no-check', Accept: 'a/b',
      }),
    }));
    expect(Object.keys(e.values.header).sort()).toEqual(['Accept', 'X-Atlassian-Token']);
    const raw = [...storage.data.values()].join('');
    expect(raw).not.toContain('Basic abc');
  });

  it('strips an Authorization query parameter', async () => {
    const s = new UserStore('u', new FakeStorage());
    const e = await s.addHistory(entry('a', { values: { ...values(), query: { authorization: ['x'], q: ['1'] } } }));
    expect(e.values.query).toEqual({ q: ['1'] });
  });

  it('falls back to memory when storage throws', async () => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    const s = new UserStore('u', storage);
    await s.addHistory(entry('a'));
    await s.setPrefs({ split: 0.4 });
    expect(await s.history('a')).toHaveLength(1);
    expect((await s.prefs()).split).toBe(0.4);
  });

  it('works with no storage at all', async () => {
    const s = new UserStore('u', null);
    await s.addHistory(entry('a'));
    expect(await s.history('a')).toHaveLength(1);
  });

  it('merges prefs and namespaces keys', async () => {
    const storage = new FakeStorage();
    const s = new UserStore('inst:bob', storage);
    await s.setPrefs({ split: 0.5, supportedOnly: true });
    await s.setPrefs({ split: 0.6 });
    expect(await s.prefs()).toEqual({ split: 0.6, supportedOnly: true });
    expect([...storage.data.keys()].every((k) => k.startsWith('rab-next:inst:bob:'))).toBe(true);
    expect(await new UserStore('other', storage).prefs()).toEqual({});
  });

  it('clears history for one operation only', async () => {
    const s = new UserStore('u', new FakeStorage());
    await s.addHistory(entry('a'));
    await s.addHistory(entry('b'));
    await s.clearHistory('a');
    expect(await s.history('a')).toHaveLength(0);
    expect(await s.history('b')).toHaveLength(1);
  });
});

describe('UserStore review fixes', () => {
  it('reads from memory after a failed write instead of the stale stored value', async () => {
    const st = new FakeStorage();
    const s = new UserStore('u', st);
    await s.setPrefs({ split: 1 });
    st.failWrites = true;
    await s.setPrefs({ split: 2 });
    expect((await s.prefs()).split).toBe(2);
  });

  it('drops the oldest history and retries once when storage is full', async () => {
    const st = new FakeStorage();
    const s = new UserStore('u', st);
    for (let i = 0; i < 4; i++) await s.addHistory(entry('a', { url: '/rest/' + i }));
    let size = 0;
    st.setItem = (k, v) => {
      if (v.length > size && size) throw new DOMException('full', 'QuotaExceededError');
      st.data.set(k, v);
    };
    size = (st.data.get('rab-next:u:history') ?? '').length;
    await s.addHistory(entry('a', { url: '/rest/new' }));
    const stored = JSON.parse(st.data.get('rab-next:u:history')!);
    expect(stored.length).toBeLessThan(5);
    expect(stored[0].url).toBe('/rest/new');
  });

  it('truncates long bodies, marks them and stores no preview', async () => {
    const s = new UserStore('u', new FakeStorage());
    const e = await s.addHistory(entry('a', { values: { ...values(), body: 'x'.repeat(10_500) }, bodyPreview: 'p' }));
    expect(e.values.body!.length).toBe(10_000);
    expect(e.bodyTruncated).toBe(true);
    expect(e.bodyPreview).toBeUndefined();
    const short = await s.addHistory(entry('a', { values: { ...values(), body: 'ok' } }));
    expect(short.bodyTruncated).toBeUndefined();
  });

  it('scrubs credentials by name from headers, params and the url', async () => {
    const s = new UserStore('u', new FakeStorage());
    const e = await s.addHistory(entry('a', {
      url: '/rest/x?apiKey=1&keep=2&auth_code=3#h',
      values: {
        path: {}, header: { ' X-Api-Key ': 'k', 'X-Atlassian-Token': 'no-check', 'X-Auth-User': 'a' },
        query: { api_key: ['1'], keep: ['2'] }, matrix: { Authorization: 'z', m: '1' },
      },
    }));
    expect(e.values.header).toEqual({ 'X-Atlassian-Token': 'no-check' });
    expect(e.values.query).toEqual({ keep: ['2'] });
    expect(e.values.matrix).toEqual({ m: '1' });
    expect(e.url).toBe('/rest/x?keep=2#h');
  });

  it('scrubs credential matrix parameters from the url path', async () => {
    const s = new UserStore('u', new FakeStorage());
    const e = await s.addHistory(entry('a', { url: '/rest/x;token=abc;m=1/y;api_key=2?keep=3', values: values() }));
    expect(e.url).toBe('/rest/x;m=1/y?keep=3');
  });
});

describe('UserStore second review', () => {
  it('keeps both of two quick setPrefs calls', async () => {
    const s = new UserStore('u', new FakeStorage());
    await Promise.all([s.setPrefs({ split: 0.3 }), s.setPrefs({ skin: 'calm' })]);
    expect(await s.prefs()).toEqual({ split: 0.3, skin: 'calm' });
  });

  it('reads the prefs synchronously, for the first paint', async () => {
    const st = new FakeStorage();
    await new UserStore('u', st).setPrefs({ skin: 'calm', mode: 'dark' });
    const s = new UserStore('u', st);
    expect(s.prefsNow()).toEqual({ skin: 'calm', mode: 'dark' });
    expect(s.prefsNow()).toEqual(await s.prefs());
    expect(new UserStore('u', null).prefsNow()).toEqual({});
    st.data.set('rab-next:u:prefs', 'null');
    expect(s.prefsNow()).toEqual({});
  });

  it('hides header names by their words, as the server echo does', () => {
    const hidden = ['Authorization', 'Proxy-Authorization', 'Cookie', 'Set-Cookie', 'X-Auth-Token', 'X-API_KEY', 'x-apikey', 'X-ApiKey',
      'X-Api Key', 'client_secret', 'X-Passwd', 'X-PWD', 'X-Session-Id', 'X-Auth-User', 'X-Credentials', 'Cf-Access-Jwt-Assertion',
      'X-Amz-Signature', 'X-Csrf-Token', 'X-Forwarded-Client-Cert', 'OIDC_CLAIM_email', 'X-SSO-User', 'X-Forwarded-Principal', 'SAML-Attr',
      // run together (HTTP/2 lowercases the names)
      'X-AccessToken', 'x-accesstoken', 'X-AuthToken', 'X-ApiToken', 'XApiKey', 'X-ClientSecret', 'X-UserPassword'];
    for (const n of hidden) expect(isCredentialHeader(n), n).toBe(true);
    const shown = ['X-Atlassian-Token', 'x_atlassian_token', ' X-Atlassian-Token ', 'X-Processor', 'X-Author-Id', 'AuthX', 'Accept',
      'Content-Type', 'X-Request-Id', 'User-Agent'];
    for (const n of shown) expect(isCredentialHeader(n), n).toBe(false);
  });

  it('tells credential parameters by their exact names, or a name ending in password or secret', () => {
    const hidden = ['password', 'PASSWD', 'secret', 'token', 'access_token', 'refresh_token', 'id_token', 'api_key', 'apikey', 'api-key', 'apiKey',
      'atl_token', 'client_secret', 'os_password', 'newPassword', 'authorization', 'auth_code'];
    for (const n of hidden) expect(isCredentialParam(n), n).toBe(true);
    for (const n of ['author', 'authorKey', 'pageToken', 'nextPageToken', 'syncToken', 'os_username', 'tokenId', 'passwordHint', 'secretary', 'session']) {
      expect(isCredentialParam(n), n).toBe(false);
    }
  });

  it('keeps harmless parameters whose names only look like credentials', async () => {
    const s = new UserStore('u', new FakeStorage());
    const e = await s.addHistory(entry('a', {
      url: '/rest/x;pageToken=1;token=2?author=a&authorKey=b&pageToken=c&nextPageToken=d&syncToken=e&os_username=f&os_password=g&access_token=h&newPassword=i',
      values: {
        path: {}, header: {}, matrix: { pageToken: '1', token: '2' },
        query: {
          author: ['a'], authorKey: ['b'], pageToken: ['c'], nextPageToken: ['d'], syncToken: ['e'], os_username: ['f'], os_password: ['g'],
          access_token: ['h'], newPassword: ['i'],
        },
      },
    }));
    expect(e.url).toBe('/rest/x;pageToken=1?author=a&authorKey=b&pageToken=c&nextPageToken=d&syncToken=e&os_username=f');
    expect(Object.keys(e.values.query)).toEqual(['author', 'authorKey', 'pageToken', 'nextPageToken', 'syncToken', 'os_username']);
    expect(e.values.matrix).toEqual({ pageToken: '1' });
    expect(e.redacted).toBe(true);
    const plain = await s.addHistory(entry('a', { url: '/rest/x?pageToken=c', values: { ...values({ Accept: 'a/b' }), query: { pageToken: ['c'] } } }));
    expect(plain.redacted).toBeUndefined();
  });

  it('scrubs credential-named path values from the values, and historyUrl builds the url without them', async () => {
    const sum = summary([module('m', 'x')]);
    const o = op('m', 'GET', '{id}/token/{token}/y', { params: [{ name: 'keep', in: 'query', type: 'string', required: false }] });
    const vals = { ...values(), path: { id: '1', token: 's3cr/t' }, query: { keep: ['1'] } };
    const url = historyUrl(sum, o, vals);
    expect(url).toBe('/jira/rest/x/1/token/{token}/y?keep=1');
    const s = new UserStore('u', new FakeStorage());
    const e = await s.addHistory(entry('a', { url, values: vals }));
    expect(e.values.path).toEqual({ id: '1' });
    expect(e.url).toBe(url);
    expect(JSON.stringify(e)).not.toContain('s3cr');
    expect(e.redacted).toBe(true);
    // a value that is also a literal part of the path: the literal stays, only the template's place is left out
    const lit = op('m', 'GET', '{token}/x/token-rest');
    expect(historyUrl(summary([module('m', 'rest')]), lit, { ...values(), path: { token: 'rest' } })).toBe('/jira/rest/rest/{token}/x/token-rest');
  });

  it('hides secrets in a JSON body and keeps the rest as written', async () => {
    const storage = new FakeStorage();
    const s = new UserStore('u', storage);
    const body = '{"name":"x","password":"hunter2","n":9007199254740993,"nested":{"api_token":"TOK1","pageToken":"PAGE2","list":[{"secret":"SEC3"}]},'
      + '"tokenCount":5, "pass\\u0077ord" : "PW4"}';
    const e = await s.addHistory(entry('a', { values: { ...values(), body } }));
    expect(e.values.body).toBe('{"name":"x","password":"(hidden)","n":9007199254740993,"nested":{"api_token":"(hidden)","pageToken":"(hidden)",'
      + '"list":[{"secret":"(hidden)"}]},"tokenCount":5, "pass\\u0077ord" : "(hidden)"}');
    expect(e.redacted).toBe(true);
    expect([...storage.data.values()].join('')).not.toMatch(/hunter2|TOK1|PAGE2|SEC3|PW4/);   // ids are lower case
    for (const b of ['{"a":1}', 'plain text', '<x>1</x>']) {
      const kept = await s.addHistory(entry('a', { values: { ...values(), body: b } }));
      expect(kept.values.body).toBe(b);
      expect(kept.redacted).toBeUndefined();
    }
  });

  it('hides secrets that are numbers, arrays or objects, but not a count named like a token', async () => {
    const s = new UserStore('u', new FakeStorage());
    const body = '{"password":123456,"tokens":["abc","def"],"secret":{"value":"xyz","n":[1]},"tokenCount":5,"apiToken":null,"user":"u"}';
    const e = await s.addHistory(entry('a', { values: { ...values(), body } }));
    expect(e.values.body).toBe('{"password":"(hidden)","tokens":"(hidden)","secret":"(hidden)","tokenCount":5,"apiToken":null,"user":"u"}');
    expect(e.redacted).toBe(true);
  });

  it('keeps a form body without its secret fields, and leaves out a non-JSON body that looks like it has one', async () => {
    const s = new UserStore('u', new FakeStorage());
    const form = await s.addHistory(entry('a', { values: { ...values(), contentType: 'application/x-www-form-urlencoded', body: 'user=u&os_password=pw&x=1' } }));
    expect(form.values.body).toBe('user=u&os_password=(hidden)&x=1');
    expect(form.redacted).toBe(true);
    for (const b of ['password=abc&user=test', '{"password": "unterminated', 'Authorization: Bearer x']) {
      const left = await s.addHistory(entry('a', { values: { ...values(), body: b } }));
      expect(left.values.body, b).toBeUndefined();
      expect(left.redacted, b).toBe(true);
    }
  });

  it('hides a secret in a long JSON body before cutting it', async () => {
    const s = new UserStore('u', new FakeStorage());
    const body = JSON.stringify({ password: 'hunter2', filler: 'x'.repeat(12_000) });
    const e = await s.addHistory(entry('a', { values: { ...values(), body } }));
    expect(e.bodyTruncated).toBe(true);
    expect(e.values.body).not.toContain('hunter2');
    expect(e.values.body!.startsWith('{"password":"(hidden)"')).toBe(true);
  });

  it('keeps history per user when given one, and removes the old shared list', async () => {
    const st = new FakeStorage();
    await new UserStore('site', st).addHistory(entry('a'));
    expect(st.data.has('rab-next:site:history')).toBe(true);
    const alice = new UserStore('site', 'alice', st);
    expect(await alice.history('a')).toHaveLength(0);
    expect(st.data.has('rab-next:site:history')).toBe(false);
    await alice.addHistory(entry('a'));
    expect(await new UserStore('site', 'bob', st).history('a')).toHaveLength(0);
    expect(await new UserStore('site', 'alice', st).history('a')).toHaveLength(1);
    // the preferences stay the site's
    await alice.setPrefs({ skin: 'calm' });
    expect((await new UserStore('site', 'bob', st).prefs()).skin).toBe('calm');
    expect(new UserStore('site', undefined, st).prefsNow().skin).toBe('calm');
  });

  it('drops the response previews old versions stored', async () => {
    const st = new FakeStorage();
    st.data.set('rab-next:u:history', JSON.stringify([{ id: 'old', opKey: 'a', at: 1, method: 'GET', url: '/rest/x', values: values(), bodyPreview: 'old answer' }]));
    const s = new UserStore('u', st);
    await s.addHistory(entry('b'));
    expect(st.data.get('rab-next:u:history')).not.toContain('old answer');
    expect((await s.history('a'))[0].id).toBe('old');
  });
});

describe('UserStore round two', () => {
  it('clearHistory keeps the other operations\' entries even when storage is nearly full', async () => {
    const st = new FakeStorage();
    const s = new UserStore('u', st);
    for (let i = 0; i < 6; i++) await s.addHistory(entry('op' + i, { url: '/rest/' + 'x'.repeat(40) }));
    const cleared = JSON.stringify(JSON.parse(st.data.get('rab-next:u:history')!).filter((e: { opKey: string }) => e.opKey !== 'op0'));
    st.setItem = (k, v) => {
      if (v.length >= cleared.length) throw new DOMException('full', 'QuotaExceededError');
      st.data.set(k, v);
    };
    await s.clearHistory('op0');
    expect(await s.history('op0')).toHaveLength(0);
    for (let i = 1; i < 6; i++) expect(await s.history('op' + i), 'op' + i).toHaveLength(1);
  });

  it('write() keeps halving the history while that makes it shorter, before keeping it in memory only', async () => {
    const st = new FakeStorage();
    const s = new UserStore('u', st);
    for (let i = 0; i < 8; i++) await s.addHistory(entry('op' + i, { url: '/rest/' + 'x'.repeat(50) }));
    const limit = (st.data.get('rab-next:u:history') ?? '').length / 3;   // room for about a third: halving once is not enough
    st.setItem = (k, v) => {
      if (v.length > limit) throw new DOMException('full', 'QuotaExceededError');
      st.data.set(k, v);
    };
    await s.addHistory(entry('new'));
    const stored = JSON.parse(st.data.get('rab-next:u:history')!);
    expect(stored[0].opKey).toBe('new');
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBeLessThanOrEqual(3);
    // nothing fits: memory only, still read back
    st.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    await s.addHistory(entry('mem'));
    expect(await s.history('mem')).toHaveLength(1);
  });

  it('does not hide or mark a secret that is only spaces', async () => {
    const s = new UserStore('u', new FakeStorage());
    const json = await s.addHistory(entry('a', { values: { ...values(), body: '{"user":"u","password":"  ","token":"\\t"}' } }));
    expect(json.values.body).toBe('{"user":"u","password":"  ","token":"\\t"}');
    expect(json.redacted).toBeUndefined();
    const form = await s.addHistory(entry('a', { values: { ...values(), contentType: 'application/x-www-form-urlencoded', body: 'user=u&password=+&os_password=&x=1' } }));
    expect(form.values.body).toBe('user=u&password=+&os_password=&x=1');
    expect(form.redacted).toBeUndefined();
  });

  it('hides the header words the echo added: jsessionid, oauth, csrf, xsrf, cookie2', () => {
    for (const n of ['JSESSIONID', 'X-JSESSIONID', 'X-OAuth-Scopes', 'oauth_consumer', 'X-CSRF', 'X-XSRF', 'Cookie2']) {
      expect(isCredentialHeader(n), n).toBe(true);
    }
    for (const n of ['X-Processor', 'X-Author-Id', 'X-Cookies-Enabled']) expect(isCredentialHeader(n), n).toBe(false);
  });

  it('scrubs secret form fields and never persists uploaded files in history', async () => {
    const st = new FakeStorage();
    const s = new UserStore('u', st);
    const file = new File(['hello'], 'secret.bin');
    const e = await s.addHistory(entry('a', {
      values: { ...values(), form: { name: ['alice'], password: ['hunter2'] }, files: { file: [file] } },
    }));
    expect(e.values.form).toEqual({ name: ['alice'] });
    expect(e.values.files).toBeUndefined();
    expect(e.redacted).toBe(true);
    expect([...st.data.values()].join('')).not.toContain('hunter2');
  });
});
