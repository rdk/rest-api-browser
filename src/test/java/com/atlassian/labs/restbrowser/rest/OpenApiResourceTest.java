package com.atlassian.labs.restbrowser.rest;

import com.atlassian.annotations.security.LicensedOnly;
import com.atlassian.labs.restbrowser.json.JsonParser;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.plugin.PluginInformation;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.UrlMode;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.core.Response;
import org.junit.Before;
import org.junit.Test;

import java.util.List;
import java.util.Map;

import static org.junit.Assert.*;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

public class OpenApiResourceTest {

    private final ApplicationProperties props = mock(ApplicationProperties.class);
    private final PluginAccessor plugins = mock(PluginAccessor.class);
    private final UserManager users = mock(UserManager.class);
    private final HttpServletRequest request = mock(HttpServletRequest.class);
    private OpenApiResource resource;

    @Before
    public void setUp() {
        Plugin own = mock(Plugin.class);
        PluginInformation info = mock(PluginInformation.class);
        when(plugins.getPlugin("com.atlassian.labs.rest-api-browser")).thenReturn(own);
        when(own.getPluginInformation()).thenReturn(info);
        when(info.getVersion()).thenReturn("4.4.0");
        when(props.getBaseUrl(UrlMode.CANONICAL)).thenReturn("https://example.test/jira");
        when(props.getBaseUrl(UrlMode.RELATIVE)).thenReturn("/jira");
        resource = new OpenApiResource(props, plugins, users);
    }

    @Test
    public void rejectsAnonymousAndUnlicensedUsers() {
        assertEquals("/openapi", OpenApiResource.class.getAnnotation(Path.class).value());
        assertTrue(OpenApiResource.class.isAnnotationPresent(LicensedOnly.class));

        Response anon = resource.spec(request);
        assertEquals(401, anon.getStatus());
        assertEquals("no-store", anon.getHeaderString("Cache-Control"));

        UserKey portal = new UserKey("portal");
        when(users.getRemoteUserKey(request)).thenReturn(portal);
        when(users.isLicensed(portal)).thenReturn(false);
        Response unlicensed = resource.spec(request);
        assertEquals(403, unlicensed.getStatus());
        assertEquals("no-store", unlicensed.getHeaderString("Cache-Control"));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void servesRoleFilteredOpenApi31SpecWithEtagCachingAndRelativeFallback() {
        UserKey dev = new UserKey("dev");
        when(users.getRemoteUserKey(request)).thenReturn(dev);
        when(users.isLicensed(dev)).thenReturn(true);
        when(users.isSystemAdmin(dev)).thenReturn(false);

        Response devResp = resource.spec(request);
        assertEquals(200, devResp.getStatus());
        String etag = devResp.getHeaderString("ETag");
        assertNotNull(etag);
        assertEquals("private, no-cache", devResp.getHeaderString("Cache-Control"));

        Map<String, Object> devSpec = JsonParser.parseObject((String) devResp.getEntity());
        assertEquals("3.1.0", devSpec.get("openapi"));
        Map<String, Object> info = (Map<String, Object>) devSpec.get("info");
        assertEquals("4.4.0", info.get("version"));
        List<Map<String, Object>> servers = (List<Map<String, Object>>) devSpec.get("servers");
        assertEquals("https://example.test/jira/rest/restbrowser/1", servers.get(0).get("url"));

        Map<String, Object> devPaths = (Map<String, Object>) devSpec.get("paths");
        assertTrue(devPaths.containsKey("/catalog"));
        assertTrue(devPaths.containsKey("/openapi"));
        assertTrue(devPaths.containsKey("/mcp"));
        assertFalse(devPaths.containsKey("/code/context"));

        // Conditional request returns 304 Not Modified
        HttpServletRequest cachedReq = mock(HttpServletRequest.class);
        when(users.getRemoteUserKey(cachedReq)).thenReturn(dev);
        when(users.isLicensed(dev)).thenReturn(true);
        when(users.isSystemAdmin(dev)).thenReturn(false);
        when(cachedReq.getHeader("If-None-Match")).thenReturn(etag);
        Response notModified = resource.spec(cachedReq);
        assertEquals(304, notModified.getStatus());
        assertEquals(etag, notModified.getHeaderString("ETag"));

        // System administrator receives sysadmin endpoints and relative URL fallback when canonical is blank
        when(props.getBaseUrl(UrlMode.CANONICAL)).thenReturn(" ");
        UserKey admin = new UserKey("admin");
        when(users.getRemoteUserKey(request)).thenReturn(admin);
        when(users.isLicensed(admin)).thenReturn(true);
        when(users.isSystemAdmin(admin)).thenReturn(true);

        Response adminResp = resource.spec(request);
        assertEquals(200, adminResp.getStatus());
        assertNotEquals(etag, adminResp.getHeaderString("ETag"));
        Map<String, Object> adminSpec = JsonParser.parseObject((String) adminResp.getEntity());
        List<Map<String, Object>> adminServers = (List<Map<String, Object>>) adminSpec.get("servers");
        assertEquals("/jira/rest/restbrowser/1", adminServers.get(0).get("url"));
        Map<String, Object> adminPaths = (Map<String, Object>) adminSpec.get("paths");
        assertTrue(adminPaths.containsKey("/code/context"));
        assertTrue(adminPaths.containsKey("/catalog/refresh"));
    }
}
