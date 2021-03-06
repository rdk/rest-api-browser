package com.atlassian.labs.restbrowser.servlet;


import java.io.IOException;
import java.net.URI;
import java.util.Map;

import javax.servlet.ServletException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

import com.atlassian.sal.api.auth.LoginUriProvider;
import com.atlassian.sal.api.user.UserManager;
import com.atlassian.templaterenderer.TemplateRenderer;

import static com.google.common.base.Preconditions.checkNotNull;

public abstract class RequiresLoginServlet extends HttpServlet {

    private final UserManager userManager;
    private final TemplateRenderer renderer;
    private final LoginUriProvider loginUriProvider;
    private final static String RAB_ANONYMOUS = "rest.api.browser.anonymous";

    public RequiresLoginServlet(UserManager userManager, TemplateRenderer renderer, LoginUriProvider loginUriProvider) {
        this.userManager = checkNotNull(userManager, "userManager");
        this.renderer = checkNotNull(renderer, "renderer");
        this.loginUriProvider = checkNotNull(loginUriProvider, "loginUriProvider");
    }

    public abstract String getTemplatePath();

    public abstract Map<String, Object> getContext(HttpServletRequest request);

    @Override
    protected final void doGet(HttpServletRequest req, HttpServletResponse resp) throws ServletException, IOException {
        if (!Boolean.getBoolean(RAB_ANONYMOUS)) {
            String username = userManager.getRemoteUsername(req);
            if (username == null) {
                redirectToLogin(req, resp);
                return;
            }
        }

        resp.setContentType("text/html;charset=utf-8");
        renderer.render(getTemplatePath(), getContext(req), resp.getWriter());
    }

    private void redirectToLogin(HttpServletRequest request, HttpServletResponse response) throws IOException {
        response.sendRedirect(loginUriProvider.getLoginUri(getUri(request)).toASCIIString());
    }

    private URI getUri(HttpServletRequest request) {
        StringBuffer builder = request.getRequestURL();
        if (request.getQueryString() != null) {
            builder.append("?");
            builder.append(request.getQueryString());
        }
        return URI.create(builder.toString());
    }

}
