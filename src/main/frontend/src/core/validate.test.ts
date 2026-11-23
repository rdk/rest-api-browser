import { describe, expect, it } from 'vitest';
import { checkValue } from './validate';
import type { Param } from './types';

const param = (over: Partial<Param>): Param => ({ name: 'p', in: 'query', type: 'string', required: false, ...over });

describe('checkValue', () => {
  it('warns about an empty required value and nothing about an empty optional one', () => {
    expect(checkValue(param({ in: 'path', required: true }), '  ')).toEqual({ state: 'warn', message: 'Required' });
    expect(checkValue(param({}), '')).toBeNull();
    expect(checkValue(param({ required: true, default: '5' }), '')).toBeNull();
    expect(checkValue(param({ in: 'path', required: true, default: '' }), '')?.state).toBe('warn');
    expect(checkValue(param({ in: 'path', required: true, default: '7' }), '')?.state).toBe('warn');
    expect(checkValue(param({ in: 'path', required: true }), 'X-1')?.state).toBe('ok');
  });

  it('checks whole numbers and their range', () => {
    expect(checkValue(param({ type: 'int' }), '12')?.state).toBe('ok');
    expect(checkValue(param({ type: 'int' }), '1.5')?.message).toBe('Expected a whole number');
    expect(checkValue(param({ type: 'int' }), '2147483648')?.state).toBe('warn');
    expect(checkValue(param({ type: 'long' }), '2147483648')?.state).toBe('ok');
    expect(checkValue(param({ type: 'long' }), '9223372036854775808')?.state).toBe('warn');
  });

  it('checks decimals, booleans, UUIDs and options', () => {
    expect(checkValue(param({ type: 'double' }), '1e3')?.state).toBe('ok');
    expect(checkValue(param({ type: 'double' }), 'abc')?.state).toBe('warn');
    expect(checkValue(param({ type: 'boolean' }), 'yes')?.state).toBe('warn');
    expect(checkValue(param({ type: 'UUID' }), '123e4567-e89b-12d3-a456-426614174000')?.state).toBe('ok');
    expect(checkValue(param({ type: 'UUID' }), '123')?.state).toBe('warn');
    expect(checkValue(param({ options: ['A', 'B'] }), 'C')?.message).toBe('Expected one of A, B');
  });

  it('checks the regex of a path template, and ignores one JavaScript cannot read', () => {
    expect(checkValue(param({ in: 'path', required: true }), 'view', 'view|edit')?.state).toBe('ok');
    expect(checkValue(param({ in: 'path', required: true }), 'viewx', 'view|edit')?.message).toBe('Must match view|edit');
    expect(checkValue(param({ in: 'path', required: true }), 'x', '\\p{javaLowerCase}+(')?.state).toBe('ok');
  });

  it('warns about spaces around a typed value, which is sent as typed', () => {
    expect(checkValue(param({ type: 'int' }), ' 123 ')?.message).toBe('Leading or trailing spaces');
    expect(checkValue(param({ type: 'Long', in: 'path', required: true }), '5 ')?.state).toBe('warn');
    expect(checkValue(param({ type: 'double' }), '1.5 ')?.state).toBe('warn');
    expect(checkValue(param({ type: 'boolean' }), ' true')?.state).toBe('warn');
    expect(checkValue(param({ type: 'UUID' }), '123e4567-e89b-12d3-a456-426614174000 ')?.state).toBe('warn');
    expect(checkValue(param({ options: ['A', 'B'] }), 'A ')?.state).toBe('warn');
    expect(checkValue(param({ type: 'int' }), '123')?.state).toBe('ok');
    expect(checkValue(param({}), ' a b ')?.state).toBe('ok');   // a plain string may hold spaces
  });
});

