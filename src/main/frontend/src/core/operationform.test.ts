import { describe, expect, it } from 'vitest';
import {
  checkAt, countFormWarnings, emptyDraft, regexOf, templateRegexes, tryBuild, valuesOf, withTemplateParams,
} from './operationform';
import type { Operation, Summary } from './types';

const summary: Summary = {
  format: 1,
  product: { name: 'Jira', version: '10', build: '1' },
  baseUrl: '/jira',
  hash: 'h1',
  complete: true,
  progress: { done: 1, total: 1 },
  admin: true,
  sysadmin: true,
  modules: [{ id: 'mod', path: 'api/2', origin: 'product', stability: 'supported', state: 'ok', opCount: 1, plugin: { key: 'k', name: 'n' } }],
};

const op: Operation = {
  key: 'mod:POST:issue/{key}/{mode}',
  module: 'mod',
  method: 'POST',
  path: 'issue/{key}/{mode: view|edit}',
  consumes: ['application/json'],
  produces: ['application/json'],
  params: [
    { name: 'key', in: 'path', type: 'string', required: true },
    { name: 'filter', in: 'query', type: 'int', required: false, repeating: true },
    { name: 'file', in: 'form', type: 'File', required: true },
  ],
};

describe('operationform', () => {
  it('adds missing template params, extracts template regexes, and counts warnings', () => {
    const params = withTemplateParams(op);
    expect(params.map((p) => p.name)).toContain('mode');
    const regexes = templateRegexes(op.path);
    expect(regexes).toEqual({ mode: 'view|edit' });
    expect(regexOf({ name: 'mode', in: 'query', type: 'string', required: false }, regexes)).toBeUndefined();

    const draft = emptyDraft(op);
    expect(countFormWarnings(params, draft.values, regexes)).toBe(3); // key, mode, file

    draft.values.path.key = 'PROJ-1';
    draft.values.path.mode = 'invalid';
    draft.values.form = { file: ['text-part'] };
    expect(countFormWarnings(params, draft.values, regexes)).toBe(1); // mode fails regex

    draft.values.path.mode = 'view';
    draft.values.query.filter = ['42', ''];
    expect(checkAt(params[1], '', 1, ['42', ''])).toBeNull();
    expect(valuesOf(params[0], draft.values)).toEqual(['PROJ-1']);
    expect(countFormWarnings(params, draft.values, regexes)).toBe(0);
  });

  it('builds requests or reports missing path params while keeping urlParts intact', () => {
    const draft = emptyDraft(op);
    const missing = tryBuild(summary, op, draft);
    expect(missing.request).toBeUndefined();
    expect(missing.error).toContain('Missing required path parameter');
    expect(missing.url).toContain('/jira/rest/api/2/issue/');

    draft.values.path = { key: 'ABC-1', mode: 'edit' };
    draft.custom = [{ name: 'X-Extra', value: 'yes' }];
    const ok = tryBuild(summary, op, draft);
    expect(ok.request?.headers['X-Extra']).toBe('yes');
  });
});
