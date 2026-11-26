import { describe, expect, it } from 'vitest';
import {
  annotationTokens, classLabel, createRefContext, extractAnnotationClassMap, extractClassOutline,
  findEnclosingOutlineLine, findMethodHeaderLine, linkAnnotationTokens, linkSourceLine, linkSourceTokens,
  normalizeRestPath, parseJavaTypeParts, splitSourceLines, tokenizeSource,
} from '../lib/java-source';
import { fallbackJavaType, matchOutlineEndpoints } from './restoutline';
import { shortJava } from './details';
import type { Module, Operation } from './types';

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

  it('extracts class outline (constructors, methods, nested types, REST HTTP methods) with exact 0-based line numbers', () => {
    const lines = [
      'package com.example;',
      'public class ServerInfoResource {',
      '    private final String version;',
      '    public ServerInfoResource(String version) {',
      '        this.version = version;',
      '    }',
      '    @GET',
      '    @Path("info")',
      '    public Response getServerInfo(@QueryParam("doHealthCheck") boolean check) {',
      '        if (check) { return null; }',
      '        return Response.ok().build();',
      '    }',
      '    @jakarta.ws.rs.POST',
      '    @Consumes("application/json")',
      '    public Response createItem(String body) { return null; }',
      '    @DELETE public void remove(@PathParam("id") long id) {}',
      '    public static class Helper {',
      '        private void run() {}',
      '    }',
      '}',
    ];
    const outline = extractClassOutline(lines);
    expect(outline).toEqual([
      { kind: 'ctor', name: 'ServerInfoResource', params: '(String)', returns: '', visibility: 'public', isStatic: false, line: 3, depth: 0 },
      { kind: 'method', name: 'getServerInfo', params: '(boolean)', returns: 'Response', visibility: 'public', isStatic: false, httpMethod: 'GET', restPath: 'info', fullRestPath: 'info', line: 8, depth: 0 },
      { kind: 'method', name: 'createItem', params: '(String)', returns: 'Response', visibility: 'public', isStatic: false, httpMethod: 'POST', line: 14, depth: 0 },
      { kind: 'method', name: 'remove', params: '(long)', returns: 'void', visibility: 'public', isStatic: false, httpMethod: 'DELETE', line: 15, depth: 0 },
      { kind: 'type', name: 'Helper', params: '', returns: 'class', visibility: 'public', isStatic: true, line: 16, depth: 0 },
      { kind: 'method', name: 'run', params: '()', returns: 'void', visibility: 'private', isStatic: false, line: 17, depth: 1 },
    ]);
  });

  it('marks class and method/constructor declaration names as bold decl spans without bolding calls', () => {
    const src = [
      'package com.example;',
      'public class ServerInfoResource extends BaseResource {',
      '    public ServerInfoResource(String v) {',
      '        super(v);',
      '    }',
      '    @GET',
      '    public <T> List<T> getServerInfo(String id) {',
      '        Class<?> c = ServerInfoResource.class;',
      '        String x = helper(id);',
      '        if (id != null) return Response.ok(x).build();',
      '        return null;',
      '    }',
      '    private static class Inner implements Runnable {',
      '        public void run() {}',
      '    }',
      '}',
    ].join('\n');
    const spans = linkSourceTokens(tokenizeSource(src), src, 'com.example.ServerInfoResource', []);
    expect(spans.map((s) => s.text).join('')).toBe(src);
    const decls = spans.filter((s) => s.decl).map((s) => `${s.decl}:${s.text}`);
    expect(decls).toEqual([
      'type:ServerInfoResource',
      'method:ServerInfoResource',
      'method:getServerInfo',
      'type:Inner',
      'method:run',
    ]);
  });

  it('preserves REST HTTP method across multiline OpenAPI annotations containing array braces', () => {
    const lines = [
      '@Path("serverInfo")',
      '@Produces({"application/json"})',
      'public class ServerInfoResource {',
      '    @GET',
      '    @AnonymousAllowed',
      '    @Operation(',
      '        summary = "Get info",',
      '        responses = {',
      '            @ApiResponse(',
      '                responseCode = "200",',
      '                content = {@Content(mediaType = "application/json")}',
      '            )',
      '        }',
      '    )',
      '    public Response getServerInfo(@QueryParam("doHealthCheck") boolean check) {',
      '        return Response.ok().build();',
      '    }',
      '}',
    ];
    const outline = extractClassOutline(lines);
    expect(outline).toEqual([
      { kind: 'method', name: 'getServerInfo', params: '(boolean)', returns: 'Response', visibility: 'public', isStatic: false, httpMethod: 'GET', fullRestPath: 'serverInfo', line: 14, depth: 0 },
    ]);
  });

  it('matches decompiled REST endpoint methods to catalog operations preferring the current module', () => {
    const lines = [
      '@Path("/issue")',
      'public class IssueResource {',
      '    @GET',
      '    @Path("/{issueIdOrKey: [^/]+}")',
      '    public Response getIssue(@PathParam("issueIdOrKey") String key) { return null; }',
      '    @POST',
      '    public Response createIssue(String body) { return null; }',
      '}',
    ];
    const outline = extractClassOutline(lines);
    expect(normalizeRestPath('/issue/{issueIdOrKey: [^/]+}/')).toBe('issue/{}');
    const modV2 = { id: 'jira:v2', path: 'api/2', plugin: { key: 'jira', name: 'Jira' } } as unknown as Module;
    const modLatest = { id: 'jira:latest', path: 'api/latest', plugin: { key: 'jira', name: 'Jira' } } as unknown as Module;
    const modules = new Map<string, Module>([['jira:v2', modV2], ['jira:latest', modLatest]]);
    const ops: Operation[] = [
      { key: 'jira:latest:GET:issue/{}', module: 'jira:latest', method: 'GET', path: 'issue/{id}', consumes: [], produces: [], params: [] },
      { key: 'jira:v2:GET:issue/{}', module: 'jira:v2', method: 'GET', path: 'issue/{issueIdOrKey}', consumes: [], produces: [], params: [] },
      { key: 'jira:v2:POST:issue', module: 'jira:v2', method: 'POST', path: 'issue', consumes: [], produces: [], params: [] },
    ];
    const matched = matchOutlineEndpoints(outline, ops, modules, 'jira:v2:GET:issue/{}');
    expect(matched.get(4)).toMatchObject({ op: ops[1], fullPath: '/rest/api/2/issue/{issueIdOrKey}' });
    expect(matched.get(6)).toMatchObject({ op: ops[2], fullPath: '/rest/api/2/issue' });
  });

  it('extracts outline methods from CFR-style multiline class headers (extends/implements on next lines) and inline annotations', () => {
    const lines = [
      '/*',
      ' * Decompiled with CFR 0.152.',
      ' */',
      'package com.example;',
      '',
      '@Path("usage")',
      '@Produces(value={"application/json"})',
      'public class UsageResource',
      'extends AbstractResource',
      'implements Serializable {',
      '    @Inject public UsageResource(',
      '        ServiceA a,',
      '        ServiceB b',
      '    ) {',
      '        super();',
      '    }',
      '    @GET',
      '    @Path("/api-usage")',
      '    public final Response getRestUsageInfo(@QueryParam("pluginKey") String arg0) {',
      '        return Response.ok().build();',
      '    }',
      '}',
    ];
    const outline = extractClassOutline(lines);
    expect(outline).toEqual([
      { kind: 'ctor', name: 'UsageResource', params: '(ServiceA, ServiceB)', returns: '', visibility: 'public', isStatic: false, line: 10, depth: 0 },
      { kind: 'method', name: 'getRestUsageInfo', params: '(String)', returns: 'Response', visibility: 'public', isStatic: false, httpMethod: 'GET', restPath: '/api-usage', fullRestPath: 'usage/api-usage', line: 18, depth: 0 },
    ]);
  });

  it('handles empty single-line nested types, multiline records, type-use annotations, and nested generic type params', () => {
    const lines = [
      '@Metadata(mv={1, 9, 0}, d1={"\\u0000\\n"})',
      'public final class KotlinResource',
      'extends BaseResource {',
      '    public record EmptyKey(String a, int b) {}',
      '    public record Multi(',
      '        String key,',
      '        int count',
      '    ) implements Comparable<Multi> {',
      '        public int compareTo(Multi other) { return 0; }',
      '    }',
      '    @GET',
      '    public final @NotNull Response getInfo(@QueryParam("id") @Nullable String id) {',
      '        return Response.ok().build();',
      '    }',
      '    public static <T extends Comparable<T>> List<@NotNull T> sortItems(List<T> items) {',
      '        return items;',
      '    }',
      '}',
    ];
    const outline = extractClassOutline(lines);
    expect(outline).toEqual([
      { kind: 'type', name: 'EmptyKey', params: '', returns: 'record', visibility: 'public', isStatic: false, line: 3, depth: 0 },
      { kind: 'type', name: 'Multi', params: '', returns: 'record', visibility: 'public', isStatic: false, line: 4, depth: 0 },
      { kind: 'method', name: 'compareTo', params: '(Multi)', returns: 'int', visibility: 'public', isStatic: false, line: 8, depth: 1 },
      { kind: 'method', name: 'getInfo', params: '(String)', returns: 'Response', visibility: 'public', isStatic: false, httpMethod: 'GET', line: 11, depth: 0 },
      { kind: 'method', name: 'sortItems', params: '(List<T>)', returns: 'List<T>', visibility: 'public', isStatic: true, line: 14, depth: 0 },
    ]);
  });

  it('links nested OpenAPI annotations and implementation class literals in Method view', () => {
    const raw = '@io.swagger.v3.oas.annotations.responses.ApiResponses({'
      + '@io.swagger.v3.oas.annotations.responses.ApiResponse('
      + 'content=@io.swagger.v3.oas.annotations.media.Content('
      + 'array=@io.swagger.v3.oas.annotations.media.ArraySchema('
      + 'schema=@io.swagger.v3.oas.annotations.media.Schema(implementation=com.example.usage.RestUsageInfoResponse.class)), '
      + 'mediaType="application/json"), description="A JSON response for com.fake.InString.class", responseCode="200")})';
    const classMap = extractAnnotationClassMap(raw);
    expect(classMap.get('RestUsageInfoResponse')).toBe('com.example.usage.RestUsageInfoResponse');
    expect(classMap.get('Schema')).toBe('io.swagger.v3.oas.annotations.media.Schema');
    expect(classMap.get('ArraySchema')).toBe('io.swagger.v3.oas.annotations.media.ArraySchema');
    expect(classMap.get('InString')).toBeUndefined();

    // Short display mode
    const shortSpans = linkAnnotationTokens(annotationTokens(shortJava(raw), 80), classMap);
    expect(shortSpans.find((s) => s.text === 'RestUsageInfoResponse')?.target).toBe('com.example.usage.RestUsageInfoResponse');
    expect(shortSpans.find((s) => s.text === '@Schema')?.target).toBe('io.swagger.v3.oas.annotations.media.Schema');
    expect(shortSpans.find((s) => s.text === '@ApiResponse')?.target).toBe('io.swagger.v3.oas.annotations.responses.ApiResponse');

    // Full names display mode
    const fullSpans = linkAnnotationTokens(annotationTokens(raw, 80), classMap);
    expect(fullSpans.find((s) => s.text === 'RestUsageInfoResponse')?.target).toBe('com.example.usage.RestUsageInfoResponse');
    expect(fullSpans.find((s) => s.text === '@io.swagger.v3.oas.annotations.media.Schema')?.target)
      .toBe('io.swagger.v3.oas.annotations.media.Schema');
  });

  it('ignores header comments before imports, ignores static wildcard for types, avoids annotation regex ReDoS, and stops qualified chains at methods', () => {
    const headerSrc = [
      '/* License { header } */',
      'package com.example;',
      'import static com.example.Const.*;',
      'import com.example.dto.Item;',
      'public class C {',
      '    Item x = com.example.dto.Item.create();',
      '    // @Path("ignored")',
      '    @GET @Path("real")',
      '    public void deepIndentedMethod(@Ann(")") String s) {}',
      '}',
    ].join('\n');
    const ctx = createRefContext(headerSrc, 'com.example.C');
    expect(ctx.wildcards).toEqual([]);
    expect(ctx.explicit.get('Item')).toBe('com.example.dto.Item');
    const spans = linkSourceTokens(tokenizeSource(headerSrc), headerSrc, 'com.example.C');
    expect(spans.some((s) => s.text === 'create' && s.target)).toBe(false);
    expect(spans.some((s) => s.text === 'Item' && s.target === 'com.example.dto.Item')).toBe(true);

    const outline = extractClassOutline(headerSrc.split('\n'));
    expect(outline).toEqual([
      { kind: 'method', name: 'deepIndentedMethod', params: '(String)', returns: 'void', visibility: 'public', isStatic: false, httpMethod: 'GET', restPath: 'real', fullRestPath: 'real', line: 8, depth: 0 },
    ]);

    const t0 = performance.now();
    const evilAnn = '@pkg.' + 'A$'.repeat(120) + 'End';
    extractAnnotationClassMap(evilAnn);
    expect(performance.now() - t0).toBeLessThan(25);
  });

  it('handles nested regex quantifiers in normalizeRestPath, multiline Spring array mappings, text-block exits, and block-comment closing lines', () => {
    expect(normalizeRestPath('/issue/{id: [0-9]{1,3}}/x/')).toBe('issue/{}/x');

    const lines = [
      '@Path("/root")',
      'public class TextAndSpringResource {',
      '    @GetMapping(',
      '        value = {"/items/{id: [0-9]{1,3}}"}',
      '    )',
      '    public String items() {',
      '        String q = """',
      '            { "notAMethod": true }',
      '            public void fake() {}',
      '            """;',
      '        return q;',
      '    }',
      '    /* comment */ public void afterBlockComment() {}',
      '    /* multi',
      '       line */ public void sameLineAfterClose() {}',
      '    public void afterTextBlock() {}',
      '}',
    ];
    // Clean single-line @Path multiline form separately
    const multilinePathLines = [
      '@Path(',
      '    "/root"',
      ')',
      'public class Rooted {',
      '    @GetMapping(',
      '        "/ping"',
      '    )',
      '    public String ping() { return "ok"; }',
      '}',
    ];
    expect(extractClassOutline(multilinePathLines)).toEqual([
      { kind: 'method', name: 'ping', params: '()', returns: 'String', visibility: 'public', isStatic: false, httpMethod: 'GET', restPath: '/ping', fullRestPath: 'root/ping', line: 7, depth: 0 },
    ]);

    const outline = extractClassOutline(lines);
    expect(outline.map((o) => ({ name: o.name, httpMethod: o.httpMethod, restPath: o.restPath, line: o.line }))).toEqual([
      { name: 'items', httpMethod: 'GET', restPath: '/items/{id: [0-9]{1,3}}', line: 5 },
      { name: 'afterBlockComment', httpMethod: undefined, restPath: undefined, line: 12 },
      { name: 'sameLineAfterClose', httpMethod: undefined, restPath: undefined, line: 14 },
      { name: 'afterTextBlock', httpMethod: undefined, restPath: undefined, line: 15 },
    ]);
    expect(findMethodHeaderLine(lines, 'sameLineAfterClose')).toBe(14);
    expect(findMethodHeaderLine(lines, 'fake')).toBe(-1);

    const textBlockExitLines = [
      'public class Tb {',
      '    public void first() {',
      '        String s = """',
      '            body',
      '            """; }',
      '    public void afterTextClose() {}',
      '}',
    ];
    expect(extractClassOutline(textBlockExitLines).map((o) => o.name)).toEqual(['first', 'afterTextClose']);
    expect(findMethodHeaderLine(textBlockExitLines, 'afterTextClose')).toBe(5);
    expect(findMethodHeaderLine(['String q = """', '""" public void inlineAfterClose() {}'], 'inlineAfterClose')).toBe(1);
    const tbSrc = textBlockExitLines.join('\n');
    const tbSplit = splitSourceLines(tbSrc);
    const tbCtx = createRefContext(tbSrc, 'Tb');
    const insideSpans = linkSourceLine(tbSplit.lines[3], tbSplit.inComment[3], tbCtx, tbSplit.inTextBlock[3]);
    expect(insideSpans.filter((s) => s.target)).toHaveLength(0);
    const exitSpans = linkSourceLine('""" + Helper.make()', false, tbCtx, true);
    expect(exitSpans.some((s) => s.kind === 'str' && s.text === '"""')).toBe(true);
    expect(exitSpans.some((s) => s.target && s.text === 'Helper')).toBe(true);
  });

  it('links all-caps nested classes (Outer.DTO), normalizes CRLF, reuses ScannedSource, and handles uppercase/C-array params and package-private ctors', () => {
    const crlf = [
      'package com.example;',
      'public class Outer {',
      '    Outer(String ID, int matrix[]) {',
      '    }',
      '    strictfp double compute(double X) {',
      '        Outer.DTO dto = null;',
      '        return X;',
      '    }',
      '}',
    ].join('\r\n');
    const scanned = splitSourceLines(crlf);
    expect(scanned.lines.every((l) => !l.includes('\r'))).toBe(true);

    const outline = extractClassOutline(scanned);
    expect(outline).toEqual([
      { kind: 'ctor', name: 'Outer', params: '(String, int[])', returns: '', visibility: 'package', isStatic: false, line: 2, depth: 0 },
      { kind: 'method', name: 'compute', params: '(double)', returns: 'double', visibility: 'package', isStatic: false, line: 4, depth: 0 },
    ]);
    expect(findMethodHeaderLine(scanned, 'Outer', 2)).toBe(2);
    expect(findMethodHeaderLine(scanned, 'compute', 1)).toBe(4);
    expect(findEnclosingOutlineLine(outline, 1)).toBe(-1);
    expect(findEnclosingOutlineLine(outline, 3)).toBe(2);
    expect(findEnclosingOutlineLine(outline, 6)).toBe(4);

    const spans = linkSourceTokens(
      tokenizeSource(scanned.lines.join('\n')),
      scanned.lines.join('\n'),
      'com.example.Outer',
      ['com.example.Outer$DTO'],
    );
    expect(spans.find((s) => s.text === 'Outer.DTO')?.target).toBe('com.example.Outer$DTO');
  });

  it('does not confuse static enum constants like HttpMethod.GET with imported annotations and includes nested types in enclosing outline lookup', () => {
    const src = [
      'package com.example;',
      'import jakarta.ws.rs.GET;',
      'import com.example.HttpMethod;',
      'public class Client {',
      '    public void call() { send(HttpMethod.GET); }',
      '    public static class Nested {',
      '        int x;',
      '    }',
      '}',
    ].join('\n');
    const ctx = createRefContext(src, 'com.example.Client', ['com.example.HttpMethod', 'jakarta.ws.rs.GET']);
    const callSpans = linkSourceLine('    public void call() { send(HttpMethod.GET); }', false, ctx);
    expect(callSpans.filter((s) => s.target && s.text.includes('GET'))).toEqual([]);
    expect(callSpans.find((s) => s.text === 'HttpMethod')?.target).toBe('com.example.HttpMethod');
    expect(linkSourceTokens(tokenizeSource(src), src, 'com.example.Client', ['com.example.HttpMethod', 'jakarta.ws.rs.GET'])
      .some((s) => s.target?.includes('HttpMethod$GET'))).toBe(false);

    const outline = extractClassOutline(splitSourceLines(src));
    const nestedLine = outline.find((o) => o.kind === 'type' && o.name === 'Nested')!.line;
    expect(findEnclosingOutlineLine(outline, nestedLine + 1)).toBe(nestedLine);
  });
});
