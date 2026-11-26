import { describe, expect, it } from 'vitest';
import type { OutlineItem } from '../lib/java-source';
import { fallbackJavaType, matchOutlineEndpoints } from './restoutline';
import { javaSourceZipPath } from './sourceexport';
import type { Module, Operation } from './types';

const makeMod = (id: string, path: string, pluginKey = 'plugin.a'): Module => ({
  id,
  path,
  origin: 'product',
  stability: 'supported',
  state: 'ok',
  opCount: 1,
  plugin: { key: pluginKey, name: pluginKey },
});

const makeOp = (key: string, module: string, method: string, path: string, deprecated = false): Operation => ({
  key,
  module,
  method,
  path,
  deprecated,
  consumes: [],
  produces: [],
  params: [],
});

describe('restoutline', () => {
  it('matches root-mounted modules with /rest prefix instead of dropping /rest', () => {
    const modules = new Map<string, Module>([['root:mod', makeMod('root:mod', '')]]);
    const ops = [
      makeOp('root:mod:GET:', 'root:mod', 'GET', ''),
      makeOp('root:mod:GET:health', 'root:mod', 'GET', '/health'),
    ];
    const outline: OutlineItem[] = [
      { kind: 'method', name: 'rootInfo', params: '()', returns: 'String', visibility: 'public', isStatic: false, httpMethod: 'GET', fullRestPath: '', line: 3, depth: 0 },
      { kind: 'method', name: 'health', params: '()', returns: 'String', visibility: 'public', isStatic: false, httpMethod: 'GET', fullRestPath: 'health', line: 5, depth: 0 },
    ];
    const matched = matchOutlineEndpoints(outline, ops, modules);
    expect(matched.get(3)?.fullPath).toBe('/rest');
    expect(matched.get(5)?.fullPath).toBe('/rest/health');
  });

  it('breaks ties by context operation, module, plugin, non-deprecated status, and focusMethod fallback', () => {
    const modules = new Map<string, Module>([
      ['p1:m1', makeMod('p1:m1', 'api/1', 'p1')],
      ['p2:m1', makeMod('p2:m1', 'api/2', 'p2')],
    ]);
    const ops = [
      makeOp('op:old', 'p1:m1', 'POST', 'ping', true),
      makeOp('op:active', 'p2:m1', 'POST', 'ping', false),
      makeOp('op:fallback', 'p2:m1', 'DELETE', 'custom/path'),
    ];
    const outline: OutlineItem[] = [
      { kind: 'method', name: 'ping', params: '()', returns: 'void', visibility: 'public', isStatic: false, httpMethod: 'POST', fullRestPath: 'ping', line: 10, depth: 0 },
      { kind: 'method', name: 'deleteCustom', params: '()', returns: 'void', visibility: 'public', isStatic: false, httpMethod: 'DELETE', line: 14, depth: 0 },
    ];

    const matched = matchOutlineEndpoints(outline, ops, modules, 'op:fallback', 'deleteCustom');
    expect(matched.get(10)?.op.key).toBe('op:active');
    expect(matched.get(14)?.op.key).toBe('op:fallback');
    expect(matched.get(14)?.fullPath).toBe('/rest/api/2/custom/path');
  });

  it('maps primitive/file parameter types and sanitizes ZIP paths', () => {
    expect(fallbackJavaType('String')).toBe('java.lang.String');
    expect(fallbackJavaType('integer')).toBe('java.lang.Integer');
    expect(fallbackJavaType('File')).toBe('com.atlassian.plugins.rest.api.multipart.FilePart');
    expect(fallbackJavaType('CustomDto')).toBe('CustomDto');
    expect(fallbackJavaType('unknown')).toBeUndefined();
    expect(javaSourceZipPath('com.example.Outer$Inner')).toBe('sources/com/example/Outer$Inner.java');
    expect(javaSourceZipPath('')).toBe('sources/Unknown.java');
  });
});
