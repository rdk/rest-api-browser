package com.atlassian.labs.restbrowser.servlet;

import com.atlassian.annotations.security.UnrestrictedAccess;
import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.CatalogSnapshot;
import com.atlassian.labs.restbrowser.catalog.CatalogTestSupport;
import com.atlassian.labs.restbrowser.json.JsonParser;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.plugin.PluginInformation;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.UrlMode;
import com.atlassian.sal.api.auth.LoginUriProvider;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import com.atlassian.templaterenderer.TemplateRenderer;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.Test;
import org.mockito.ArgumentCaptor;

import java.io.IOException;
import java.io.InputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.io.Writer;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static java.util.Objects.requireNonNull;
import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

public class AdminIntroServletTest {

    @Test
    @SuppressWarnings("unchecked")
    public void enforcesAdminAndSystemAdminAccessAndRendersWithoutCatalogBuild() throws IOException {
        assertTrue(AdminIntroServlet.class.isAnnotationPresent(UnrestrictedAccess.class));

        UserManager userManager = mock(UserManager.class);
        TemplateRenderer renderer = mock(TemplateRenderer.class);
        LoginUriProvider loginUriProvider = mock(LoginUriProvider.class);
        ApplicationProperties appProps = mock(ApplicationProperties.class);
        PluginAccessor pluginAccessor = mock(PluginAccessor.class);
        CatalogService catalog = mock(CatalogService.class);

        when(appProps.getBaseUrl(UrlMode.RELATIVE)).thenReturn("/jira/");
        when(appProps.getBaseUrl(UrlMode.CANONICAL)).thenReturn("https://example.test/jira/");
        when(appProps.getDisplayName()).thenReturn("Jira");
        when(appProps.getVersion()).thenReturn("11.3.13");
        Plugin own = mock(Plugin.class);
        PluginInformation info = mock(PluginInformation.class);
        when(pluginAccessor.getPlugin("com.atlassian.labs.rest-api-browser")).thenReturn(own);
        when(pluginAccessor.isPluginEnabled(com.atlassian.labs.restbrowser.spring.LocalBeans.LIVE_SCALPEL_KEY)).thenReturn(true);
        when(own.getPluginInformation()).thenReturn(info);
        when(info.getVersion()).thenReturn("4.3.3-SNAPSHOT");

        AdminIntroServlet servlet = new AdminIntroServlet(
                userManager, renderer, loginUriProvider, appProps, pluginAccessor, catalog);
        assertFalse(servlet.allowAnonymous());

        // 1. Anonymous user redirects to login
        HttpServletRequest anonReq = mock(HttpServletRequest.class);
        when(anonReq.getRequestURL()).thenReturn(new StringBuffer("https://example.test/jira/plugins/servlet/rest-api-browser/admin"));
        when(loginUriProvider.getLoginUri(URI.create("https://example.test/jira/plugins/servlet/rest-api-browser/admin")))
                .thenReturn(URI.create("https://example.test/jira/login"));
        HttpServletResponse anonResp = mock(HttpServletResponse.class);
        servlet.doGet(anonReq, anonResp);
        verify(anonResp).sendRedirect("https://example.test/jira/login");

        // 2. Unlicensed account gets 403
        HttpServletRequest unlicensedReq = mock(HttpServletRequest.class);
        UserKey portal = new UserKey("portal");
        when(userManager.getRemoteUserKey(unlicensedReq)).thenReturn(portal);
        when(userManager.isLicensed(portal)).thenReturn(false);
        HttpServletResponse unlicensedResp = mock(HttpServletResponse.class);
        servlet.doGet(unlicensedReq, unlicensedResp);
        verify(unlicensedResp).sendError(HttpServletResponse.SC_FORBIDDEN,
                "A product license is required to use REST API Browser.");

        // 3. Licensed non-admin gets 403
        HttpServletRequest userReq = mock(HttpServletRequest.class);
        UserKey alice = new UserKey("alice");
        when(userManager.getRemoteUserKey(userReq)).thenReturn(alice);
        when(userManager.isLicensed(alice)).thenReturn(true);
        HttpServletResponse userResp = mock(HttpServletResponse.class);
        servlet.doGet(userReq, userResp);
        verify(userResp).sendError(HttpServletResponse.SC_FORBIDDEN,
                "Administrator access is required to view this administration page.");

        // 4. Administrator renders admin-intro.vm with warm catalog stats from peek() only
        CatalogSnapshot warm = CatalogTestSupport.snapshot(List.of(), List.of(), true, "4.3.3-SNAPSHOT");
        when(catalog.peek()).thenReturn(warm);
        HttpServletRequest adminReq = mock(HttpServletRequest.class);
        UserKey admin = new UserKey("admin");
        when(userManager.getRemoteUserKey(adminReq)).thenReturn(admin);
        when(userManager.isAdmin(admin)).thenReturn(true);
        when(userManager.isSystemAdmin(admin)).thenReturn(true);
        HttpServletResponse adminResp = mock(HttpServletResponse.class);
        StringWriter adminOut = new StringWriter();
        PrintWriter writer = new PrintWriter(adminOut);
        when(adminResp.getWriter()).thenReturn(writer);
        doAnswer(inv -> {
            inv.<Writer>getArgument(2).write("<!--admin-intro-->");
            return null;
        }).when(renderer).render(eq("/templates/admin-intro.vm"), anyMap(), any(Writer.class));

        servlet.doGet(adminReq, adminResp);

        verify(adminResp).setHeader("Cache-Control", "private, no-store");
        ArgumentCaptor<Map<String, Object>> ctxCaptor = ArgumentCaptor.forClass(Map.class);
        verify(renderer).render(eq("/templates/admin-intro.vm"), ctxCaptor.capture(), any(Writer.class));
        assertEquals("<!--admin-intro-->", adminOut.toString());
        verify(catalog, never()).current(any());

        Map<String, Object> ctx = ctxCaptor.getValue();
        assertEquals("/jira", ctx.get("baseUrl"));
        assertEquals("https://example.test/jira", ctx.get("canonicalBaseUrl"));
        assertEquals("https://example.test/jira/rest/restbrowser/1", ctx.get("apiBase"));
        assertEquals("https://example.test/jira/plugins/servlet/rest-api-browser", ctx.get("uiBase"));
        assertEquals(Boolean.TRUE, ctx.get("isSysadmin"));
        assertEquals(Boolean.TRUE, ctx.get("catalogReady"));
        assertEquals(0, ctx.get("catalogOpCount"));
        assertEquals("0", ctx.get("catalogOpCountText"));
        assertEquals("4.3.3-SNAPSHOT", ctx.get("pluginVersion"));
        assertEquals("admin_system_menu/advanced_menu_section/advanced_section", ctx.get("activeSection"));
        assertEquals("restapi-browser-link", ctx.get("activeTab"));

        Map<String, Object> mcpCfg = JsonParser.parseObject((String) ctx.get("mcpConfigJson"));
        Map<String, Object> servers = (Map<String, Object>) mcpCfg.get("mcpServers");
        Map<String, Object> rab = (Map<String, Object>) servers.get("rest-api-browser");
        assertEquals("http", rab.get("type"));
        assertEquals("https://example.test/jira/rest/restbrowser/1/mcp", rab.get("url"));

        String stuck = (String) ctx.get("promptDebugStuck");
        assertTrue(stuck.contains("resolve_url"));
        assertTrue(stuck.contains("investigate_operation_context"));
        assertTrue(stuck.contains("find_implementations"));
        assertTrue(stuck.contains("traverse_graph"));
        assertTrue(stuck.contains("decompile_source"));
        assertTrue(stuck.contains("read_bundle_resource"));
        assertTrue(stuck.contains("https://example.test/jira/rest/restbrowser/1"));

        assertEquals(Boolean.TRUE, ctx.get("hasLiveScalpel"));
        assertEquals("/jira/plugins/servlet/live-scalpel", ctx.get("liveScalpelUrl"));
        Map<String, Object> dualCfg = JsonParser.parseObject((String) ctx.get("dualMcpConfigJson"));
        Map<String, Object> dualServers = (Map<String, Object>) dualCfg.get("mcpServers");
        assertTrue(dualServers.containsKey("rest-api-browser"));
        assertTrue(dualServers.containsKey("live-scalpel"));
        String dualPrompt = (String) ctx.get("promptDualWorkflow");
        assertTrue(dualPrompt.contains("scalpel_trace"));
        assertTrue(dualPrompt.contains("decompile_source"));

        // Non-sysadmin Admin does not see sysadmin-only Live Scalpel companion flags/links
        UserKey plainAdmin = new UserKey("plainadmin");
        HttpServletRequest plainAdminReq = mock(HttpServletRequest.class);
        when(userManager.getRemoteUserKey(plainAdminReq)).thenReturn(plainAdmin);
        when(userManager.isAdmin(plainAdmin)).thenReturn(true);
        when(userManager.isSystemAdmin(plainAdmin)).thenReturn(false);
        assertEquals(Boolean.FALSE, servlet.getContext(plainAdminReq).get("hasLiveScalpel"));
    }

