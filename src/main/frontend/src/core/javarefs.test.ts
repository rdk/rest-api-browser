import { describe, expect, it } from 'vitest';
import { splitSourceLines, tokenizeSource } from './javatokens';
import {
  classLabel, createRefContext, fallbackJavaType, findMethodHeaderLine,
  linkSourceLine, linkSourceTokens, parseJavaTypeParts,
} from './javarefs';

describe('javarefs', () => {
  it('resolves simple types from imports and constant-pool refs, keeping generics unlinked', () => {
    const src = [
      'package com.example.rest;',
      'import jakarta.ws.rs.GET;',
      'import com.example.dto.Item;',
      '',
      'public class DemoResource {',
      '    @GET',
      '    public <T> Response get(Item item, String name) {',
      '        return Response.ok(item).build();',
      '    }',
      '}',
    ].join('\n');
    const spans = linkSourceTokens(
      tokenizeSource(src),
      src,
      'com.example.rest.DemoResource',
      ['jakarta.ws.rs.core.Response', 'jakarta.ws.rs.GET', 'com.example.dto.Item'],
    );
    expect(spans.map((s) => s.text).join('')).toBe(src);

    const byText = (txt: string) => spans.find((s) => s.text === txt);
    expect(byText('Item')?.target).toBe('com.example.dto.Item');
    expect(byText('Response')?.target).toBe('jakarta.ws.rs.core.Response');
    expect(byText('@GET')?.target).toBe('jakarta.ws.rs.GET');
    expect(byText('String')?.candidates).toContain('java.lang.String');
    expect(byText('T')?.target).toBeUndefined();
    // package declaration stays unlinked
    expect(spans.filter((s) => s.text === 'com' && s.target)).toHaveLength(0);
  });

  it('resolves nested types (Response.Status) and fully-qualified inline names', () => {
    const src = 'jakarta.ws.rs.core.Response.Status st = Response.Status.OK;';
    const spans = linkSourceTokens(
      tokenizeSource(src),
      src,
      'com.example.Demo',
      ['jakarta.ws.rs.core.Response', 'jakarta.ws.rs.core.Response$Status'],
    );
    expect(spans.map((s) => s.text).join('')).toBe(src);
    const linked = spans.filter((s) => s.target);
    expect(linked[0]).toMatchObject({ text: 'Response.Status', target: 'jakarta.ws.rs.core.Response.Status' });
    expect(linked[1]).toMatchObject({ text: 'Response.Status', target: 'jakarta.ws.rs.core.Response$Status' });
  });

  it('formats short tab labels cleanly for top-level and nested classes', () => {
    expect(classLabel('com.atlassian.jira.rest.v2.ServerInfoBean')).toBe('ServerInfoBean');
    expect(classLabel('jakarta.ws.rs.core.Response$Status')).toBe('Response.Status');
  });

  it('splits multiline block comments accurately and links single lines fast on large classes', () => {
    const body = Array.from({ length: 4000 }, (_, i) => `    private String field${i} = "val${i}";`).join('\n');
    const src = [
      'package com.example;',
      'import com.example.dto.Widget;',
      '/* multiline',
      ' * Widget in comment should not link',
      ' */',
      'public class Huge {',
      body,
      '    public Widget build() { return new Widget(); }',
      '}',
    ].join('\n');
    const t0 = performance.now();
    const { lines, inComment } = splitSourceLines(src);
    const ctx = createRefContext(src, 'com.example.Huge', ['com.example.dto.Widget']);
    expect(inComment[3]).toBe(true);
    expect(inComment[5]).toBe(false);
    // line inside comment stays comment without class link
    expect(linkSourceLine(lines[3], inComment[3], ctx).filter((s) => s.target)).toHaveLength(0);
    // method line links Widget accurately
    const methodSpans = linkSourceLine(lines[lines.length - 2], inComment[lines.length - 2], ctx);
    expect(methodSpans.find((s) => s.text === 'Widget')?.target).toBe('com.example.dto.Widget');
    expect(performance.now() - t0).toBeLessThan(250);
  });

  it('finds the first line of the method declaration header, distinguishing overloads', () => {
    const lines = [
      'public class IssueResource {',
      '    // public Response getIssue(String id) in comment',
      '    @GET',
      '    public Response getIssue(String id) {',
      '        return getIssue(id, null);',
      '    }',
      '',
      '    @GET',
      '    public Response getIssue(',
      '        String id,',
      '        List<String> fields',
      '    ) {',
      '        return null;',
      '    }',
      '}',
    ];
    expect(findMethodHeaderLine(lines, 'getIssue')).toBe(3);
    expect(findMethodHeaderLine(lines, 'getIssue', 1)).toBe(3);
    expect(findMethodHeaderLine(lines, 'getIssue', 2)).toBe(8);
    expect(findMethodHeaderLine(lines, 'missing')).toBe(-1);
  });

  it('parses generic Java type expressions into clickable parts and maps parameter shorthands', () => {
    const parts = parseJavaTypeParts('java.util.Map<java.lang.String, com.example.Foo$Bar>');
    expect(parts.map((p) => p.text).join('')).toBe('Map<String, Foo.Bar>');
    expect(parts.filter((p) => p.fqcn).map((p) => p.fqcn)).toEqual([
      'java.util.Map',
      'java.lang.String',
      'com.example.Foo$Bar',
    ]);
    expect(parseJavaTypeParts('int').filter((p) => p.fqcn)).toEqual([]);
    expect(fallbackJavaType('string')).toBe('java.lang.String');
    expect(fallbackJavaType('File')).toBe('com.atlassian.plugins.rest.api.multipart.FilePart');
  });
});
