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

import static org.junit.Assert.assertEquals;
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

        // batch requires X-Atlassian-Token: no-check
        String body = "{\"classes\":[\"" + cls + "\"],\"includeSource\":false}";
        assertEquals(403, resource.batch(body, request).getStatus());
        when(request.getHeader("X-Atlassian-Token")).thenReturn("no-check");
        Response batch = resource.batch(body, request);
        assertEquals(200, batch.getStatus());
        assertTrue(String.valueOf(batch.getEntity()).contains("\"count\":1"));
    }
}
