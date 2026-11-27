package com.atlassian.labs.restbrowser.rest;

import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.CatalogTestSupport;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery;
import com.atlassian.labs.restbrowser.catalog.OperationDetails;
import com.atlassian.labs.restbrowser.catalog.OperationSource;
import com.atlassian.labs.restbrowser.catalog.OperationSourceTest;
import com.atlassian.labs.restbrowser.json.JsonParser;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.ws.rs.core.Response;
import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

public class CodeResourceTest {

    private final CatalogService catalog = mock(CatalogService.class);
    private final UserManager userManager = mock(UserManager.class);
    private final OperationDetails details = mock(OperationDetails.class);
    private final OperationSource source = new OperationSource(mock(ModuleDiscovery.class), () -> null);
    private final CodeResource resource = new CodeResource(catalog, userManager, details, source);
    private final HttpServletRequest request = mock(HttpServletRequest.class);

    @Before
    public void setUp() {
        UserKey admin = new UserKey("admin");
        when(userManager.getRemoteUserKey(request)).thenReturn(admin);
        when(userManager.isSystemAdmin(admin)).thenReturn(true);
    }

    @Test
    public void rejectsAnonymousAndNonSysadmin() {
        when(userManager.getRemoteUserKey(request)).thenReturn(null);
        assertEquals(401, resource.inspectClass(String.class.getName(), null, null, request).getStatus());

        UserKey user = new UserKey("user");
        when(userManager.getRemoteUserKey(request)).thenReturn(user);
        when(userManager.isSystemAdmin(user)).thenReturn(false);
        assertEquals(403, resource.inspectClass(String.class.getName(), null, null, request).getStatus());
    }

    @Test
    public void servesClassInfoSourcePlainTextGraphAndBatch() {
        String cls = OperationSourceTest.SampleResource.class.getName();

        Response info = resource.inspectClass(cls, null, null, request);
        assertEquals(200, info.getStatus());
        assertTrue(String.valueOf(info.getEntity()).contains("\"name\":\"" + cls + "\""));

        Response text = resource.decompileSource(cls, null, null, "class", "cfr", null, 1, 20, false, "text", request);
        assertEquals(200, text.getStatus());
        assertTrue(text.getMediaType().toString().startsWith("text/plain"));
        assertTrue(String.valueOf(text.getEntity()).contains("SampleResource"));

        Response graph = resource.traverseGraph(cls, null, null, 1, 10, false,
                "com.atlassian.labs.restbrowser.catalog", false, "cfr", request);
        assertEquals(200, graph.getStatus());
        assertTrue(String.valueOf(graph.getEntity()).contains("Greeting"));

        // batch requires X-Atlassian-Token: no-check before reading request body stream
        AtomicBoolean readAttempted = new AtomicBoolean();
        InputStream unread = new InputStream() {
            @Override public int read() { readAttempted.set(true); return -1; }
        };
        assertEquals(403, resource.batch(unread, request).getStatus());
        assertFalse("Must enforce XSRF before reading body stream", readAttempted.get());

        String body = "{\"classes\":[\"" + cls + "\"],\"includeSource\":false}";
        when(request.getHeader("X-Atlassian-Token")).thenReturn("no-check");
        Response batch = resource.batch(bytes(body), request);
        assertEquals(200, batch.getStatus());
        assertEquals("no-store", batch.getHeaderString("Cache-Control"));
        assertTrue(String.valueOf(batch.getEntity()).contains("\"count\":1"));

        // explicit ?format=json wins over Accept: text/plain
        when(request.getHeader("Accept")).thenReturn("text/plain");
        Response forcedJson = resource.decompileSource(cls, null, null, "class", "cfr", null, 1, 5, false, "json", request);
        assertEquals(200, forcedJson.getStatus());
        assertTrue(forcedJson.getMediaType().toString().startsWith("application/json"));
        when(request.getHeader("Accept")).thenReturn(null);

        // plugin endpoint validation
        assertEquals(400, resource.inspectPlugin("", request).getStatus());
        assertEquals(404, resource.inspectPlugin("com.example.missing", request).getStatus());

        // strict type & size validation in batch JSON returns 400
        assertEquals(400, resource.batch(bytes("{\"classes\":[\"a.B\"],\"maxLines\":99999999999999}"), request).getStatus());
        assertEquals(400, resource.batch(bytes("{\"classes\":[\"a.B\"],\"fromBundle\":1.9}"), request).getStatus());
        assertEquals(400, resource.batch(bytes("{\"classes\":[\"a.B\"],\"includeSource\":\"false\"}"), request).getStatus());
        assertEquals(400, resource.batch(bytes("{invalid"), request).getStatus());
        assertEquals(400, resource.batch(bytes("x".repeat(CodeResource.MAX_BATCH_BODY_BYTES + 1)), request).getStatus());

        // Accept negotiation respects q=0, invalid q=NaN/Infinity, and */* wildcard
        assertTrue(CodeResource.wantsPlainText("text/plain"));
        assertFalse(CodeResource.wantsPlainText("text/plain;q=0"));
        assertFalse(CodeResource.wantsPlainText("application/json, text/plain;q=0.5"));
        assertFalse(CodeResource.wantsPlainText("*/*, text/plain;q=0.5"));
        assertTrue(CodeResource.wantsPlainText("text/plain, */*;q=0.5"));
        assertFalse(CodeResource.wantsPlainText("text/plain;q=Infinity, application/json;q=1"));
        assertTrue(CodeResource.wantsPlainText("text/plain;q=0.5, application/json;q=NaN"));

        // search does not trigger catalog build
        Response searched = resource.searchClasses(cls, 5, null, request);
        assertEquals(200, searched.getStatus());
        org.mockito.Mockito.verifyZeroInteractions(catalog);
    }

