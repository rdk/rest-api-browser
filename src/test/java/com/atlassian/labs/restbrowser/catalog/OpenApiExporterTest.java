package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.OperationSpec;
import com.atlassian.labs.restbrowser.catalog.Model.Param;
import com.atlassian.labs.restbrowser.catalog.Model.State;
import com.atlassian.labs.restbrowser.json.JsonParser;
import com.atlassian.labs.restbrowser.rest.OpenApiResource;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.UrlMode;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.core.Response;
import org.junit.Test;

import java.util.List;
import java.util.Map;

import static org.junit.Assert.*;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

public class OpenApiExporterTest {

    @Test
    @SuppressWarnings("unchecked")
    public void selfSpecRespectsSysadminFilterAndEmitsOpenApi31() {
        Map<String, Object> licensedOnly = JsonParser.parseObject(
                OpenApiExporter.selfSpecJson("https://example.test/jira/", "4.3.3-SNAPSHOT", false));
        assertEquals("3.1.0", licensedOnly.get("openapi"));
        Map<String, Object> licensedPaths = (Map<String, Object>) licensedOnly.get("paths");
        assertTrue(licensedPaths.containsKey("/catalog/brief"));
        assertTrue(licensedPaths.containsKey("/catalog/operations"));
        assertTrue(licensedPaths.containsKey("/catalog/openapi"));
        assertTrue(licensedPaths.containsKey("/openapi"));
        assertTrue(licensedPaths.containsKey("/mcp"));
        assertFalse(licensedPaths.containsKey("/code/context"));
        assertFalse(licensedPaths.containsKey("/code/resource"));
        assertFalse(licensedPaths.containsKey("/code/class"));

        Map<String, Object> briefGet = (Map<String, Object>) ((Map<String, Object>) licensedPaths.get("/catalog/brief")).get("get");
        List<Map<String, Object>> briefParams = (List<Map<String, Object>>) briefGet.get("parameters");
        assertEquals("integer", ((Map<String, Object>) briefParams.get(0).get("schema")).get("type"));

        Map<String, Object> sysadmin = JsonParser.parseObject(
                OpenApiExporter.selfSpecJson("https://example.test/jira/", "4.3.3-SNAPSHOT", true));
        Map<String, Object> adminPaths = (Map<String, Object>) sysadmin.get("paths");
        assertTrue(adminPaths.containsKey("/code/context"));
        assertTrue(adminPaths.containsKey("/code/resource"));
        assertTrue(adminPaths.containsKey("/code/class"));
        assertTrue(adminPaths.containsKey("/catalog/refresh"));
        Map<String, Object> ctxPost = (Map<String, Object>) ((Map<String, Object>) adminPaths.get("/code/context")).get("post");
        List<Map<String, Object>> ctxParams = (List<Map<String, Object>>) ctxPost.get("parameters");
        Map<String, Object> maxCharsParam = ctxParams.stream()
                .filter(p -> "maxChars".equals(p.get("name")))
                .findFirst().orElseThrow();
        assertEquals("integer", ((Map<String, Object>) maxCharsParam.get("schema")).get("type"));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void openApiResourcePathAvoidsDotJsonAndSupportsEtag() {
        Path path = OpenApiResource.class.getAnnotation(Path.class);
        assertNotNull(path);
        assertEquals("/openapi", path.value());

        ApplicationProperties appProps = mock(ApplicationProperties.class);
        when(appProps.getBaseUrl(UrlMode.CANONICAL)).thenReturn("https://example.test/jira");
        PluginAccessor accessor = mock(PluginAccessor.class);
        UserManager users = mock(UserManager.class);
        HttpServletRequest req = mock(HttpServletRequest.class);
        UserKey alice = new UserKey("alice");
        when(users.getRemoteUserKey(req)).thenReturn(alice);
        when(users.isLicensed(alice)).thenReturn(true);

        OpenApiResource resource = new OpenApiResource(appProps, accessor, users);
        Response first = resource.spec(req);
        assertEquals(200, first.getStatus());
        String etag = first.getHeaderString("ETag");
        assertNotNull(etag);
        Map<String, Object> body = JsonParser.parseObject((String) first.getEntity());
        assertEquals("3.1.0", body.get("openapi"));
        Map<String, Object> paths = (Map<String, Object>) body.get("paths");
        assertTrue(paths.containsKey("/openapi"));

        HttpServletRequest cachedReq = mock(HttpServletRequest.class);
        when(users.getRemoteUserKey(cachedReq)).thenReturn(alice);
        when(cachedReq.getHeader("If-None-Match")).thenReturn(etag);
        Response notModified = resource.spec(cachedReq);
        assertEquals(304, notModified.getStatus());
    }

    @Test
    @SuppressWarnings("unchecked")
    public void moduleSpecExportsPathsParamsFormBodiesAndHandlesUnknownModule() {
        ModuleEntry m1 = new ModuleEntry("demo", "demo/1", "product", "supported", "jersey", State.ok,
                null, null, 2, "com.example.demo", "Demo Plugin", "2.1.0");
        Operation op1 = new Operation("demo:GET:item/{id}", "demo",
                new OperationSpec("GET", "item/{id}", List.of(), List.of("application/json"),
                        List.of(
                                new Param("id", "path", "long", true, null, List.of(), false, "Item id", "java.lang.Long"),
                                new Param("expand", "query", "string", false, "all", List.of("all", "none"), true)),
                        "LicensedOnly", true, null, "Fetch item", "Loads one item",
                        null, "ItemDto", "com.example.ItemDto"));
        Operation op2 = new Operation("demo:POST:item", "demo",
                new OperationSpec("POST", "item", List.of("application/x-www-form-urlencoded"), List.of("application/json"),
                        List.of(new Param("title", "form", "string", true, null, List.of(), false)),
                        "AdminOnly", false, null, "Create item", null,
                        null, null, null));

        CatalogSnapshot snap = CatalogTestSupport.snapshot(List.of(m1), List.of(op1, op2), true, "4.3.3-SNAPSHOT");
        assertNull(OpenApiExporter.moduleSpecJson(snap, "missing", "/jira", false, 2, null));

        Map<String, Object> spec = JsonParser.parseObject(
                OpenApiExporter.moduleSpecJson(snap, "demo", "/jira", false, 2, null));
        assertEquals("3.1.0", spec.get("openapi"));
        assertEquals("demo", spec.get("x-module"));
        Map<String, Object> paths = (Map<String, Object>) spec.get("paths");
        Map<String, Object> getItem = (Map<String, Object>) ((Map<String, Object>) paths.get("/demo/1/item/{id}")).get("get");
        assertEquals(Boolean.TRUE, getItem.get("deprecated"));
        assertEquals("demo:GET:item/{id}", getItem.get("x-operation-key"));
        List<Map<String, Object>> params = (List<Map<String, Object>>) getItem.get("parameters");
        assertEquals(2, params.size());

        Map<String, Object> postItem = (Map<String, Object>) ((Map<String, Object>) paths.get("/demo/1/item")).get("post");
        assertNotNull(postItem.get("requestBody"));
    }
}
