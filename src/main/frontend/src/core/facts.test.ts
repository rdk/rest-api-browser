import { describe, expect, it } from 'vitest';
import { accessFact, moduleFact, originLabel, paramSummary, rowTicks, sourceLabel, stabilityLabel } from './facts';
import type { Module, Operation } from './types';

const mod = (overrides: Partial<Module> = {}): Module => ({
  id: 'm1',
  path: 'api/2',
  origin: 'product',
  stability: 'supported',
  state: 'ok',
  opCount: 1,
  plugin: { key: 'k', name: 'Plugin' },
  ...overrides,
});

const op = (overrides: Partial<Operation> = {}): Operation => ({
  key: 'k1',
  module: 'm1',
  method: 'GET',
  path: 'issue',
  consumes: [],
  produces: [],
  params: [],
  ...overrides,
});

describe('facts', () => {
  it('maps access annotations case-insensitively and ignores Object.prototype keys', () => {
    expect(accessFact(undefined)).toBeUndefined();
    expect(accessFact('SystemAdminOnly')).toMatchObject({ tone: 'sysadmin', label: 'SystemAdminOnly' });
    expect(accessFact('customAccess')).toMatchObject({ tone: 'other', label: 'customAccess' });
    expect(accessFact('toString')).toMatchObject({ tone: 'other', label: 'toString' });
    expect(accessFact('constructor')).toMatchObject({ tone: 'other', label: 'constructor' });
  });

  it('derives module facts and omits default LicensedOnly tick from rowTicks', () => {
    const productInternal = mod({ stability: 'internal', origin: 'product' });
    expect(moduleFact(mod())).toMatchObject({ tone: 'supported', label: 'Supported' });
    expect(moduleFact(mod({ origin: 'user', stability: 'app' }))).toMatchObject({ tone: 'app', label: 'App' });
    expect(moduleFact(mod({ origin: 'bundled', stability: 'internal' }))).toMatchObject({ tone: 'bundled', label: 'Bundled' });
    expect(moduleFact(productInternal)).toBeUndefined();

    expect(rowTicks(op({ deprecated: true, access: 'LicensedOnly' }), mod(), true)).toEqual([
      expect.objectContaining({ tone: 'supported' }),
      { tone: 'deprecated', label: 'Deprecated' },
    ]);
    expect(rowTicks(op({ access: 'AdminOnly' }), mod(), false)).toEqual([
      expect.objectContaining({ tone: 'admin', label: 'AdminOnly' }),
    ]);
  });

  it('formats origin, stability, source, and parameter summary labels', () => {
    expect(originLabel(mod({ origin: 'product' }))).toBe('The product');
    expect(originLabel(mod({ origin: 'bundled' }))).toBe('App bundled with the product');
    expect(originLabel(mod({ origin: 'user' }))).toBe('Installed app');

    expect(stabilityLabel(mod({ stability: 'supported' }))).toBe('Supported public API');
    expect(stabilityLabel(mod({ stability: 'app' }))).toBe('App API');
    expect(stabilityLabel(mod({ stability: 'internal' }))).toBe('Internal API, may change');

    expect(sourceLabel(undefined)).toBeUndefined();
    expect(sourceLabel('jersey')).toBe('Jersey runtime model');
    expect(sourceLabel('wadl')).toBe('WADL');
    expect(sourceLabel('custom')).toBe('custom');

    expect(paramSummary(op({
      params: [
        { name: 'id', in: 'path', type: 'string', required: true },
        { name: 'expand', in: 'query', type: 'string', required: false },
        { name: 'fields', in: 'query', type: 'string', required: false },
      ],
    }))).toBe('1 path, 2 query');
  });
});
