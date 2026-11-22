package com.atlassian.labs.restbrowser.servlet;

import com.atlassian.annotations.security.AnonymousSiteAccess;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.UrlMode;
import com.atlassian.sal.api.auth.LoginUriProvider;
import com.atlassian.sal.api.user.UserManager;
import com.atlassian.templaterenderer.TemplateRenderer;
import jakarta.servlet.http.HttpServletRequest;

import java.util.HashMap;
import java.util.Map;

import static java.util.Objects.requireNonNull;

/**
 * Renders the new UI's page: the product's decorated page with an empty root element. The page has no inline
 * script; the app reads its context from the root element's attributes and its data from the catalog REST API.
 */
@AnonymousSiteAccess
public class NextServlet extends RequiresLoginServlet {

    private final ApplicationProperties applicationProperties;

    public NextServlet(UserManager userManager, TemplateRenderer renderer, LoginUriProvider loginUriProvider,
                       ApplicationProperties applicationProperties) {
        super(userManager, renderer, loginUriProvider);
        this.applicationProperties = requireNonNull(applicationProperties);
    }

    @Override
    protected String getTemplatePath() {
        return "/templates/next.vm";
    }

    @Override
    protected Map<String, Object> getContext(HttpServletRequest request) {
        Map<String, Object> context = new HashMap<>();
        context.put("baseUrl", applicationProperties.getBaseUrl(UrlMode.RELATIVE));
        context.put("productName", applicationProperties.getDisplayName());
        return context;
    }
}