    @Test
    @SuppressWarnings("unchecked")
    public void wave1AndWave2EndpointsWorkAndEnforceSysadminAuth() {
        String cls = OperationSourceTest.SampleResource.class.getName();
        String dtoCls = OperationSourceTest.Greeting.class.getName();

        // /code/class?view=compact omits refs and annotations; includes fields & metadata
        Response compact = resource.inspectClass(cls, null, null, "compact", null, request);
        assertEquals(200, compact.getStatus());
        Map<String, Object> compactMap = JsonParser.parseObject((String) compact.getEntity());
        assertFalse(compactMap.containsKey("refs"));
        assertTrue(compactMap.containsKey("fields"));

        Response classMd = resource.inspectClass(cls, null, null, "full", "markdown", request);
        assertEquals(200, classMd.getStatus());
        assertTrue(classMd.getMediaType().toString().contains("text/markdown"));
        assertTrue(((String) classMd.getEntity()).contains("# " + cls));

        // /code/source?lineNumbers=true&format=markdown
        Response srcMd = resource.decompileSource(cls, null, null, "class", "cfr", null, 1, 10, false, true, "markdown", request);
        assertEquals(200, srcMd.getStatus());
        assertTrue(srcMd.getMediaType().toString().contains("text/markdown"));
        assertTrue(((String) srcMd.getEntity()).contains(" 1 | "));

        // /code/graph?preset=domain
        Response domainGraph = resource.traverseGraph(cls, null, null, 1, 10, true, false, "domain",
                "com.atlassian.labs.restbrowser.catalog", false, "cfr", request);
        assertEquals(200, domainGraph.getStatus());
        assertTrue(((String) domainGraph.getEntity()).contains("Greeting"));

        // /code/schema JSON and Markdown
        Response schema = resource.inspectSchema(dtoCls, null, null, 3, true, null, request);
        assertEquals(200, schema.getStatus());
        Map<String, Object> schemaMap = (Map<String, Object>) CatalogTestSupport.parseJson((String) schema.getEntity());
        assertNotNull(schemaMap.get("schema"));
        assertNotNull(schemaMap.get("example"));

        Response schemaMd = resource.inspectSchema(dtoCls, null, null, 3, true, "markdown", request);
        assertEquals(200, schemaMd.getStatus());
        assertTrue(schemaMd.getMediaType().toString().contains("text/markdown"));
        assertTrue(((String) schemaMd.getEntity()).contains("### JSON Schema"));

        // /code/implementations, /code/callers, /code/grep (safe validation & non-OSGi fallback)
        Response impls = resource.findImplementations(cls, null, null, null, null, false, 10, request);
        assertEquals(200, impls.getStatus());
        assertEquals(cls, JsonParser.parseObject((String) impls.getEntity()).get("target"));

        Response callers = resource.findCallers(dtoCls, null, null, null, null, null, null, 10, request);
        assertEquals(200, callers.getStatus());
        assertEquals(dtoCls, JsonParser.parseObject((String) callers.getEntity()).get("target"));

        Response grepShort = resource.grepBytecode("a", null, null, null, false, true, 10, request);
        assertEquals(400, grepShort.getStatus());
        assertTrue(((String) grepShort.getEntity()).contains("\"hint\""));

        Response grepOk = resource.grepBytecode("hello", null, null, null, false, true, 10, request);
        assertEquals(200, grepOk.getStatus());
        assertEquals("hello", JsonParser.parseObject((String) grepOk.getEntity()).get("query"));

        // Heterogeneous POST /code/batch with items (including includeSchema & lineNumbers)
        when(request.getHeader("X-Atlassian-Token")).thenReturn("no-check");
        String batchItems = "{\"items\":["
                + "{\"class\":\"" + dtoCls + "\",\"includeSource\":false,\"includeSchema\":true},"
                + "{\"class\":\"" + cls + "\",\"includeSource\":true,\"lineNumbers\":true,\"startLine\":1,\"maxLines\":5}"
                + "]}";
        Response itemsResp = resource.batch(bytes(batchItems), request);
        assertEquals(200, itemsResp.getStatus());
        Map<String, Object> itemsMap = JsonParser.parseObject((String) itemsResp.getEntity());
        assertEquals(2L, itemsMap.get("count"));
        List<Map<String, Object>> results = (List<Map<String, Object>>) itemsMap.get("results");
        assertTrue(((Map<String, Object>) results.get(0).get("result")).containsKey("schema"));
        assertTrue(String.valueOf(((Map<String, Object>) results.get(1).get("result")).get("source")).contains("1 | "));

        // Invalid batch items payloads return 400
        assertEquals(400, resource.batch(bytes("{\"items\":[{}]}"), request).getStatus());
        assertEquals(400, resource.batch(bytes("{\"items\":\"bad\"}"), request).getStatus());

        // /code/operation forwarding (view=compact, lineNumbers, format=markdown)
        OperationSource mockSource = mock(OperationSource.class);
        when(mockSource.operationBundle(eq("m:GET:x"), eq("method"), eq("vineflower"), eq(details),
                eq(true), eq(1), eq(50), eq(true)))
                .thenReturn(new OperationDetails.Result(200,
                        "{\"format\":1,\"key\":\"m:GET:x\",\"details\":{},\"source\":{\"source\":\" 1 | ok\",\"startLine\":1,\"endLine\":1,\"totalLines\":1,\"decompiler\":\"Vineflower\",\"scope\":\"method\"}}"));
        CodeResource wired = new CodeResource(catalog, userManager, details, mockSource);
        Response opMd = wired.operationBundle("m:GET:x", "method", "vineflower", "compact", 1, 50, true, "markdown", request);
        assertEquals(200, opMd.getStatus());
        assertTrue(((String) opMd.getEntity()).contains("# Operation `m:GET:x`"));

        // Auth gates on all new Wave 2 endpoints
        when(userManager.getRemoteUserKey(request)).thenReturn(null);
        assertEquals(401, resource.inspectSchema(dtoCls, null, null, 3, true, null, request).getStatus());
        assertEquals(401, resource.findImplementations(cls, null, null, null, null, false, 10, request).getStatus());
        assertEquals(401, resource.grepBytecode("hello", null, null, null, false, true, 10, request).getStatus());
        assertEquals(401, resource.findCallers(dtoCls, null, null, null, null, null, null, 10, request).getStatus());

        UserKey nonAdmin = new UserKey("user");
        when(userManager.getRemoteUserKey(request)).thenReturn(nonAdmin);
        when(userManager.isSystemAdmin(nonAdmin)).thenReturn(false);
        assertEquals(403, resource.inspectSchema(dtoCls, null, null, 3, true, null, request).getStatus());
        assertEquals(403, resource.findImplementations(cls, null, null, null, null, false, 10, request).getStatus());
        assertEquals(403, resource.grepBytecode("hello", null, null, null, false, true, 10, request).getStatus());
        assertEquals(403, resource.findCallers(dtoCls, null, null, null, null, null, null, 10, request).getStatus());
        assertEquals(403, resource.inspectResource(1L, null, null, null, null, null, false, 10, null, request).getStatus());
        assertEquals(403, resource.context(bytes("{\"op\":\"m:GET:x\"}"), null, request).getStatus());
    }

