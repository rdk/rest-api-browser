import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildRequest } from './request';
import { createMatcher } from './routes';
import { buildRows, search } from './search';
import type { Index, Module, Operation, Param, Summary } from './types';

// The files are written by the backend's GoldenCatalogTest (src/test/java/.../catalog), so this checks that what the
// server really emits satisfies the shapes in types.ts and works with the core.
const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../../test/resources/catalog/${name}`, import.meta.url), 'utf8'));
const index = read('golden-index.json') as Index;
const summary = read('golden-summary.json') as Summary;

const isString = (v: unknown) => typeof v === 'string';
const isStringArray = (v: unknown) => Array.isArray(v) && v.every(isString);
const optional = (v: unknown, check: (x: unknown) => boolean) => v === undefined || check(v);

function checkParam(p: Param) {
  expect(isString(p.name) && p.name !== '').toBe(true);
  expect(['path', 'query', 'header', 'matrix', 'form']).toContain(p.in);
  expect(isString(p.type)).toBe(true);
  expect(typeof p.required).toBe('boolean');
  expect(optional(p.default, isString)).toBe(true);
  expect(optional(p.options, isStringArray)).toBe(true);
  expect(optional(p.repeating, (x) => typeof x === 'boolean')).toBe(true);
}

function checkOperation(op: Operation) {
  expect(isString(op.key)).toBe(true);
  expect(isString(op.module)).toBe(true);
  expect(isString(op.method)).toBe(true);
  expect(isString(op.path)).toBe(true);
  expect(op.path.startsWith('/')).toBe(false);
  expect(isStringArray(op.consumes)).toBe(true);
  expect(isStringArray(op.produces)).toBe(true);
  expect(Array.isArray(op.params)).toBe(true);
  op.params.forEach(checkParam);
  expect(optional(op.access, isString)).toBe(true);
  expect(optional(op.deprecated, (x) => typeof x === 'boolean')).toBe(true);
  expect(optional(op.bodyType, isString)).toBe(true);
}

function checkModule(m: Module) {
  expect(isString(m.id)).toBe(true);
  expect(isString(m.path)).toBe(true);
  expect(['product', 'bundled', 'user']).toContain(m.origin);
  expect(['supported', 'internal', 'app']).toContain(m.stability);
  expect(['ok', 'pending', 'failed']).toContain(m.state);
  expect(optional(m.source, isString)).toBe(true);
  expect(optional(m.reason, isString)).toBe(true);
  expect(typeof m.opCount).toBe('number');
  expect(isString(m.plugin.key) && isString(m.plugin.name)).toBe(true);
  expect(optional(m.plugin.version, isString)).toBe(true);
  expect(optional(m.error, isString)).toBe(true);
}

describe('golden catalog files from the backend', () => {
  it('the index satisfies the Index shape', () => {
    expect(index.format).toBe(1);
    expect(isString(index.hash)).toBe(true);
    expect(index.operations.length).toBeGreaterThan(0);
    index.operations.forEach(checkOperation);
  });

  it('the summary satisfies the Summary shape', () => {
    expect(summary.format).toBe(1);
    expect(summary.hash).toBe(index.hash);
    expect(typeof summary.complete).toBe('boolean');
    expect(typeof summary.admin).toBe('boolean');
    expect(summary.progress).toEqual({ done: 2, total: 2 });
    expect(isString(summary.baseUrl) && isString(summary.product.name)).toBe(true);
    expect(isString(summary.product.version) && isString(summary.product.build)).toBe(true);
    summary.modules.forEach(checkModule);
  });

  it('a non-admin summary has no versions or error details', () => {
    expect(summary.admin).toBe(false);
    for (const m of summary.modules) {
      expect(m.plugin.version).toBeUndefined();
      expect(m.error).toBeUndefined();
    }
  });

  it('every operation belongs to a module and the counts agree', () => {
    for (const m of summary.modules) {
      expect(index.operations.filter((o) => o.module === m.id)).toHaveLength(m.opCount);
    }
  });

  it('covers every kind of field', () => {
    const params = index.operations.flatMap((o) => o.params);
    expect(new Set(params.map((p) => p.in))).toEqual(new Set(['path', 'query', 'header', 'matrix', 'form']));
    expect(params.some((p) => p.options && p.options.length > 0)).toBe(true);
    expect(params.some((p) => p.repeating === true)).toBe(true);
    expect(params.some((p) => p.default !== undefined)).toBe(true);
    expect(index.operations.some((o) => o.deprecated === true)).toBe(true);
    expect(index.operations.some((o) => o.bodyType !== undefined)).toBe(true);
    expect(index.operations.some((o) => o.access !== undefined)).toBe(true);
  });

  it('buildRows and search work on them', () => {
    const rows = buildRows(summary, index);
    expect(rows).toHaveLength(index.operations.length);
    const hits = search(rows, 'watchers');
    expect(hits.map((r) => r.op.method)).toEqual(['DELETE']);
    expect(search(rows, 'issue', { methods: ['POST'] }).every((r) => r.op.method === 'POST')).toBe(true);
    expect(search(rows, 'issue', { supportedOnly: true })).toHaveLength(rows.length);
    expect(search(rows, 'example')).toHaveLength(0); // the failed module has no operations
  });

  it('createMatcher resolves the URL of an operation', () => {
    const matcher = createMatcher(summary, index);
    const m = matcher.match('http://localhost:2990/jira/rest/api/2/issue/PROJ-1/watchers?username=bob');
    expect(m?.op.method).toBe('DELETE');
    expect(m?.op.key).toBe('com.atlassian.jira.rest:v2-rest-api:DELETE:issue/{}/watchers');
    expect(m?.values).toEqual({ issueIdOrKey: 'PROJ-1' });
    expect(m?.query).toEqual({ username: ['bob'] });
    expect(matcher.match('http://localhost:2990/jira/rest/api/2/nothing/here')).toBeNull();
  });

  it('buildRequest builds the URL of an operation', () => {
    const op = index.operations.find((o) => o.key.endsWith(':GET:issue/{}'))!;
    const req = buildRequest(summary, op, {
      path: { issueIdOrKey: 'PROJ-1' },
      query: { fields: ['a', 'b'], expand: ['names'] },
      header: {},
      matrix: {},
    });
    expect(req.method).toBe('GET');
    expect(req.url).toBe('http://localhost:2990/jira/rest/api/2/issue/PROJ-1?fields=a&fields=b&expand=names');
    expect(req.headers['Accept']).toBe('application/json');
    expect(req.headers['X-Atlassian-Token']).toBeUndefined();

    const post = index.operations.find((o) => o.key.endsWith(':POST:issue'))!;
    const built = buildRequest(summary, post, { path: {}, query: {}, header: {}, matrix: {}, body: '{}' });
    expect(built.url).toBe('http://localhost:2990/jira/rest/api/2/issue');
    expect(built.headers['Content-Type']).toBe('application/json');
    expect(built.headers['X-Atlassian-Token']).toBe('no-check');
  });
});
