package com.atlassian.labs.restbrowser.servlet;

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
    public void llmsTxtFollowsSpecAndAdaptsToAuth() {
        CatalogService catalog = mock(CatalogService.class);
        ServletContext ctx = mock(ServletContext.class);
        CatalogSnapshot snap = CatalogTestSupport.snapshot(List.of(), List.of(), true, "4.2.3-SNAPSHOT");
        when(catalog.current(ctx)).thenReturn(snap);
        when(request.getServletContext()).thenReturn(ctx);
        when(appProps.getBaseUrl(UrlMode.CANONICAL)).thenReturn("https://example.test/jira");
        when(appProps.getDisplayName()).thenReturn("Jira");
        when(appProps.getVersion()).thenReturn("10.3.0");

        LlmsTxtServlet llms = new LlmsTxtServlet(userManager, appProps, mock(PluginAccessor.class), catalog);

        // anonymous: generic guide, no private instance details
        String anon = llms.render(request);
        assertTrue(anon.startsWith("# REST API Browser\n\n> "));
        assertTrue(anon.contains("## Catalog API"));
        assertTrue(anon.contains("## Code & Decompilation API"));
        assertTrue(anon.contains("## Optional"));
        assertFalse(anon.contains("example.test"));
        assertFalse(anon.contains("10.3.0"));

        // authenticated sysadmin: tailored with base URL, product, and catalog hash
        UserKey admin = new UserKey("admin");
        when(userManager.getRemoteUserKey(request)).thenReturn(admin);
        when(userManager.isSystemAdmin(admin)).thenReturn(true);
        String authed = llms.render(request);
        assertTrue(authed.contains("https://example.test/jira/rest/restbrowser/1/code/graph"));
        assertTrue(authed.contains("Jira 10.3.0"));
        assertTrue(authed.contains(snap.hash()));
        assertTrue(authed.contains("system administrator access"));
    }

    @Test
    public void theUserIsOnTheRootElementEncodedLikeTheOtherAttributes() throws IOException {
        String vm;
        try (InputStream in = NextServlet.class.getResourceAsStream("/templates/next.vm")) {
            vm = new String(requireNonNull(in).readAllBytes(), StandardCharsets.UTF_8);
        }
        assertTrue(vm, vm.contains("data-user=\"$textUtils.htmlEncode($user)\""));
        assertTrue(vm, vm.contains("data-site-url=\"$textUtils.htmlEncode($siteUrl)\""));
    }
}
