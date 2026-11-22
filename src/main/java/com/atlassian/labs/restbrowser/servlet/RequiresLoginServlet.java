package com.atlassian.labs.restbrowser.servlet;

import com.atlassian.sal.api.auth.LoginUriProvider;
import com.atlassian.sal.api.user.UserManager;
import com.atlassian.templaterenderer.TemplateRenderer;

import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
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

    static URI getUri(final HttpServletRequest request) {
        final StringBuilder builder = new StringBuilder(request.getRequestURL());
        if (request.getQueryString() != null) {
            builder.append("?");
            builder.append(request.getQueryString());
        }
        return URI.create(encodeIllegal(builder.toString()));
    }

    /** Characters URI.create rejects in a path or query, which browsers may send unencoded. */
    private static final String ILLEGAL = "{}|\\^`\"<> []#";

    /**
     * Percent-encodes what a URI may not contain in its path and query (braces of deep links, brackets, a stray
     * percent sign or #, spaces, non-ASCII), leaving the scheme and authority as they are (an IPv6 host has brackets).
     */
    static String encodeIllegal(String uri) {
        final int schemeEnd = uri.indexOf("://");
        final int pathStart = schemeEnd < 0 ? 0 : indexOrEnd(uri, '/', schemeEnd + 3);
        final StringBuilder out = new StringBuilder(uri.length()).append(uri, 0, pathStart);
        final String rest = uri.substring(pathStart);
        for (int i = 0; i < rest.length(); ) {
            final int c = rest.codePointAt(i);
            final int len = Character.charCount(c);
            final boolean strayPercent = c == '%' && !(isHex(rest, i + 1) && isHex(rest, i + 2));
            if (strayPercent || ILLEGAL.indexOf(c) >= 0 || c < 0x20 || c > 0x7e) {
                for (byte b : new String(Character.toChars(c)).getBytes(java.nio.charset.StandardCharsets.UTF_8)) {
                    out.append('%').append(String.format("%02X", b & 0xff));
                }
            } else {
                out.appendCodePoint(c);
            }
            i += len;
        }
        return out.toString();
    }

    private static int indexOrEnd(String s, char c, int from) {
        final int i = s.indexOf(c, from);
        return i < 0 ? s.length() : i;
    }

    private static boolean isHex(String s, int i) {
        if (i >= s.length()) {
            return false;
        }
        final char c = s.charAt(i); // ASCII only: Character.digit also accepts other scripts' digits
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    }
}
