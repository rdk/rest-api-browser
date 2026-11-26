package com.atlassian.labs.restbrowser.rest;

import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery;
import com.atlassian.labs.restbrowser.catalog.OperationDetails;
import com.atlassian.labs.restbrowser.catalog.OperationSource;
import com.atlassian.labs.restbrowser.catalog.OperationSourceTest;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.ws.rs.core.Response;
import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
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

    private static InputStream bytes(String s) {
        return new ByteArrayInputStream(s.getBytes(StandardCharsets.UTF_8));
    }
}
