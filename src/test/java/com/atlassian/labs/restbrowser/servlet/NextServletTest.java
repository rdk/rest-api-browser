package com.atlassian.labs.restbrowser.servlet;

import com.atlassian.plugin.PluginAccessor;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.auth.LoginUriProvider;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import com.atlassian.templaterenderer.TemplateRenderer;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import static java.util.Objects.requireNonNull;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

public class NextServletTest {

    private final UserManager userManager = mock(UserManager.class);
    private final HttpServletRequest request = mock(HttpServletRequest.class);
    private final NextServlet servlet = new NextServlet(userManager, mock(TemplateRenderer.class),
            mock(LoginUriProvider.class), mock(ApplicationProperties.class), mock(PluginAccessor.class));

    @Test
    public void thePageKnowsTheUserAndIsEmptyForAnonymous() {
        // the app keeps each user's history apart in a browser profile that several users share
        assertEquals("", servlet.getContext(request).get("user"));
        when(userManager.getRemoteUserKey(request)).thenReturn(new UserKey("JIRAUSER10000"));
        assertEquals("JIRAUSER10000", servlet.getContext(request).get("user"));
        assertEquals("", servlet.getContext(request).get("pluginVersion"));
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
