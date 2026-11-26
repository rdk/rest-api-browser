package com.atlassian.labs.restbrowser.servlet;

import com.atlassian.annotations.security.UnrestrictedAccess;
import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.CatalogSnapshot;
import com.atlassian.labs.restbrowser.catalog.CatalogTestSupport;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.UrlMode;
import com.atlassian.sal.api.auth.LoginUriProvider;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import com.atlassian.templaterenderer.TemplateRenderer;
import jakarta.servlet.ServletContext;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.Test;

import java.io.IOException;
import java.io.InputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static java.util.Objects.requireNonNull;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

public class NextServletTest {

    private final UserManager userManager = mock(UserManager.class);
    private final ApplicationProperties appProps = mock(ApplicationProperties.class);
    private final HttpServletRequest request = mock(HttpServletRequest.class);
    private final NextServlet servlet = new NextServlet(userManager, mock(TemplateRenderer.class),
            mock(LoginUriProvider.class), appProps, mock(PluginAccessor.class));

    @Test
    public void thePageKnowsTheUserAndIsEmptyForAnonymous() {
        // the app keeps each user's history apart in a browser profile that several users share
        assertEquals("", servlet.getContext(request).get("user"));
        when(userManager.getRemoteUserKey(request)).thenReturn(new UserKey("JIRAUSER10000"));
        assertEquals("JIRAUSER10000", servlet.getContext(request).get("user"));
        assertEquals("", servlet.getContext(request).get("pluginVersion"));
        when(appProps.getBaseUrl(UrlMode.RELATIVE)).thenReturn("/");
        assertEquals("", servlet.getContext(request).get("baseUrl"));
    }

    @Test
    public void redirectsLegacyNextUrlSafelyForRootContextAndIllegalQueryChars() throws IOException {
        when(appProps.getBaseUrl(UrlMode.RELATIVE)).thenReturn("/");
        when(request.getRequestURI()).thenReturn("/ctx;v=1/plugins/servlet/restbrowser/next");
        when(request.getQueryString()).thenReturn("op={}&x=1\r\nSet-Cookie:a=b");
        HttpServletResponse resp = mock(HttpServletResponse.class);

        assertTrue(servlet.handleRequest(request, resp));
        verify(resp).sendRedirect("/plugins/servlet/rest-api-browser?op=%7B%7D&x=1%0D%0ASet-Cookie:a=b");
    }

    @Test
    public void redirectsLegacyNextUrlPreservingQueryString() throws IOException {
        when(appProps.getBaseUrl(UrlMode.RELATIVE)).thenReturn("/jira");
        when(request.getRequestURI()).thenReturn("/jira/plugins/servlet/restbrowser/next");
        when(request.getQueryString()).thenReturn("op=api%3AGET%3AserverInfo");
        HttpServletResponse resp = mock(HttpServletResponse.class);

        assertTrue(servlet.handleRequest(request, resp));
        verify(resp).sendRedirect("/jira/plugins/servlet/rest-api-browser?op=api%3AGET%3AserverInfo");
    }

    @Test
    public void redirectsLegacyNextUrlEncodingIllegalCharsEvenWhenQueryContainsSchemeDelimiter() throws IOException {
        when(appProps.getBaseUrl(UrlMode.RELATIVE)).thenReturn("/jira");
        when(request.getRequestURI()).thenReturn("/jira/plugins/servlet/restbrowser/next");
        when(request.getQueryString()).thenReturn("op={a b}&url=https://example.com/x");
        HttpServletResponse resp = mock(HttpServletResponse.class);

        assertTrue(servlet.handleRequest(request, resp));
        verify(resp).sendRedirect("/jira/plugins/servlet/rest-api-browser?op=%7Ba%20b%7D&url=https://example.com/x");
    }

