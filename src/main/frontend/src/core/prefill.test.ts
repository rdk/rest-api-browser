import { describe, expect, it } from 'vitest';
import { emptyDraft } from './operationform';
import { issueBody, prefill } from './prefill';
import type { Operation } from './types';

const op: Operation = {
  key: 'mod:POST:items/{itemId}',
  module: 'mod',
  method: 'POST',
  path: 'items/{itemId}/{extra}',
  consumes: ['application/x-www-form-urlencoded'],
  produces: ['application/json'],
  params: [
    { name: 'itemId', in: 'path', type: 'string', required: true },
    { name: 'expand', in: 'query', type: 'string', required: false },
    { name: 'title', in: 'form', type: 'string', required: false },
    { name: 'X-Tenant', in: 'header', type: 'string', required: false },
  ],
};

describe('prefill', () => {
  it('fills only declared params/templates and strips credential headers', () => {
    const base = emptyDraft(op);
    const filled = prefill(op, base, {
      op: op.key,
      path: { itemId: '42', extra: 'ok', rogue: 'drop' },
      q: { expand: ['fields'], undeclared: ['drop'] },
      form: { title: ['hello'], secretField: ['drop'] },
      h: {
        'x-tenant': 'acme',
        Authorization: 'Basic secret',
        Cookie: 'JSESSIONID=1',
        'X-Custom': 'visible',
      },
    });
    expect(filled.values.path).toEqual({ itemId: '42', extra: 'ok' });
    expect(filled.values.query).toEqual({ expand: ['fields'] });
    expect(filled.values.form).toEqual({ title: ['hello'] });
    expect(filled.values.header).toEqual({ 'X-Tenant': 'acme' });
    expect(filled.custom).toEqual([{ name: 'X-Custom', value: 'visible' }]);
  });

  it('leaves draft untouched when op key differs and formats issueBody', () => {
    const base = emptyDraft(op);
    expect(prefill(op, base, { op: 'other', path: { itemId: '1' }, q: {}, h: {} })).toBe(base);
    expect(issueBody('4.3.0', 'Jira 10')).toContain('REST API Browser 4.3.0, new UI, on Jira 10');
  });
});
