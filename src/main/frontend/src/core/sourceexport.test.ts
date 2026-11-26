import { describe, expect, it } from 'vitest';
import { buildSourceArchive, buildSourceExportItem } from './sourceexport';

describe('sourceexport', () => {
  it('computes outline line numbers from the formatted text when pretty mode is enabled', () => {
    const raw = [
      'package com.example;',
      '@Path("/demo")',
      'public class Demo {',
      '  @GET',
      '  @ApiResponses({@ApiResponse(content=@Content(array=@ArraySchema(schema=@Schema(implementation=String.class)), mediaType="application/json"), description="OK", responseCode="200")})',
      '  @Path("/ping")',
      '  public String ping(@QueryParam("a") String a, @QueryParam("b") String b) {',
      '    return a;',
      '  }',
      '}',
    ].join('\n');
    const seenPaths = new Set<string>();
    const item = buildSourceExportItem(
      { uid: 't1', id: 'com.example.Demo', label: 'Demo', candidates: ['com.example.Demo'] },
      { format: 1, class: 'com.example.Demo', decompiler: 'Vineflower', source: raw },
      { pretty: true, decompiler: 'vineflower', seenPaths },
    );

    const exportedLines = (item.entry.data as string).trimEnd().split('\n');
    const pingMeta = item.meta.outline.find((o) => o.name === 'ping');
    expect(pingMeta).toBeDefined();
    expect(pingMeta!.httpMethod).toBe('GET');
    expect(pingMeta!.line).toBeGreaterThan(raw.split('\n').length); // pretty annotation expansion shifted line numbers
    expect(exportedLines[pingMeta!.line - 1]).toContain('ping(');
    expect(item.meta.totalLines).toBe(exportedLines.length);
  });

  it('deduplicates colliding zip paths cleanly without stacking suffixes and handles trailing newline line counts', () => {
    const seenPaths = new Set<string>();
    const tab = { uid: 't1', id: 'a.Foo', label: 'Foo', candidates: ['a.Foo'] };
    const src = { format: 1 as const, class: 'a.Foo', decompiler: 'CFR', source: 'class Foo {\n}\n' };
    const i1 = buildSourceExportItem(tab, src, { pretty: false, decompiler: 'cfr', seenPaths });
    const i2 = buildSourceExportItem(tab, src, { pretty: false, decompiler: 'cfr', seenPaths });
    const i3 = buildSourceExportItem(tab, src, { pretty: false, decompiler: 'cfr', seenPaths });
    expect(i1.entry.name).toBe('sources/a/Foo.java');
    expect(i2.entry.name).toBe('sources/a/Foo_2.java');
    expect(i3.entry.name).toBe('sources/a/Foo_3.java');
    expect(i1.meta.totalLines).toBe(2);

    const zip = buildSourceArchive([i1.entry], [i1.meta], { decompiler: 'cfr', tabCount: 1, exportedAt: '2026-11-25T10:00:00Z' });
    expect(zip.filename).toBe('decompiled-classes-20261125-100000Z.zip');
    expect(zip.bytes[0]).toBe(0x50); // 'P'
    expect(zip.bytes[1]).toBe(0x4b); // 'K'
  });
});
