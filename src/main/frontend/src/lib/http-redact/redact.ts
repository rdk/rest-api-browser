import { maskJson } from '../json-lines';

/**
 * Header, query/matrix/form parameter, URL and body credential redaction.
 * Synchronized strictly with EchoResource.java on the server.
 */

const HIDDEN = '"(hidden)"';

const SECRET_WORDS = new Set([
  'secret', 'secrets', 'password', 'passwords', 'passwd', 'pwd',
  'session', 'sessions', 'sessionid',
  'cookie', 'cookie2', 'set-cookie', 'set-cookie2',
  'api-key', 'api-keys', 'apikey', 'apikeys',
  'private-key', 'private-keys', 'privatekey', 'privatekeys',
  'signing-key', 'signing-keys', 'signingkey', 'signingkeys',
  'access-key', 'access-keys', 'accesskey', 'accesskeys',
  'secret-key', 'secret-keys', 'secretkey', 'secretkeys',
  'subscription-key', 'subscription-keys', 'subscriptionkey',
  'functions-key', 'functions-keys', 'functionskey',
  'master-key', 'master-keys', 'masterkey',
  'client-key', 'client-keys', 'clientkey',
  'session-key', 'session-keys', 'sessionkey',
  'auth-key', 'auth-keys', 'authkey',
  'encryption-key', 'encryption-keys', 'encryptionkey',
  'passkey', 'passkeys', 'hmac-key',
  'token', 'tokens', 'credential', 'credentials',
  'jwt', 'assertion', 'assertions', 'signature', 'signatures',
  'auth', 'authz', 'authorization', 'authn', 'bearer',
  'passphrase', 'passphrases', 'hmac', 'digest', 'otp', 'mfa',
  'cert', 'certs', 'certificate', 'certificates',
  'oidc', 'sso', 'saml', 'principal', 'jsessionid', 'oauth', 'csrf', 'xsrf',
]);

const SECRET_ENDINGS = [
  'token', 'tokens', 'secret', 'secrets', 'password', 'passwords', 'passwd',
  'apikey', 'apikeys', 'privatekey', 'signingkey', 'accesskey', 'secretkey',
  'subscriptionkey', 'functionskey', 'masterkey', 'clientkey', 'sessionkey', 'authkey',
  'passkey', 'credential', 'credentials', 'sessionid', 'signature', 'cookie', 'cookies',
  'bearer', 'passphrase', 'certificate', 'certificates',
];

const SECRET_COMPOUND_STEMS = [
  'token', 'secret', 'password', 'passwd', 'apikey', 'privatekey', 'accesskey',
  'signingkey', 'secretkey', 'subscriptionkey', 'functionskey', 'credential',
  'sessionid', 'jsessionid', 'setcookie', 'cookievalue', 'cookiedata', 'bearer', 'passphrase',
  'xsrf', 'csrf', 'saml', 'oidc', 'oauth', 'jwt',
  'authheader', 'webauth', 'clientcert', 'sslcert',
];

/**
 * Whether an HTTP header name identifies a credential or cookie (synchronized with `EchoResource.secret`).
 * `X-Atlassian-Token` is explicitly allowed so requests with `"no-check"` stay reproducible.
 */
export function isCredentialHeader(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (n === 'x-atlassian-token') return false;
  if (n === 'cookie' || n === 'cookie2' || n === 'set-cookie' || n === 'set-cookie2') return true;
  const words = n.split('-');
  return words.some((w, i) =>
    SECRET_WORDS.has(w)
    || (i + 1 < words.length && SECRET_WORDS.has(w + '-' + words[i + 1]))
    || SECRET_ENDINGS.some((e) => w.length > e.length && w.endsWith(e))
    || SECRET_COMPOUND_STEMS.some((stem) => w.includes(stem)),
  );
}

// Normalized parameter names that carry credentials directly.
const SECRET_PARAMS = new Set([
  'password', 'passwd', 'pwd', 'secret', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'apikey', 'apitoken',
  'atltoken', 'clientsecret', 'privatekey', 'signingkey', 'authorization', 'authcode', 'jwt', 'sessionid', 'jsessionid',
]);

/**
 * Whether a query, matrix or path parameter carries a credential by exact normalized name or `"*password"` / `"*secret"` suffix.
 * Keeps benign pagination/metadata names such as `author`, `pageToken`, `syncToken`, `os_username` visible.
 */
