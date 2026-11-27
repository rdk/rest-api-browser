package com.atlassian.labs.restbrowser.servlet;

import com.atlassian.annotations.security.AnonymousSiteAccess;
import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.CatalogSnapshot;
import com.atlassian.labs.restbrowser.catalog.CatalogTestSupport;
import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.State;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.plugin.PluginInformation;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.UrlMode;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.WriteListener;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

public class LlmsTxtServletTest {

    @Test
    public void anonymousRequestServesGenericGuideWithExactUtf8ByteLengthAndNoCatalogBuild() throws IOException {
        assertTrue(LlmsTxtServlet.class.isAnnotationPresent(AnonymousSiteAccess.class));

        UserManager users = mock(UserManager.class);
        ApplicationProperties props = mock(ApplicationProperties.class);
        PluginAccessor plugins = mock(PluginAccessor.class);
        CatalogService catalog = mock(CatalogService.class);

        when(props.getBaseUrl(UrlMode.CANONICAL)).thenReturn("https://example.test/jira/");
        when(props.getDisplayName()).thenReturn("Jira");
        when(props.getVersion()).thenReturn("11.3.13");

        LlmsTxtServlet servlet = new LlmsTxtServlet(users, props, plugins, catalog);

        HttpServletRequest req = mock(HttpServletRequest.class);
        when(req.getRequestURI()).thenReturn("/jira/plugins/servlet/rest-api-browser/llms.txt");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        HttpServletResponse resp = mockResponse(bytes);

        servlet.doGet(req, resp);

        verify(resp).setContentType("text/plain; charset=utf-8");
        verify(resp).setHeader("Cache-Control", "private, no-cache");
        verify(resp).setContentLength(bytes.size());
        verify(catalog, never()).current(any());
        verify(catalog, never()).peek();

        String body = bytes.toString(StandardCharsets.UTF_8);
        assertTrue(body.startsWith("# REST API Browser\n"));
        assertTrue(body.contains("GET /rest/restbrowser/1/catalog/operations"));
        assertTrue(body.contains("POST /rest/restbrowser/1/mcp"));
        assertFalse(body.contains("https://example.test"));
        assertFalse(body.contains("Catalog hash"));
        assertFalse(body.contains("Full Agent Reference"));
    }

    @Test
    public void licensedAndSysadminRequestsRenderInstanceMetadataCatalogStatsAndRelativeFallback() throws IOException {
        UserManager users = mock(UserManager.class);
        ApplicationProperties props = mock(ApplicationProperties.class);
        PluginAccessor plugins = mock(PluginAccessor.class);
        CatalogService catalog = mock(CatalogService.class);

        Plugin own = mock(Plugin.class);
        PluginInformation info = mock(PluginInformation.class);
        when(plugins.getPlugin("com.atlassian.labs.rest-api-browser")).thenReturn(own);
        when(own.getPluginInformation()).thenReturn(info);
        when(info.getVersion()).thenReturn("4.4.0");

        ModuleEntry mod = new ModuleEntry("demo", "demo/1", "product", "supported", "jersey",
                State.ok, null, null, 1, "plugin.demo", "Plugin demo", "1.0");
        Operation op = new Operation("demo:GET:ping", "demo", CatalogTestSupport.spec("GET", "ping"));
        CatalogSnapshot warm = CatalogTestSupport.snapshot(List.of(mod), List.of(op), true, "4.4.0");
        when(catalog.peek()).thenReturn(warm);

        when(props.getBaseUrl(UrlMode.CANONICAL)).thenReturn("https://example.test/jira/");
        when(props.getBaseUrl(UrlMode.RELATIVE)).thenReturn("/jira/");
        when(props.getDisplayName()).thenReturn("Jira");
        when(props.getVersion()).thenReturn("11.3.13");

        LlmsTxtServlet servlet = new LlmsTxtServlet(users, props, plugins, catalog);

        // Licensed non-sysadmin receives canonical base URL without trailing slash + non-sysadmin note
        HttpServletRequest devReq = mock(HttpServletRequest.class);
        when(devReq.getRequestURI()).thenReturn("/jira/plugins/servlet/rest-api-browser/llms.txt");
        UserKey dev = new UserKey("dev");
        when(users.getRemoteUserKey(devReq)).thenReturn(dev);
        when(users.isLicensed(dev)).thenReturn(true);
        when(users.isSystemAdmin(dev)).thenReturn(false);
        ByteArrayOutputStream devBytes = new ByteArrayOutputStream();
        HttpServletResponse devResp = mockResponse(devBytes);

        servlet.doGet(devReq, devResp);
        verify(devResp).setContentLength(devBytes.size());

        String devBody = devBytes.toString(StandardCharsets.UTF_8);
        assertTrue(devBody.contains("Jira 11.3.13 (plugin v4.4.0)"));
        assertTrue(devBody.contains("1 operations across 1 modules (complete)"));
        assertTrue(devBody.contains("https://example.test/jira/rest/restbrowser/1/catalog/operations"));
        assertTrue(devBody.contains("(your current account is not a system administrator)"));
        verify(catalog, never()).current(any());

        // Blank canonical URL falls back to relative URL; sysadmin note shown
        when(props.getBaseUrl(UrlMode.CANONICAL)).thenReturn("   ");
        HttpServletRequest adminReq = mock(HttpServletRequest.class);
        when(adminReq.getRequestURI()).thenReturn("/jira/plugins/servlet/rest-api-browser/llms.txt");
        UserKey admin = new UserKey("admin");
        when(users.getRemoteUserKey(adminReq)).thenReturn(admin);
        when(users.isLicensed(admin)).thenReturn(true);
        when(users.isSystemAdmin(admin)).thenReturn(true);
        ByteArrayOutputStream adminBytes = new ByteArrayOutputStream();
        HttpServletResponse adminResp = mockResponse(adminBytes);

        servlet.doGet(adminReq, adminResp);

        String adminBody = adminBytes.toString(StandardCharsets.UTF_8);
        assertTrue(adminBody.contains("GET /jira/rest/restbrowser/1/catalog/operations"));
        assertTrue(adminBody.contains("(your current account has system administrator access)"));
    }

