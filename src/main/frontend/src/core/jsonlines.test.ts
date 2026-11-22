import { describe, expect, it } from 'vitest';
import { buildLines, find, visibleLines } from './jsonlines';

const texts = (t: string) => buildLines(t)!.lines.map((l) => '  '.repeat(l.depth) + l.text);

describe('jsonlines', () => {
  it('pretty-prints with 2-space indent and fold ranges', () => {
    const m = buildLines('{"a":1,"b":[true,null,{}],"c":{"d":"x"},"e":[]}')!;
    expect(texts('{"a":1,"b":[true,null,{}],"c":{"d":"x"},"e":[]}')).toEqual([
      '{',
      '  "a": 1,',
      '  "b": [',
      '    true,',
      '    null,',
      '    {}',
      '  ],',
      '  "c": {',
      '    "d": "x"',
      '  },',
      '  "e": []',
      '}',
    ]);
    expect(m.lines[0].foldEnd).toBe(11);
    expect(m.lines[2].foldEnd).toBe(6);
    expect(m.lines[7].foldEnd).toBe(9);
    expect(m.lines[5].foldEnd).toBeUndefined();
  });

  it('handles scalars at the top level and keeps numbers and key order exactly', () => {
    expect(texts(' 42 ')).toEqual(['42']);
    expect(texts('"a\\"b"')).toEqual(['"a\\"b"']);
    expect(texts('{"2":1,"1":12345678901234567890.5e3}')).toEqual(['{', '  "2": 1,', '  "1": 12345678901234567890.5e3', '}']);
  });

  it('returns null for invalid JSON', () => {
    for (const bad of ['', '{', '{"a":}', '[1,]', '{"a":1,}', '[1 2]', '{a:1}', '1 2', '"abc', "{'a':1}", '[01]', 'tru', '{"a" 1}', '[1}']) {
      expect(buildLines(bad), bad).toBeNull();
    }
  });

  it('hides folded ranges', () => {
    const m = buildLines('{"a":[1,2],"b":3}')!;
    expect(visibleLines(m, new Set())).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(visibleLines(m, new Set([1]))).toEqual([0, 1, 5, 6]);
    expect(visibleLines(m, new Set([0]))).toEqual([0]);
    expect(visibleLines(m, new Set([2]))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('finds lines case-insensitively', () => {
    const m = buildLines('{"Name":"Alice","other":["ALICE","bob"]}')!;
    expect(find(m, 'alice')).toEqual([1, 3]);
    expect(find(m, '')).toEqual([]);
  });

  it('builds a ~5 MB document quickly', () => {
    const items = Array.from({ length: 30000 }, (_, i) => ({
      id: i,
      key: `PROJ-${i}`,
      self: `http://host/jira/rest/api/2/issue/${i}`,
      fields: { summary: `Summary number ${i} with some text`, labels: ['a', 'b', 'c'], nested: { x: 1.5, y: null, z: true } },
    }));
    const text = JSON.stringify({ issues: items });
    expect(text.length).toBeGreaterThan(4_000_000);
    const start = performance.now();
    const m = buildLines(text)!;
    const built = performance.now() - start;
    const t2 = performance.now();
    const vis = visibleLines(m, new Set([1]));
    const hits = find(m, 'number 29999');
    const rest = performance.now() - t2;
    console.log(`jsonlines: ${(text.length / 1e6).toFixed(1)} MB, ${m.lines.length} lines, build ${built.toFixed(0)} ms, visible+find ${rest.toFixed(0)} ms`);
    expect(m).not.toBeNull();
    expect(vis.length).toBe(3);
    expect(hits).toHaveLength(1);
    expect(built).toBeLessThan(3000);
  });
});
