import { describe, expect, it } from 'vitest';
import { buildRows, groupRows, search } from './search';
import { index, module, op, summary } from './fixtures';

const mods = [
  module('jira:api2', 'api/2'),
  module('tempo:rest', 'tempo-timesheets/4', { origin: 'bundled', stability: 'app', plugin: { key: 'tempo', name: 'Tempo' } }),
  module('my:rest', 'my/1', { origin: 'user', stability: 'internal', plugin: { key: 'my', name: 'My App' } }),
];
const ops = [
  op('jira:api2', 'GET', 'issue/{issueIdOrKey}'),
  op('jira:api2', 'POST', 'issue'),
  op('jira:api2', 'DELETE', 'issue/{issueIdOrKey}'),
  op('jira:api2', 'OPTIONS', 'issue'),
  op('jira:api2', 'GET', 'project'),
  op('tempo:rest', 'GET', 'issue-worklogs'),
  op('my:rest', 'POST', 'issue/notify'),
];
const s = summary(mods);
const rows = buildRows(s, index(ops));
const keys = (r: typeof rows) => r.map((x) => `${x.op.method} ${x.path}`);

describe('search', () => {
  it('ANDs tokens case-insensitively across method, path and plugin name', () => {
    expect(keys(search(rows, 'POST ISSUE'))).toEqual(['POST api/2/issue', 'POST my/1/issue/notify']);
    expect(search(rows, 'tempo issue')).toHaveLength(1);
    expect(search(rows, 'nothing here')).toHaveLength(0);
  });

  it('returns everything for an empty query', () => {
    expect(search(rows, '  ')).toHaveLength(ops.length);
  });

  it('ranks supported before internal before app', () => {
    const r = search(rows, 'issue');
    expect(r.map((x) => x.stability)).toEqual(['supported', 'supported', 'supported', 'supported', 'internal', 'app']);
  });

  it('ranks segment-start matches above mid-segment matches, then shorter path', () => {
    const extra = buildRows(
      summary([module('m', 'x/1')]),
      index([op('m', 'GET', 'a/subissue'), op('m', 'GET', 'a/issue/long/path'), op('m', 'GET', 'issue')]),
    );
    expect(search(extra, 'issue').map((r) => r.op.path)).toEqual(['issue', 'a/issue/long/path', 'a/subissue']);
  });

  it('filters supported only and methods, with OTHER', () => {
    expect(search(rows, '', { supportedOnly: true })).toHaveLength(5);
    expect(search(rows, '', { methods: ['GET'] })).toHaveLength(3);
    expect(search(rows, '', { methods: ['OTHER'] }).map((r) => r.op.method)).toEqual(['OPTIONS']);
    expect(search(rows, '', { methods: ['delete', 'OTHER'] })).toHaveLength(2);
  });

  it('is fast on 12,000 rows', () => {
    const big = Array.from({ length: 12000 }, (_, i) => op('jira:api2', i % 3 ? 'GET' : 'POST', `res${i % 500}/item/{id}/sub${i}`));
    const bigRows = buildRows(s, index(big));
    search(bigRows, 'warm up');
    const start = performance.now();
    const found = search(bigRows, 'item sub1');
    const ms = performance.now() - start;
    console.log(`search over 12k rows: ${ms.toFixed(2)} ms (${found.length} hits)`);
    expect(found.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(50);
  });
});

describe('groupRows', () => {
  it('orders modules by origin then path and operations by path then method', () => {
    const g = groupRows(s, rows);
    const labels = g.map((x) => (x.kind === 'module' ? `M ${x.module.path} ${x.count}` : `${x.op.method} ${x.op.path}`));
    expect(labels).toEqual([
      'M api/2 5',
      'POST issue',
      'OPTIONS issue',
      'GET issue/{issueIdOrKey}',
      'DELETE issue/{issueIdOrKey}',
      'GET project',
      'M tempo-timesheets/4 1',
      'GET issue-worklogs',
      'M my/1 1',
      'POST issue/notify',
    ]);
  });

  it('honours collapsed modules but keeps the count', () => {
    const g = groupRows(s, rows, new Set(['jira:api2']));
    expect(g[0]).toMatchObject({ kind: 'module', count: 5 });
    expect(g[1]).toMatchObject({ kind: 'module' });
    expect(g).toHaveLength(5);
  });
});