    @Test
    public void llmsTxtFollowsSpecAndAdaptsToAuth() throws IOException {
        CatalogService catalog = mock(CatalogService.class);
        ServletContext ctx = mock(ServletContext.class);
        CatalogSnapshot snap = CatalogTestSupport.snapshot(List.of(), List.of(), true, "4.2.3-SNAPSHOT");
        when(catalog.current(ctx)).thenReturn(snap);
        when(request.getServletContext()).thenReturn(ctx);
        when(appProps.getBaseUrl(UrlMode.CANONICAL)).thenReturn("https://example.test/jira");
        when(appProps.getDisplayName()).thenReturn("Jira");
        when(appProps.getVersion()).thenReturn("10.3.0");

        LlmsTxtServlet llms = new LlmsTxtServlet(userManager, appProps, mock(PluginAccessor.class), catalog);

        // anonymous or unlicensed user: generic guide, no private instance details, never triggers catalog build
        UserKey unlicensed = new UserKey("portal");
        when(userManager.getRemoteUserKey(request)).thenReturn(unlicensed);
        when(userManager.isLicensed(unlicensed)).thenReturn(false);
        String anon = llms.render(request);
        assertTrue(anon.startsWith("# REST API Browser\n\n> "));
        assertTrue(anon.contains("## Catalog API"));
        assertTrue(anon.contains("## Code & Decompilation API"));
        assertTrue(anon.contains("## Optional"));
        assertFalse(anon.contains("example.test"));
        assertFalse(anon.contains("10.3.0"));
        org.mockito.Mockito.verify(catalog, org.mockito.Mockito.never()).current(org.mockito.ArgumentMatchers.any());

        // authenticated licensed sysadmin: tailored with base URL, product, and catalog hash from peek()
        when(catalog.peek()).thenReturn(snap);
        UserKey admin = new UserKey("admin");
        when(userManager.getRemoteUserKey(request)).thenReturn(admin);
        when(userManager.isLicensed(admin)).thenReturn(true);
        when(userManager.isSystemAdmin(admin)).thenReturn(true);
        String authed = llms.render(request);
        assertTrue(authed.contains("https://example.test/jira/rest/restbrowser/1/code/graph"));
        assertTrue(authed.contains("/catalog/operations?"));
        assertTrue(authed.contains("/catalog/resolve?"));
        assertTrue(authed.contains("/catalog/index/current"));
        assertTrue(authed.contains("/catalog/openapi?"));
        assertTrue(authed.contains("/openapi.json"));
        assertTrue(authed.contains("/code/context"));
        assertTrue(authed.contains("/code/resource?"));
        assertTrue(authed.contains("/mcp"));
        assertTrue(authed.contains("/llms-full.txt"));
        assertTrue(authed.contains("/code/schema?"));
        assertTrue(authed.contains("/code/implementations?"));
        assertTrue(authed.contains("/code/callers?"));
        assertTrue(authed.contains("/code/grep?"));
        assertTrue(authed.contains("preset=domain"));
        assertTrue(authed.contains("format=json|markdown"));
        assertTrue(authed.contains("Jira 10.3.0"));
        assertTrue(authed.contains(snap.hash()));
        assertTrue(authed.contains("system administrator access"));

        HttpServletResponse llmsResp = mock(HttpServletResponse.class);
        StringWriter llmsOut = new StringWriter();
        when(llmsResp.getWriter()).thenReturn(new PrintWriter(llmsOut));
        llms.doGet(request, llmsResp);
        verify(llmsResp).setContentType("text/plain; charset=utf-8");
        verify(llmsResp).setHeader("Cache-Control", "private, no-cache");
        assertTrue(llmsOut.toString().startsWith("# REST API Browser"));

        // llms-full.txt serves extended examples & MCP configuration when path ends with /llms-full.txt
        when(request.getServletPath()).thenReturn("/plugins/servlet/rest-api-browser/llms-full.txt");
        HttpServletResponse fullResp = mock(HttpServletResponse.class);
        StringWriter fullOut = new StringWriter();
        when(fullResp.getWriter()).thenReturn(new PrintWriter(fullOut));
        llms.doGet(request, fullResp);
        String fullText = fullOut.toString();
        assertTrue(fullText.contains("Full Agent Reference"));
        assertTrue(fullText.contains("mcpServers"));
        assertTrue(fullText.contains("Quick Curl Examples"));
    }

    @Test
    public void nextServletBlocksAnonymousEvenWithFlagSetsNoStoreAndUsesSingleAttrEncoding() throws IOException {
        assertTrue(NextServlet.class.isAnnotationPresent(UnrestrictedAccess.class));
        String prev = System.getProperty(RequiresLoginServlet.RAB_ANONYMOUS);
        System.setProperty(RequiresLoginServlet.RAB_ANONYMOUS, "true");
        try {
            LoginUriProvider login = mock(LoginUriProvider.class);
            HttpServletRequest req = mock(HttpServletRequest.class);
            when(req.getRequestURL()).thenReturn(new StringBuffer("https://example.test/plugins/servlet/rest-api-browser"));
            when(login.getLoginUri(URI.create("https://example.test/plugins/servlet/rest-api-browser")))
                    .thenReturn(URI.create("https://example.test/login"));
            NextServlet next = new NextServlet(userManager, mock(TemplateRenderer.class), login, appProps, mock(PluginAccessor.class));
            HttpServletResponse anonResp = mock(HttpServletResponse.class);
            next.doGet(req, anonResp);
            verify(anonResp).sendRedirect("https://example.test/login");
        } finally {
            if (prev == null) System.clearProperty(RequiresLoginServlet.RAB_ANONYMOUS);
            else System.setProperty(RequiresLoginServlet.RAB_ANONYMOUS, prev);
        }

        UserKey licensed = new UserKey("alice");
        when(userManager.getRemoteUserKey(request)).thenReturn(licensed);
        when(userManager.isLicensed(licensed)).thenReturn(true);
        HttpServletResponse okResp = mock(HttpServletResponse.class);
        when(okResp.getWriter()).thenReturn(new PrintWriter(new StringWriter()));
        servlet.doGet(request, okResp);
        verify(okResp).setHeader("Cache-Control", "private, no-store");

        UserKey unlicensed = new UserKey("portal");
        when(userManager.getRemoteUserKey(request)).thenReturn(unlicensed);
        when(userManager.isLicensed(unlicensed)).thenReturn(false);
        HttpServletResponse resp = mock(HttpServletResponse.class);
        servlet.doGet(request, resp);
        verify(resp).sendError(HttpServletResponse.SC_FORBIDDEN, "A product license is required to use REST API Browser.");

        when(appProps.getBaseUrl(UrlMode.RELATIVE)).thenReturn("/jira");
        when(request.getRequestURI()).thenReturn("/jira/plugins/servlet/restbrowser/next;jsessionid=ABC123");
        when(request.getQueryString()).thenReturn(null);
        HttpServletResponse resp2 = mock(HttpServletResponse.class);
        assertTrue(servlet.handleRequest(request, resp2));
        verify(resp2).sendRedirect("/jira/plugins/servlet/rest-api-browser");
    }

    @Test
    public void theUserIsOnTheRootElementEncodedWithoutDoubleEscaping() throws IOException {
        String vm;
        try (InputStream in = NextServlet.class.getResourceAsStream("/templates/next.vm")) {
            vm = new String(requireNonNull(in).readAllBytes(), StandardCharsets.UTF_8);
        }
        assertTrue(vm, vm.contains("data-user=\"$user\""));
        assertTrue(vm, vm.contains("data-site-url=\"$siteUrl\""));
        assertFalse(vm, vm.contains("textUtils.htmlEncode"));
    }
}
