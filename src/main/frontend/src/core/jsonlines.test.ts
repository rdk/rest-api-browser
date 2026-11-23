import { describe, expect, it } from 'vitest';
import { buildLines, find, formatJson, maskJson, visibleLines } from './jsonlines';

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

  it('rejects invalid unicode escapes', () => {
    expect(buildLines('"\\u00e9"')).not.toBeNull();
    expect(buildLines('"\\u12g4"')).toBeNull();
    expect(buildLines('"\\u12"')).toBeNull();
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
    const t3 = performance.now();
    expect(find(m, 'number 12345')).toHaveLength(1);
    expect(performance.now() - t3).toBeLessThan(200);
  });
});

// A small seeded generator, so the random documents are the same on every run.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHARS = ['a', 'Z', ' ', '"', '\\', '/', '\n', '\t', '\r', '\b', '\f', '\u{0}', '\u{1f}', '\u{7f}', 'é', 'ß', '漢', '😀', '\u{d800}', '\u{dfff}', '\u{2028}', ':', ',', '{', ']'];

function value(rnd: () => number, depth: number): unknown {
  const pick = <T,>(list: T[]) => list[Math.floor(rnd() * list.length)];
  const str = () => Array.from({ length: Math.floor(rnd() * 6) }, () => pick(CHARS)).join('');
  const kind = depth > 3 ? Math.floor(rnd() * 4) : Math.floor(rnd() * 6);
  if (kind === 0) return pick([true, false, null]);
  if (kind === 1) return pick([0, -1, 7, 1.5, -0.25, 1e21, 1e-7, 123456789012, 5e-324, 1.7976931348623157e308, rnd() * 1e6 - 5e5]);
  if (kind === 2 || kind === 3) return str();
  if (kind === 4) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(rnd, depth + 1));
  const o: Record<string, unknown> = {};
  for (let i = Math.floor(rnd() * 4); i > 0; i--) {
    const k = str();
    if (k !== '__proto__') o[k] = value(rnd, depth + 1);
  }
  return o;
}

describe('formatJson', () => {
  const samples: unknown[] = [
    {}, [], 0, -1.5, 1e21, 'x', '', true, false, null,
    { a: 1, b: [true, null, {}], c: { d: 'x' }, e: [] },
    [[[]], [{}], [[1, 2], [3]], [{ a: [] }]],
    { 'ключ': 'значение', emoji: '😀👍🏽', cjk: '漢字', combining: 'e\u{301}', separators: '\u{2028}\u{2029}' },
    { esc: 'quote " backslash \\ slash / nl \n tab \t cr \r bs \b ff \f ctl \u{1} \u{1f} del \u{7f}', lone: '\u{d800}', '"k"': 'v' },
    { nested: { deeper: { deepest: [1, { x: [] }] } }, 'a b': ':,{}[]', '2': 'two', '1': 'one' },
  ];

  it('gives what JSON.stringify(JSON.parse(text), null, 2) gives', () => {
    for (const v of samples) {
      const want = JSON.stringify(v, null, 2);
      for (const t of [JSON.stringify(v), JSON.stringify(v, null, 4), JSON.stringify(v, null, '\t').replace(/\n/g, '\r\n')]) {
        expect(formatJson(t), t).toBe(want);
        expect(formatJson(t), t).toBe(JSON.stringify(JSON.parse(t), null, 2));
      }
    }
  });

  it('agrees with JSON.stringify on random documents', () => {
    const rnd = random(42);
    for (let i = 0; i < 500; i++) {
      const t = JSON.stringify(value(rnd, 0));
      expect(formatJson(t), t).toBe(JSON.stringify(JSON.parse(t), null, 2));
    }
  });

  it('keeps numbers, key order, duplicate keys and escapes as written', () => {
    expect(formatJson('{"big":9007199254740993,"huge":1e400,"f":1.50,"neg":-0,"e":1E+2}')).toBe(
      '{\n  "big": 9007199254740993,\n  "huge": 1e400,\n  "f": 1.50,\n  "neg": -0,\n  "e": 1E+2\n}');
    expect(formatJson('{"b":1,"a":2,"b":3}')).toBe('{\n  "b": 1,\n  "a": 2,\n  "b": 3\n}');
    expect(formatJson('[ "\\u00e9\\/" , {"\\u0041":[ ]} ]')).toBe('[\n  "\\u00e9\\/",\n  {\n    "\\u0041": []\n  }\n]');
  });

  it('returns null for text that is not JSON', () => {
    for (const bad of ['', ' ', '{', '{"a":}', '[1,]', '{a:1}', '1 2', "{'a':1}", '[01]', 'NaN', '\u{feff}{}', '"\t"']) {
      expect(formatJson(bad), bad).toBeNull();
    }
  });
});

describe('maskJson second review', () => {
  it('leaves a secret that is only spaces alone', () => {
    expect(maskJson('{"a":" ","b":"\\t","c":"x"}', () => true, '"*"')).toEqual({ text: '{"a":" ","b":"\\t","c":"*"}', masked: 1 });
  });
});
