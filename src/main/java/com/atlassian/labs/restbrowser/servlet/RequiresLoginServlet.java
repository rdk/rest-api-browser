package com.atlassian.labs.restbrowser.servlet;

import com.atlassian.sal.api.auth.LoginUriProvider;
import com.atlassian.sal.api.user.UserManager;
import com.atlassian.templaterenderer.TemplateRenderer;

import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.URI;
import java.util.Map;

import static java.util.Objects.requireNonNull;

/**
 * Sends anonymous users to the login page if anonymous usage is not allowed.
 */
public abstract class RequiresLoginServlet extends HttpServlet {

    /**
     * If this system property is set to "true", the RAB can be used anonymously.
     * Otherwise, the user needs to be logged in.
     */
    public static final String RAB_ANONYMOUS = "rest.api.browser.anonymous";

    private final LoginUriProvider loginUriProvider;
    private final TemplateRenderer renderer;
    private final UserManager userManager;

    protected RequiresLoginServlet(
            final UserManager userManager, final TemplateRenderer renderer, final LoginUriProvider loginUriProvider) {
        this.loginUriProvider = requireNonNull(loginUriProvider, "loginUriProvider");
        this.renderer = requireNonNull(renderer, "renderer");
        this.userManager = requireNonNull(userManager, "userManager");
    }

    /**
     * Subclasses must return the template for the view to be rendered.
     *
     * @return a valid template path
     * @see #getContext(HttpServletRequest)
     */
    protected abstract String getTemplatePath();

    /**
     * Subclasses must return the model required by the view.
     *
     * @param request the request
     * @return the model
     * @see #getTemplatePath()
     */
    protected abstract Map<String, Object> getContext(HttpServletRequest request);

    @Override
    protected final void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        if (loginRequired(req)) {
            redirectToLogin(req, resp);
        } else {
            resp.setContentType("text/html;charset=utf-8");
            renderer.render(getTemplatePath(), getContext(req), resp.getWriter());
        }
    }

    private boolean loginRequired(final HttpServletRequest req) {
        return !Boolean.getBoolean(RAB_ANONYMOUS) && userManager.getRemoteUserKey(req) == null;
    }

    private void redirectToLogin(final HttpServletRequest request, final HttpServletResponse response) throws IOException {
        response.sendRedirect(loginUriProvider.getLoginUri(getUri(request)).toASCIIString());
    }

    private static URI getUri(final HttpServletRequest request) {
        final StringBuffer builder = request.getRequestURL();
        if (request.getQueryString() != null) {
            builder.append("?");
            builder.append(request.getQueryString());
        }
        return URI.create(builder.toString());
    }
}
