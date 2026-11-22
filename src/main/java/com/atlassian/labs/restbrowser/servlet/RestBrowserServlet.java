package com.atlassian.labs.restbrowser.servlet;

import com.atlassian.annotations.security.AnonymousSiteAccess;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery;
import com.atlassian.labs.restbrowser.rest.model.RestDescriptor;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.auth.LoginUriProvider;
import com.atlassian.sal.api.user.UserManager;
import com.atlassian.templaterenderer.TemplateRenderer;

import jakarta.servlet.http.HttpServletRequest;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static java.util.Objects.requireNonNull;

/**
 * Renders the main page of the classic UI.
 */
@AnonymousSiteAccess
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
        final Map<String, Object> context = new HashMap<>();
        context.put("applicationProperties", applicationProperties);
        context.put("devMode", System.getProperty("atlassian.dev.mode"));
        context.put("restDescriptors", getRestDescriptors());
        return context;
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