export function isCredentialParam(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  return SECRET_PARAMS.has(n) || n.endsWith('password') || n.endsWith('passwd') || n.endsWith('pwd') || n.endsWith('secret');
}

const SECRET_MEMBER_STEM = /(?:password|passwd|secret|token|apikey|credential|privatekey|signingkey|accesskey|subscriptionkey|functionskey|masterkey|clientkey|sessionkey|authkey|encryptionkey|passkey|bearer|cookie|session|jwt|passphrase|xsrf|csrf|authorization|authcode|authz|authn)/;
const SECRET_ANY_ENDING = /(?:password|passwords|passwd|pwd|secret|secrets|token|tokens|apikey|apikeys|credential|credentials|privatekey|privatekeys|signingkey|signingkeys|accesskey|accesskeys|authkey|authkeys|bearer|cookie|cookies|sessionid|sessionids|jsessionid|jwt|jwts|passphrase|passphrases|authorization|authcode)$/;

/** JSON/form body member whose scalar value should be redacted (`"password"`, `"myApiKey"`, `"bearer"`, `"myJwt"`, etc.). */
export function isSecretMember(name: string): boolean {
  if (isCredentialParam(name)) return true;
  const n = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  return SECRET_MEMBER_STEM.test(n);
}

/** JSON member whose non-string value (numbers, arrays, objects) should be replaced (`"passwords"`, `"apiKeys"`, `"tokens"`, etc., but NOT `"tokenCount"`). */
export function isSecretAny(name: string): boolean {
  if (isCredentialParam(name)) return true;
  const n = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  return SECRET_ANY_ENDING.test(n);
}

/** Patterns indicating plain-text (non-JSON, non-form) request body likely contains secrets. */
const SECRET_TEXT = /password|passwd|(?:^|[^a-z])pass\b|secret|token|api[-_]?key|private[-_]?key|credential|authorization|bearer\s+\S|cookie|sessionid|jsessionid|\bjwt\b/i;

function safeDecodeComponent(s: string, plusAsSpace = false): string {
  const input = plusAsSpace ? s.replace(/\+/g, ' ') : s;
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

/** Sanitizes a request body for client history persistence; never touches HTTP response payloads. */
export function cleanRequestBody(body: string, contentType: string | undefined): { body: string | undefined; redacted: boolean } {
  const trimmed = body.trimStart();
  const masked = (trimmed.startsWith('{') || trimmed.startsWith('['))
    ? maskJson(body, isSecretMember, HIDDEN, isSecretAny)
    : null;
  if (masked) {
    if (masked.masked) return { body: masked.text, redacted: true };
    if (trimmed.startsWith('[') && SECRET_TEXT.test(body)) return { body: undefined, redacted: true };
    return { body, redacted: false };
  }
  if (/x-www-form-urlencoded/i.test(contentType ?? '')) {
    let redacted = false;
    const pairs = body.split('&').map((pair) => {
      const eq = pair.indexOf('=');
      const n = safeDecodeComponent(eq < 0 ? pair : pair.slice(0, eq), true);
      if (eq < 0 || !isSecretMember(n) || !safeDecodeComponent(pair.slice(eq + 1), true).trim()) return pair;
      redacted = true;
      return pair.slice(0, eq + 1) + encodeURIComponent('(hidden)');
    });
    return { body: pairs.join('&'), redacted };
  }
  return SECRET_TEXT.test(body) ? { body: undefined, redacted: true } : { body, redacted: false };
}

/** Strips credential query and `;matrix=` parameters from a URL string. */
export function cleanUrlSecrets(url: string): { url: string; redacted: boolean } {
  const q0 = url.search(/[?#]/);
  const path = q0 < 0 ? url : url.slice(0, q0);
  const cleanPath = path.replace(/;([^;/?#=]*)(=[^;/?#]*)?/g, (m, name: string) =>
    isCredentialParam(safeDecodeComponent(name)) ? '' : m);
  let redacted = cleanPath !== path;
  if (redacted) url = cleanPath + (q0 < 0 ? '' : url.slice(q0));
  const q = url.indexOf('?');
  if (q < 0) return { url, redacted };
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  const pairs = query.split('&');
  const kept = pairs.filter((pair) => !isCredentialParam(safeDecodeComponent(pair.split('=')[0], true)));
  if (kept.length !== pairs.length) redacted = true;
  return { url: url.slice(0, q) + (kept.length ? '?' + kept.join('&') : '') + (hash < 0 ? '' : url.slice(hash)), redacted };
}
