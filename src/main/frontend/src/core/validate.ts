import { isBlank } from './request';
import type { Param } from './types';

/** What the form shows beside a value: a warning, a check mark once it is fine, or nothing for an empty optional one. */
export type Check = { state: 'ok' | 'warn'; message: string } | null;

const WHOLE = /^[+-]?\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RANGES: Record<string, [bigint, bigint]> = {
  byte: [-128n, 127n],
  short: [-32768n, 32767n],
  int: [-2147483648n, 2147483647n],
  integer: [-2147483648n, 2147483647n],
  long: [-9223372036854775808n, 9223372036854775807n],
};
const DECIMAL = new Set(['double', 'float', 'number', 'bigdecimal']);
// A number as JSON writes it, a sign allowed: Number() would also take 0x10, 0b1 or Infinity, which Java does not.
const DECIMAL_TEXT = /^[+-]?[0-9]+(?:[.][0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
// The largest float; a double's range is what Number() reads without overflowing to Infinity.
const FLOAT_MAX = 3.4028234663852886e38;

const warn = (message: string): Check => ({ state: 'warn', message });

/**
 * The check of one value against what the catalog knows of its parameter: required, the Java type (whole numbers and
 * their range, decimals, booleans, UUIDs), the listed options, and the regex of its path template ("{mode: view|edit}").
 * A blank value is not filled in, as for the request (isBlank). A typed value is checked as it is sent, spaces
 * included.
 */
export function checkValue(p: Param, value: string, regex?: string): Check {
  // a path value has no default to fall back on (the URL needs the segment), and an empty default is none
  if (isBlank(value)) return p.required && (p.in === 'path' || !p.default) ? warn('Required') : null;
  const v = value.trim();
  const type = p.type.toLowerCase();
  const range = Object.prototype.hasOwnProperty.call(RANGES, type) ? RANGES[type] : undefined;
  const whole = !!range || type === 'biginteger';   // a BigInteger has no range
  const typed = whole || DECIMAL.has(type) || type === 'boolean' || type === 'uuid' || !!p.options?.length;
  // the request sends the value as typed: " 123 " is not a number to the server
  if (typed && v !== value) return warn('Leading or trailing spaces');
  if (whole) {
    if (!WHOLE.test(v)) return warn('Expected a whole number');
    const n = BigInt(v);
    if (range && (n < range[0] || n > range[1])) return warn(`Out of range for ${type} (${range[0]} to ${range[1]})`);
  } else if (DECIMAL.has(type)) {
    if (!DECIMAL_TEXT.test(v)) return warn('Expected a number');
    // a BigDecimal has no range: 1e400 is one
    const n = Math.abs(Number(v));
    if ((type === 'double' || type === 'number') && !Number.isFinite(n)) return warn(`Out of range for ${type} (about ±1.8e308)`);
    if (type === 'float' && n > FLOAT_MAX) return warn('Out of range for float (about ±3.4e38)');
  } else if (type === 'boolean') {
    if (v !== 'true' && v !== 'false') return warn('Expected true or false');
  } else if (type === 'uuid') {
    if (!UUID.test(v)) return warn('Expected a UUID (8-4-4-4-12 hex digits)');
  }
  if (p.options?.length && !p.options.includes(v)) return warn('Expected one of ' + p.options.join(', '));
  if (regex) {
    let re: RegExp | undefined;
    try {
      re = new RegExp('^(?:' + regex + ')$');
    } catch {
      // a Java-only construct: the server checks it
    }
    if (re && !re.test(value)) return warn('Must match ' + regex);
  }
  return { state: 'ok', message: p.required ? 'Filled in' : 'Will be sent' };
}