    @Test
    @SuppressWarnings("unchecked")
    public void wave3OutlinesEtagResourceAndInvestigationContextWork() {
        String cls = OperationSourceTest.SampleResource.class.getName();

        // /code/class?outline=true returns bytecode outline + strong ETag + 304 on If-None-Match
        Response outlined = resource.inspectClass(cls, null, null, "full", true, false, null, request);
        assertEquals(200, outlined.getStatus());
        String etag = outlined.getHeaderString("ETag");
        assertNotNull(etag);
        Map<String, Object> outlinedMap = JsonParser.parseObject((String) outlined.getEntity());
        assertTrue(outlinedMap.get("outline") instanceof List);

        when(request.getHeader("If-None-Match")).thenReturn(etag);
        assertEquals(304, resource.inspectClass(cls, null, null, "full", true, false, null, request).getStatus());
        when(request.getHeader("If-None-Match")).thenReturn(null);

        // /code/plugin?view=compact + error stays no-store
        Response missingPlugin = resource.inspectPlugin("com.example.missing", "compact", request);
        assertEquals(404, missingPlugin.getStatus());
        assertEquals("no-store", missingPlugin.getHeaderString("Cache-Control"));

        // /code/graph?edgeKinds=signature
        Response edgeGraph = resource.traverseGraph(cls, null, null, 1, 10, false, false, null,
                "signature", "com.atlassian.labs.restbrowser.catalog", false, "cfr", request);
        assertEquals(200, edgeGraph.getStatus());
        Map<String, Object> graphMap = JsonParser.parseObject((String) edgeGraph.getEntity());
        List<Map<String, Object>> edges = (List<Map<String, Object>>) graphMap.get("edges");
        assertTrue(edges.stream().allMatch(e -> ((List<?>) e.get("kinds")).contains("signature")));

        // /code/resource validation & auth
        assertEquals(400, resource.inspectResource(null, null, null, null, null, null, false, 10, null, request).getStatus());
        assertEquals(404, resource.inspectResource(9999L, null, null, null, null, null, false, 10, null, request).getStatus());

        // /code/context XSRF, validation, and forwarding to OperationSource
        when(request.getHeader("X-Atlassian-Token")).thenReturn(null);
        assertEquals(403, resource.context(bytes("{\"url\":\"/rest/x\"}"), null, request).getStatus());
        when(request.getHeader("X-Atlassian-Token")).thenReturn("no-check");
        assertEquals(400, resource.context(bytes("{}"), null, request).getStatus());

        OperationSource mockSource = mock(OperationSource.class);
        when(mockSource.investigationContext(any(), eq("demo:GET:ping"), eq(null), eq(null),
                eq(200), eq(2), eq(true), eq(true), eq(true), eq(true), eq("vineflower"), eq(details)))
                .thenReturn(new OperationDetails.Result(200,
                        "{\"format\":1,\"key\":\"demo:GET:ping\",\"catalog\":{\"method\":\"GET\",\"fullPath\":\"demo/1/ping\"},\"dependencies\":[{\"field\":\"svc\",\"type\":\"x.Svc\",\"implementations\":[\"x.SvcImpl\"]}]}"));
        CodeResource wired = new CodeResource(catalog, userManager, details, mockSource);
        Response ctxMd = wired.context(
                bytes("{\"op\":\"demo:GET:ping\",\"maxLines\":200,\"schemaDepth\":2,\"format\":\"markdown\"}"),
                null, request);
        assertEquals(200, ctxMd.getStatus());
        assertTrue(ctxMd.getMediaType().toString().contains("text/markdown"));
        assertTrue(((String) ctxMd.getEntity()).contains("# Investigation Context `demo:GET:ping`"));

        // maxChars truncates large context Markdown cleanly
        OperationSource bigSource = mock(OperationSource.class);
        when(bigSource.investigationContext(any(), eq("demo:GET:ping"), eq(null), eq(null),
                eq(200), eq(2), eq(true), eq(true), eq(true), eq(true), eq("vineflower"), eq(details)))
                .thenReturn(new OperationDetails.Result(200,
                        "{\"format\":1,\"key\":\"demo:GET:ping\",\"catalog\":{\"method\":\"GET\",\"fullPath\":\"demo/1/ping\"},"
                                + "\"source\":{\"class\":\"x.Res\",\"scope\":\"method\",\"decompiler\":\"Vineflower\","
                                + "\"startLine\":1,\"endLine\":50,\"totalLines\":50,\"source\":\""
                                + ("int x = 1;\\n".repeat(45)) + "\"}}"));
        CodeResource wiredCap = new CodeResource(catalog, userManager, details, bigSource);
        Response cappedMd = wiredCap.context(
                bytes("{\"op\":\"demo:GET:ping\",\"maxLines\":200,\"schemaDepth\":2,\"format\":\"markdown\",\"maxChars\":250}"),
                null, request);
        assertEquals(200, cappedMd.getStatus());
        String cappedBody = (String) cappedMd.getEntity();
        assertTrue(cappedBody.length() <= 250);
        assertTrue(cappedBody.contains("truncated to 250 chars"));

        when(userManager.getRemoteUserKey(request)).thenReturn(null);
        assertEquals(401, resource.inspectResource(1L, null, null, null, null, null, false, 10, null, request).getStatus());
        assertEquals(401, resource.context(bytes("{\"op\":\"m:GET:x\"}"), null, request).getStatus());
    }

    private static InputStream bytes(String s) {
        return new ByteArrayInputStream(s.getBytes(StandardCharsets.UTF_8));
    }
}