    @Test
    public void routesLlmsFullViaServletPathPathInfoOrUriWithUtf8ContentLength() throws IOException {
        UserManager users = mock(UserManager.class);
        ApplicationProperties props = mock(ApplicationProperties.class);
        PluginAccessor plugins = mock(PluginAccessor.class);
        CatalogService catalog = mock(CatalogService.class);
        when(props.getBaseUrl(UrlMode.CANONICAL)).thenReturn("https://example.test/confluence");
        when(props.getDisplayName()).thenReturn("Confluence");
        when(props.getVersion()).thenReturn("10.2.20");

        LlmsTxtServlet servlet = new LlmsTxtServlet(users, props, plugins, catalog);

        for (int variant = 0; variant < 3; variant++) {
            HttpServletRequest req = mock(HttpServletRequest.class);
            UserKey admin = new UserKey("admin");
            when(users.getRemoteUserKey(req)).thenReturn(admin);
            when(users.isSystemAdmin(admin)).thenReturn(true);
            if (variant == 0) {
                when(req.getServletPath()).thenReturn("/plugins/servlet/rest-api-browser/llms-full.txt");
            } else if (variant == 1) {
                when(req.getPathInfo()).thenReturn("/llms-full.txt");
            } else {
                when(req.getRequestURI()).thenReturn("/confluence/plugins/servlet/rest-api-browser/llms-full.txt");
            }

            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            HttpServletResponse resp = mockResponse(bytes);
            servlet.doGet(req, resp);

            // Multi-byte UTF-8 em-dash ensures Content-Length equals byte count rather than String.length()
            verify(resp).setContentLength(bytes.size());
            String body = bytes.toString(StandardCharsets.UTF_8);
            assertTrue(bytes.size() > body.length());
            assertTrue(body.startsWith("# REST API Browser \u2014 Full Agent Reference\n"));
            assertTrue(body.contains("## Quick Curl Examples"));
            assertTrue(body.contains("## MCP Streamable HTTP Configuration"));
            assertTrue(body.contains("https://example.test/confluence/rest/restbrowser/1/mcp"));
            assertTrue(body.contains("## HTTP Caching & Error Recovery"));
        }
    }

    private static HttpServletResponse mockResponse(ByteArrayOutputStream sink) throws IOException {
        HttpServletResponse resp = mock(HttpServletResponse.class);
        when(resp.getOutputStream()).thenReturn(new ServletOutputStream() {
            @Override
            public boolean isReady() {
                return true;
            }

            @Override
            public void setWriteListener(WriteListener writeListener) {
            }

            @Override
            public void write(int b) {
                sink.write(b);
            }

            @Override
            public void write(byte[] b, int off, int len) {
                sink.write(b, off, len);
            }
        });
        return resp;
    }
}
