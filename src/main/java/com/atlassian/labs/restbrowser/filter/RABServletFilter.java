package com.atlassian.labs.restbrowser.filter;

import com.atlassian.jira.util.velocity.VelocityRequestContextFactory;
import com.atlassian.sal.api.auth.LoginUriProvider;
import com.atlassian.sal.api.user.UserManager;
import com.atlassian.templaterenderer.TemplateRenderer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import javax.servlet.*;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.URI;
import java.util.HashMap;
import java.util.Map;

public class RABServletFilter implements Filter{
    private static final Logger log = LoggerFactory.getLogger(RABServletFilter.class);
    private final TemplateRenderer templateRenderer;
    private final VelocityRequestContextFactory requestContextFactory;
    private final UserManager userManager;
    private final LoginUriProvider loginUriProvider;

    public RABServletFilter(TemplateRenderer templateRenderer, VelocityRequestContextFactory requestContextFactory, UserManager userManager, LoginUriProvider loginUriProvider) {
        this.templateRenderer = templateRenderer;
        this.requestContextFactory = requestContextFactory;
        this.userManager = userManager;
        this.loginUriProvider = loginUriProvider;
    }

    public void init(FilterConfig filterConfig)throws ServletException{
    }

    public void destroy(){
    }

    public void doFilter(ServletRequest request,ServletResponse response,FilterChain chain)throws IOException,ServletException{
        HttpServletRequest httpServletRequest = (HttpServletRequest) request;
        HttpServletResponse httpServletResponse = (HttpServletResponse) response;
        String username = userManager.getRemoteUsername(httpServletRequest);
        if (username == null)
        {
            redirectToLogin(httpServletRequest, httpServletResponse);
            return;
        }

        final Map<String, Object> context = new HashMap<String, Object>();

        context.put("req", requestContextFactory.getJiraVelocityRequestContext());
        response.setContentType("text/html;charset=utf-8");
        templateRenderer.render("templates/browser.vm", context, response.getWriter());
        //continue the request
        chain.doFilter(request,response);
    }

    private void redirectToLogin(HttpServletRequest request, HttpServletResponse response) throws IOException
    {
        response.sendRedirect(loginUriProvider.getLoginUri(getUri(request)).toASCIIString());
    }

    private URI getUri(HttpServletRequest request)
    {
        StringBuffer builder = request.getRequestURL();
        if (request.getQueryString() != null)
        {
            builder.append("?");
            builder.append(request.getQueryString());
        }
        return URI.create(builder.toString());
    }

}