    @Test
    public void decoratorMetaMatchesJiraConfluenceAndOtherProducts() {
        AdminIntroServlet.DecoratorMeta jira = AdminIntroServlet.decoratorMeta("Jira");
        assertEquals("admin_system_menu/advanced_menu_section/advanced_section", jira.activeSection());
        assertEquals("restapi-browser-link", jira.activeTab());
        assertEquals("", jira.selectedWebItem());

        AdminIntroServlet.DecoratorMeta confluence = AdminIntroServlet.decoratorMeta("Atlassian Confluence");
        assertEquals("system.admin/administration", confluence.activeSection());
        assertEquals("restapi-browser-link", confluence.activeTab());
        assertEquals("rest-browser-link-confluence", confluence.selectedWebItem());

        AdminIntroServlet.DecoratorMeta bitbucket = AdminIntroServlet.decoratorMeta("Bitbucket");
        assertEquals("atl.admin/admin-plugins-section", bitbucket.activeSection());

        AdminIntroServlet.DecoratorMeta bamboo = AdminIntroServlet.decoratorMeta("Bamboo");
        assertEquals("system.admin/system", bamboo.activeSection());

        AdminIntroServlet.DecoratorMeta crowd = AdminIntroServlet.decoratorMeta("Crowd");
        assertEquals("administrationnav", crowd.activeSection());
    }

