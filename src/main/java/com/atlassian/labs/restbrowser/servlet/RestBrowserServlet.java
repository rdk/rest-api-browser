package com.atlassian.labs.restbrowser.servlet;

import com.atlassian.annotations.security.UnrestrictedAccess;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery;
import com.atlassian.labs.restbrowser.json.Json;
import com.atlassian.labs.restbrowser.rest.model.RestDescriptor;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.UrlMode;
import com.atlassian.sal.api.auth.LoginUriProvider;
import com.atlassian.sal.api.user.UserManager;
import com.atlassian.templaterenderer.TemplateRenderer;

import jakarta.servlet.http.HttpServletRequest;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static java.util.Objects.requireNonNull;

/**
 * Renders the main page of the classic UI.
 * Annotated with {@code @UnrestrictedAccess} so Platform 7/8 routes requests to {@link RequiresLoginServlet},
 * which redirects anonymous users to login and requires a product license in Java unless
 * {@code -Drest.api.browser.anonymous=true} is set (even when site anonymous access is disabled).
 */
@UnrestrictedAccess
public class RestBrowserServlet extends RequiresLoginServlet {

    private static final String BROWSER_TEMPLATE = "/templates/browser.vm";

    private final ApplicationProperties applicationProperties;
    private final ModuleDiscovery moduleDiscovery;

    public RestBrowserServlet(final ModuleDiscovery moduleDiscovery,
                              final UserManager userManager,
                              final TemplateRenderer renderer,
                              final LoginUriProvider loginUriProvider,
                              final ApplicationProperties applicationProperties) {
        super(userManager, renderer, loginUriProvider);
        this.applicationProperties = requireNonNull(applicationProperties);
        this.moduleDiscovery = requireNonNull(moduleDiscovery);
    }

    @Override
    protected Map<String, Object> getContext(final HttpServletRequest req) {
        final String baseUrl = stripTrailingSlashes(nullToEmpty(applicationProperties.getBaseUrl(UrlMode.CANONICAL)));
        final String product = nullToEmpty(applicationProperties.getDisplayName());
        final List<RestDescriptor> descriptors = getRestDescriptors();
        final String configJson = buildConfigJson(product, baseUrl, descriptors);
        final String configBase64 = Base64.getEncoder().encodeToString(configJson.getBytes(StandardCharsets.UTF_8));
        final Map<String, Object> context = new HashMap<>();
        context.put("baseUrl", baseUrl);
        context.put("isBamboo", "Bamboo".equals(product));
        context.put("devMode", System.getProperty("atlassian.dev.mode"));
        context.put("rabConfigBase64", configBase64);
        return context;
    }

    static String buildConfigJson(final String product, final String baseUrl, final List<RestDescriptor> descriptors) {
        final String cleanBase = stripTrailingSlashes(nullToEmpty(baseUrl));
        final Json json = new Json().beginObject()
                .field("product", product)
                .field("baseUrl", cleanBase)
                .name("services").beginArray();
        for (final RestDescriptor descriptor : descriptors) {
            final String rp = normalizeRestPath(nullToEmpty(descriptor.getRestPath()));
            final String path = cleanBase + "/rest" + rp;
            json.beginObject()
                    .field("wadl", path + "/application.wadl")
                    .field("path", path)
                    .field("relativeResource", nullToEmpty(descriptor.getDisplayPath()))
                    .endObject();
        }
        return json.endArray().endObject().toString();
    }

    private static String stripTrailingSlashes(final String value) {
        int end = value.length();
        while (end > 0 && value.charAt(end - 1) == '/') {
            end--;
        }
        return value.substring(0, end);
    }

    private static String normalizeRestPath(final String restPath) {
        if (restPath.isEmpty() || restPath.startsWith("/")) {
            return restPath;
        }
        return "/" + restPath;
    }

    private static String nullToEmpty(final String value) {
        return value == null ? "" : value;
    }

    @Override
    protected String getTemplatePath() {
        return BROWSER_TEMPLATE;
    }

    private List<RestDescriptor> getRestDescriptors() {
        return moduleDiscovery.discover().stream()
                .map(m -> new RestDescriptor.Builder()
                        .basePath(m.basePath())
                        .version(m.version())
                        .pluginCompleteKey(m.id())
                        .pluginDescription(m.description())
                        .pluginKey(m.pluginKey())
                        .pluginName(m.pluginName())
                        .build())
                .toList();
    }
}
