package com.atlassian.labs.restbrowser.servlet;

import com.atlassian.annotations.security.UnrestrictedAccess;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.labs.restbrowser.json.JsonParser;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.UrlMode;
import com.atlassian.sal.api.auth.LoginUriProvider;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import com.atlassian.templaterenderer.TemplateRenderer;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.io.InputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.io.Writer;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import static java.util.Objects.requireNonNull;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

public class RestBrowserServletTest {

    private final ModuleDiscovery discovery = mock(ModuleDiscovery.class);
    private final UserManager userManager = mock(UserManager.class);
    private final TemplateRenderer renderer = mock(TemplateRenderer.class);
    private final LoginUriProvider loginUriProvider = mock(LoginUriProvider.class);
    private final ApplicationProperties appProps = mock(ApplicationProperties.class);
    private final HttpServletRequest request = mock(HttpServletRequest.class);

    private final RestBrowserServlet servlet = new RestBrowserServlet(
            discovery, userManager, renderer, loginUriProvider, appProps);

    private String previousAnonymous;

    @Before
    public void setUp() {
        previousAnonymous = System.getProperty(RequiresLoginServlet.RAB_ANONYMOUS);
        System.clearProperty(RequiresLoginServlet.RAB_ANONYMOUS);
    }

    @After
    public void tearDown() {
        if (previousAnonymous == null) {
            System.clearProperty(RequiresLoginServlet.RAB_ANONYMOUS);
        } else {
            System.setProperty(RequiresLoginServlet.RAB_ANONYMOUS, previousAnonymous);
        }
    }

    @Test
    public void servletDelegatesAuthToRequiresLoginAndHonorsAnonymousFlag() throws IOException {
        // Platform 7/8 defaults unannotated servlets to @SystemAdminOnly; @UnrestrictedAccess lets RequiresLoginServlet enforce auth and login redirects even when site anonymous access is off.
        assertTrue(RestBrowserServlet.class.isAnnotationPresent(UnrestrictedAccess.class));

        when(request.getRequestURL()).thenReturn(new StringBuffer("https://example.test/plugins/servlet/restbrowser"));
        when(loginUriProvider.getLoginUri(URI.create("https://example.test/plugins/servlet/restbrowser")))
                .thenReturn(URI.create("https://example.test/login"));

        HttpServletResponse anonResp = mock(HttpServletResponse.class);
        servlet.doGet(request, anonResp);
        verify(anonResp).sendRedirect("https://example.test/login");

        UserKey unlicensed = new UserKey("portal");
        when(userManager.getRemoteUserKey(request)).thenReturn(unlicensed);
        when(userManager.isLicensed(unlicensed)).thenReturn(false);
        HttpServletResponse unlicensedResp = mock(HttpServletResponse.class);
        servlet.doGet(request, unlicensedResp);
        verify(unlicensedResp).sendError(HttpServletResponse.SC_FORBIDDEN,
                "A product license is required to use REST API Browser.");

        doAnswer(inv -> {
            inv.<Writer>getArgument(2).write("<!--browser-->");
            return null;
        }).when(renderer).render(eq("/templates/browser.vm"), anyMap(), any(Writer.class));

        UserKey licensed = new UserKey("alice");
        when(userManager.getRemoteUserKey(request)).thenReturn(licensed);
        when(userManager.isLicensed(licensed)).thenReturn(true);
        HttpServletResponse licensedResp = mock(HttpServletResponse.class);
        StringWriter licensedOut = new StringWriter();
        PrintWriter licensedWriter = new PrintWriter(licensedOut);
        when(licensedResp.getWriter()).thenReturn(licensedWriter);
        servlet.doGet(request, licensedResp);
        verify(licensedResp).setHeader("Cache-Control", "private, no-store");
        verify(renderer).render(eq("/templates/browser.vm"), anyMap(), any(Writer.class));
        assertEquals("<!--browser-->", licensedOut.toString());

        System.setProperty(RequiresLoginServlet.RAB_ANONYMOUS, "true");
        when(userManager.getRemoteUserKey(request)).thenReturn(null);
        HttpServletResponse anonAllowedResp = mock(HttpServletResponse.class);
        StringWriter anonOut = new StringWriter();
        PrintWriter anonWriter = new PrintWriter(anonOut);
        when(anonAllowedResp.getWriter()).thenReturn(anonWriter);
        servlet.doGet(request, anonAllowedResp);
        assertEquals("<!--browser-->", anonOut.toString());
    }

    @Test
    @SuppressWarnings("unchecked")
    public void emitsEscapedJsonConfigNormalizesSlashesAndOmitsUnusedContext() {
        when(appProps.getDisplayName()).thenReturn("Bamboo</script>\"");
        when(appProps.getBaseUrl(UrlMode.CANONICAL)).thenReturn("https://example.test/ctx\"</script>/");
        when(discovery.discover()).thenReturn(List.of(
                new RestModule("com.test:rest", "api/2.0", "api", "2.0", true,
                        "com.test", "Test Plugin", "1.0.0", "Desc", null, null),
                new RestModule("com.test:enc", "a&b/1", "/a&b/", "1", true,
                        "com.test", "Enc Plugin", "1.0.0", null, null, null)
        ));

        Map<String, Object> ctx = servlet.getContext(request);
        assertFalse(ctx.containsKey("applicationProperties"));
        assertFalse(ctx.containsKey("restDescriptors"));
        assertFalse(ctx.containsKey("rabConfigJson"));
        assertEquals("https://example.test/ctx\"</script>", ctx.get("baseUrl"));
        assertEquals(Boolean.FALSE, ctx.get("isBamboo"));

        String b64 = (String) ctx.get("rabConfigBase64");
        assertTrue(b64.matches("^[A-Za-z0-9+/=]+$"));
        String json = new String(Base64.getDecoder().decode(b64), StandardCharsets.UTF_8);
        assertFalse(json.contains("</script>"));
        assertTrue(json.contains("\\u003c/script>"));
        Map<String, Object> parsed = JsonParser.parseObject(json);
        List<Map<String, Object>> services = (List<Map<String, Object>>) parsed.get("services");
        assertEquals(2, services.size());
        assertEquals("api/2.0", services.get(0).get("relativeResource"));
        assertEquals("https://example.test/ctx\"</script>/rest/api/2.0", services.get(0).get("path"));
        assertEquals("https://example.test/ctx\"</script>/rest/api/2.0/application.wadl", services.get(0).get("wadl"));
        // Un-HTML-encoded raw ampersands preserved cleanly inside JSON
        assertEquals("a&b/1", services.get(1).get("relativeResource"));
        assertEquals("https://example.test/ctx\"</script>/rest/a&b/1", services.get(1).get("path"));

        when(appProps.getDisplayName()).thenReturn("Bamboo");
        assertEquals(Boolean.TRUE, servlet.getContext(request).get("isBamboo"));
    }

    @Test
    public void templateReadsConfigFromEncodedDataAttributeWithoutInlineVelocityInScript() throws IOException {
        String vm;
        try (InputStream in = RestBrowserServlet.class.getResourceAsStream("/templates/browser.vm")) {
            vm = new String(requireNonNull(in).readAllBytes(), StandardCharsets.UTF_8);
        }
        assertTrue(vm.contains("data-config-b64=\"$rabConfigBase64\""));
        assertFalse(vm.contains("textUtils.htmlEncode"));
        assertFalse(vm.contains("RAB.product = \"$applicationProperties"));
        assertFalse(vm.contains("${descriptor.restPath}"));
    }
}
