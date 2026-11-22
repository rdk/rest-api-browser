package com.atlassian.labs.restbrowser.servlet;

import com.atlassian.annotations.security.AnonymousSiteAccess;
import com.atlassian.labs.restbrowser.rest.model.RestDescriptor;
import com.atlassian.plugin.ModuleDescriptor;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.plugin.predicate.ModuleDescriptorPredicate;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.auth.LoginUriProvider;
import com.atlassian.sal.api.user.UserManager;
import com.atlassian.templaterenderer.TemplateRenderer;
import org.slf4j.Logger;

import jakarta.servlet.http.HttpServletRequest;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static java.util.Objects.requireNonNull;
import static java.util.stream.Collectors.toList;
import static org.slf4j.LoggerFactory.getLogger;

/**
 * Renders the main page of this app.
 */
@AnonymousSiteAccess
public class RestBrowserServlet extends RequiresLoginServlet {

    private static final Logger LOGGER = getLogger(RestBrowserServlet.class);

    private static final String BROWSER_TEMPLATE = "/templates/browser.vm";

    private final ApplicationProperties applicationProperties;
    private final PluginAccessor pluginAccessor;

    public RestBrowserServlet(final PluginAccessor pluginAccessor,
                              final UserManager userManager,
                              final TemplateRenderer renderer,
                              final LoginUriProvider loginUriProvider,
                              final ApplicationProperties applicationProperties) {
        super(userManager, renderer, loginUriProvider);
        this.applicationProperties = requireNonNull(applicationProperties);
        this.pluginAccessor = requireNonNull(pluginAccessor);
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

    // Can't use the non-deprecated getModuleDescriptors method until Fecru is on a newer version of Atlassian Plugins
    @SuppressWarnings("deprecation")
    private List<RestDescriptor> getRestDescriptors() {
        return pluginAccessor.getModuleDescriptors(describesRestModule()).stream()
                .map(RestBrowserServlet::getRestDescriptor)
                .filter(Optional::isPresent)
                .map(Optional::get)
                .collect(toList());
    }

    @SuppressWarnings("deprecation")
    private static <T> ModuleDescriptorPredicate<T> describesRestModule() {
        return md -> md != null &&
                ("com.atlassian.plugins.rest.module.RestServletFilterModuleDescriptor".equals(md.getClass().getName())
                        || "com.atlassian.plugins.rest.v2.descriptor.RestServletFilterModuleDescriptor".equals(md.getClass().getName()));
    }

    private static Optional<RestDescriptor> getRestDescriptor(final ModuleDescriptor<?> servlet) {
        // com.atlassian.plugins.rest.module is exported as private, and com.atlassian.plugins.rest.v2.descriptor is not exported,
        // so we have to use reflection to access the concrete descriptor we want
        Class<?>[] params = {};
        Object[] args = {};
        String basePath;
        Object apiVersion;
        String version;
        try {
            Method getBasePath = servlet.getClass().getMethod("getBasePath", params);
            basePath = (String) getBasePath.invoke(servlet, args);
            Method getVersion = servlet.getClass().getMethod("getVersion", params);
            apiVersion = getVersion.invoke(servlet, args);
            version = apiVersion.toString();
        } catch (final Exception e) {
            LOGGER.debug("Couldn't get REST module info from {}", servlet, e);
            return Optional.empty();
        }
        final Plugin plugin = servlet.getPlugin();
        return Optional.of(new RestDescriptor.Builder()
                .basePath(basePath)
                .pluginCompleteKey(servlet.getCompleteKey())
                .pluginDescription(servlet.getDescription())
                .pluginKey(plugin.getKey())
                .pluginName(plugin.getName())
                .version(version)
                .build());
    }
}
