package com.atlassian.labs.restbrowser.servlet;

import com.atlassian.annotations.security.UnrestrictedAccess;
import com.atlassian.labs.restbrowser.rest.RestAuth;
import com.atlassian.labs.restbrowser.spring.LocalBeans;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.UrlMode;
import com.atlassian.sal.api.auth.LoginUriProvider;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import com.atlassian.templaterenderer.TemplateRenderer;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

import static java.util.Objects.requireNonNull;

/**
 * Renders the new UI's page for licensed users only (never anonymous or unlicensed accounts).
 * Annotated with {@code @UnrestrictedAccess} so Platform 7/8 delegates unauthenticated requests to
 * {@link RequiresLoginServlet}, which redirects to login cleanly (percent-encoding deep-link query params rather than
 * failing early in Platform) and enforces {@link RestAuth#isLicensedUser} checks ({@link #allowAnonymous()} is false).
 */
@UnrestrictedAccess
public class NextServlet extends RequiresLoginServlet {

    private final UserManager userManager;
    private final ApplicationProperties applicationProperties;
    private final PluginAccessor pluginAccessor;

    public NextServlet(UserManager userManager, TemplateRenderer renderer, LoginUriProvider loginUriProvider,
                       ApplicationProperties applicationProperties, PluginAccessor pluginAccessor) {
        super(userManager, renderer, loginUriProvider);
        this.userManager = requireNonNull(userManager);
        this.applicationProperties = requireNonNull(applicationProperties);
        this.pluginAccessor = requireNonNull(pluginAccessor);
    }

    @Override
    protected boolean allowAnonymous() {
        return false;
    }

    @Override
    protected boolean handleRequest(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        String uri = req.getRequestURI();
        if (uri != null) {
            String clean = uri.replaceAll(";[^/]*", "");
            if (clean.endsWith("/restbrowser/next") || clean.endsWith("/restbrowser/next/")) {
                String base = stripTrailingSlashes(nonNull(applicationProperties.getBaseUrl(UrlMode.RELATIVE)));
                String target = base + "/plugins/servlet/rest-api-browser";
                String qs = req.getQueryString();
                if (qs != null && !qs.isEmpty()) {
                    target += "?" + RequiresLoginServlet.encodeQuery(qs);
                }
                resp.sendRedirect(target);
                return true;
            }
        }
        return false;
    }

    @Override
    protected String getTemplatePath() {
        return "/templates/next.vm";
    }

    @Override
    protected Map<String, Object> getContext(HttpServletRequest request) {
        Map<String, Object> context = new HashMap<>();
        context.put("baseUrl", stripTrailingSlashes(nonNull(applicationProperties.getBaseUrl(UrlMode.RELATIVE))));
        context.put("siteUrl", nonNull(applicationProperties.getBaseUrl(UrlMode.CANONICAL)));
        context.put("productName", nonNull(applicationProperties.getDisplayName()));
        context.put("pluginVersion", pluginVersion());
        context.put("user", user(request));
        return context;
    }

    private static String stripTrailingSlashes(String value) {
        int end = value.length();
        while (end > 0 && value.charAt(end - 1) == '/') {
            end--;
        }
        return value.substring(0, end);
    }

    private String user(HttpServletRequest request) {
        UserKey key = RestAuth.remoteUser(userManager, request);
        return key == null ? "" : key.getStringValue();
    }

    private String pluginVersion() {
        return LocalBeans.pluginVersion(pluginAccessor);
    }

    private static String nonNull(String s) {
        return s == null ? "" : s;
    }
}
