import { describe, expect, it } from 'vitest';
import { createMatcher } from './routes';
import { buildRows, groupRows, matchUrlQuery, search } from './search';
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

describe('groupRows order', () => {
  it('puts supported modules first within an origin, then by path', () => {
    const ms = [
      module('b', 'a/1', { stability: 'internal' }),
      module('c', 'z/1', { stability: 'supported' }),
      module('d', 'b/1', { stability: 'supported' }),
      module('e', 'a/2', { origin: 'bundled', stability: 'supported' }),
    ];
    const sm = summary(ms);
    const out = groupRows(sm, buildRows(sm, index(ms.map((m) => op(m.id, 'GET', 'x')))));
    expect(out.map((r) => (r.kind === 'module' ? r.module.id : '')).filter(Boolean)).toEqual(['d', 'c', 'b', 'e']);
  });
});

describe('search', () => {
  it('ANDs tokens case-insensitively across method, path and plugin name', () => {
    expect(keys(search(rows, 'POST ISSUE'))).toEqual(['POST api/2/issue', 'POST my/1/issue/notify']);
    expect(search(rows, 'tempo issue')).toHaveLength(1);
    expect(search(rows, 'nothing here')).toHaveLength(0);
  });

  it('returns everything for an empty query', () => {
    expect(search(rows, '  ')).toHaveLength(ops.length);
  });

  it('an empty query keeps input order within each rank (stable partition)', () => {
    const out = search(rows, '');
    const ranks = out.map((r) => r.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    for (const rank of [0, 1, 2]) {
      expect(out.filter((r) => r.rank === rank)).toEqual(rows.filter((r) => r.rank === rank));
    }
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

describe('search and group review fixes', () => {
  it('orders the operations of one path by method when everything else ties', () => {
    const sm = summary([module('m', 'x/1')]);
    const r = buildRows(sm, index(['DELETE', 'OPTIONS', 'PUT', 'HEAD', 'GET', 'PATCH', 'POST'].map((m) => op('m', m, 'thing'))));
    expect(search(r, 'thing').map((x) => x.op.method)).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
  });

  it('leaves out failed and pending modules that are not supported when the list shows supported APIs only', () => {
    const ms = [
      module('ok', 'a/1'),
      module('f1', 'b/1', { state: 'failed' }),
      module('f2', 'd/1', { state: 'failed', stability: 'internal' }),
      module('p1', 'c/1', { state: 'pending', stability: 'app' }),
    ];
    const sm = summary(ms);
    const rs = buildRows(sm, index([op('ok', 'GET', 'x')]));
    const ids = (g: ReturnType<typeof groupRows>) => g.flatMap((x) => (x.kind === 'module' ? [x.module.id] : []));
    expect(ids(groupRows(sm, rs))).toEqual(['ok', 'f1', 'f2', 'p1']);
    expect(ids(groupRows(sm, rs, new Set(), {}))).toEqual(['ok', 'f1', 'f2', 'p1']);
    expect(ids(groupRows(sm, rs, new Set(), { supportedOnly: true }))).toEqual(['ok', 'f1']);
  });
});

describe('buildRows second review', () => {
  it('joins module and operation paths with one slash, none at the start; a root operation ends in one, as listed', () => {
    const sm = summary([module('m', '/api/2/')]);
    const r = buildRows(sm, index([op('m', 'GET', ''), op('m', 'GET', 'issue'), op('m', 'GET', '/project')]));
    expect(r.map((x) => x.path)).toEqual(['api/2/', 'api/2/issue', 'api/2/project']);
    // "/" lists every operation, the module's root one included
    expect(search(r, '/')).toHaveLength(3);
    expect(search(r, 'api/2/').map((x) => x.path)).toContain('api/2/');
  });

  it('matches operation summaries and ranks path segment hits above summary-only hits', () => {
    const sm = summary([module('m', 'api/2')]);
    const r = buildRows(sm, index([
      op('m', 'GET', 'serverInfo', { summary: 'Get general information about the server' }),
      op('m', 'GET', 'general/settings', { summary: 'System configuration' }),
    ]));
    const hits = search(r, 'general');
    expect(hits.map((x) => x.op.path)).toEqual(['general/settings', 'serverInfo']);
    expect(search(r, 'information server').map((x) => x.op.path)).toEqual(['serverInfo']);
  });

  it('indexes DTO types, access annotations, plugin keys, deprecated status, and matches pasted live REST URLs', () => {
    const sm = summary([module('jira:v2', 'api/2', { plugin: { key: 'com.atlassian.jira.rest', name: 'Jira REST' } })]);
    const idx = index([
      op('jira:v2', 'GET', 'issue/{issueIdOrKey}', {
        returnType: 'IssueBean',
        access: 'LicensedOnly',
        description: 'Returns a full issue representation',
      }),
      op('jira:v2', 'POST', 'issue/{issueIdOrKey}/comment', {
        bodyType: 'CommentJsonBean',
        returnType: 'CommentJsonBean',
        deprecated: true,
      }),
    ]);
    const r = buildRows(sm, idx);
    expect(search(r, 'IssueBean').map((x) => x.op.path)).toEqual(['issue/{issueIdOrKey}']);
    expect(search(r, 'LicensedOnly').map((x) => x.op.path)).toEqual(['issue/{issueIdOrKey}']);
    expect(search(r, 'com.atlassian.jira.rest')).toHaveLength(2);
    expect(search(r, 'deprecated').map((x) => x.op.path)).toEqual(['issue/{issueIdOrKey}/comment']);

    // Pasting a live URL matches the templated endpoint and extracts path + query values
    const matcher = createMatcher(sm, idx);
    const liveUrl = 'https://jira.example.com/jira/rest/api/2/issue/PROJ-42?expand=renderedFields';
    const matchedRows = search(r, liveUrl, {}, matcher);
    expect(matchedRows.map((x) => x.op.key)).toEqual(['jira:v2:GET:issue/{}']);
    const urlMap = matchUrlQuery(r, liveUrl, matcher);
    expect(urlMap.get('jira:v2:GET:issue/{}')).toMatchObject({
      values: { issueIdOrKey: 'PROJ-42' },
      query: { expand: ['renderedFields'] },
    });
  });

  it('matches all sibling HTTP methods, foreign context prefixes, relative URLs, and method filters', () => {
    const sm = summary([module('jira:v2', 'api/2')]);
    const idx = index([
      op('jira:v2', 'GET', 'issue/{issueIdOrKey}'),
      op('jira:v2', 'PUT', 'issue/{issueIdOrKey}'),
      op('jira:v2', 'DELETE', 'issue/{issueIdOrKey}'),
    ]);
    const r = buildRows(sm, idx);
    const matcher = createMatcher(sm, idx);

    // Bare path matches all sibling methods on that template, filtered by filters.methods
    const allSiblings = matchUrlQuery(r, '/other-ctx/rest/api/2/issue/PROJ-9', matcher);
    expect([...allSiblings.keys()]).toEqual([
      'jira:v2:GET:issue/{}',
      'jira:v2:PUT:issue/{}',
      'jira:v2:DELETE:issue/{}',
    ]);
    const putOnly = matchUrlQuery(r, 'api/2/issue/PROJ-9?fields=summary', matcher, { methods: ['PUT'] });
    expect([...putOnly.keys()]).toEqual(['jira:v2:PUT:issue/{}']);
    expect(putOnly.get('jira:v2:PUT:issue/{}')?.query).toEqual({ fields: ['summary'] });
  });
});