    @Test
    public void templateUsesAdminDecoratorNoInlineScriptAndPluginXmlWiresAdminLinks() throws IOException {
        String vm;
        try (InputStream in = AdminIntroServlet.class.getResourceAsStream("/templates/admin-intro.vm")) {
            vm = new String(requireNonNull(in, "admin-intro.vm missing").readAllBytes(), StandardCharsets.UTF_8);
        }
        assertTrue(vm.contains("<meta name=\"decorator\" content=\"atl.admin\"/>"));
        assertTrue(vm.contains("com.atlassian.labs.rest-api-browser:admin-assets"));
        assertTrue(vm.contains("id=\"rab-open-fullscreen\""));
        assertTrue(vm.contains("$baseUrl/plugins/servlet/rest-api-browser"));
        assertTrue(vm.contains("id=\"rab-mcp-config\""));
        assertTrue(vm.contains("id=\"rab-prompt-stuck\""));
        assertFalse("admin-intro.vm must remain CSP-clean with no inline <script>", vm.contains("<script"));
        assertFalse("admin-intro.vm must avoid inline style attributes", vm.contains("style=\""));

        String xml;
        try (InputStream in = AdminIntroServlet.class.getResourceAsStream("/atlassian-plugin.xml")) {
            xml = new String(requireNonNull(in, "atlassian-plugin.xml missing").readAllBytes(), StandardCharsets.UTF_8);
        }
        assertTrue(xml.contains("<url-pattern>/rest-api-browser/admin</url-pattern>"));
        assertTrue(xml.contains("com.atlassian.labs.restbrowser.servlet.AdminIntroServlet"));
        assertTrue(xml.contains("<web-resource key=\"admin-assets\">"));
        assertTrue(xml.contains("<link linkId=\"restapi-browser-link\">/plugins/servlet/rest-api-browser/admin</link>"));
    }
}
