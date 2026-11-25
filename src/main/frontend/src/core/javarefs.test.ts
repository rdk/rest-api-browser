import { describe, expect, it } from 'vitest';
import { tokenizeSource } from './javatokens';
import { classLabel, linkSourceTokens } from './javarefs';

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
});
