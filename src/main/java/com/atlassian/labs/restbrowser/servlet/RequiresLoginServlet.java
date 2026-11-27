package com.atlassian.labs.restbrowser.servlet;

import com.atlassian.labs.restbrowser.rest.RestAuth;
import com.atlassian.sal.api.auth.LoginUriProvider;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import com.atlassian.templaterenderer.TemplateRenderer;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.URI;
import java.util.Map;

import static java.util.Objects.requireNonNull;

/**
 * Sends anonymous users to the login page (unless {@link #allowAnonymous()} is enabled) and blocks logged-in
 * unlicensed accounts with 403 Forbidden.
 */
public abstract class RequiresLoginServlet extends HttpServlet {

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

    protected abstract String getTemplatePath();

    protected abstract Map<String, Object> getContext(HttpServletRequest request);

    protected boolean allowAnonymous() {
        return Boolean.getBoolean(RAB_ANONYMOUS);
    }

    protected boolean handleRequest(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        return false;
    }

    @Override
    protected final void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        UserKey user = userManager.getRemoteUserKey(req);
        if (user == null && !allowAnonymous()) {
            redirectToLogin(req, resp);
            return;
        }
        if (!allowAnonymous() && !RestAuth.isLicensedUser(userManager, user)) {
            resp.sendError(HttpServletResponse.SC_FORBIDDEN, "A product license is required to use REST API Browser.");
            return;
        }
        if (!handleRequest(req, resp)) {
            StringWriter buf = new StringWriter(4096);
            renderer.render(getTemplatePath(), getContext(req), buf);
            resp.setHeader("Cache-Control", "private, no-store");
            resp.setContentType("text/html;charset=utf-8");
            PrintWriter out = resp.getWriter();
            out.write(buf.toString());
            out.flush();
        }
    }

    private void redirectToLogin(final HttpServletRequest request, final HttpServletResponse response) throws IOException {
        response.sendRedirect(loginUriProvider.getLoginUri(getUri(request)).toASCIIString());
    }

    static URI getUri(final HttpServletRequest request) {
        final StringBuilder builder = new StringBuilder(request.getRequestURL());
        if (request.getQueryString() != null) {
            builder.append("?").append(request.getQueryString());
        }
        return URI.create(encodeIllegal(builder.toString()));
    }

    private static final String ILLEGAL = "{}|\\^`\"<> []#";

    static String encodeIllegal(String uri) {
        final int schemeEnd = uri.indexOf("://");
        final int afterAuth = schemeEnd > 0 && isScheme(uri, schemeEnd)
                ? Math.min(indexOrEnd(uri, '/', schemeEnd + 3), indexOrEnd(uri, '?', schemeEnd + 3))
                : 0;
        return encodeIllegalFrom(uri, afterAuth);
    }

    static String encodeQuery(String query) {
        return encodeIllegalFrom(query, 0);
    }

    private static String encodeIllegalFrom(String value, int startIndex) {
        final StringBuilder out = new StringBuilder(value.length()).append(value, 0, startIndex);
        final String rest = value.substring(startIndex);
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

    private static boolean isScheme(String s, int end) {
        char first = s.charAt(0);
        if (!((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z'))) {
            return false;
        }
        for (int i = 1; i < end; i++) {
            char c = s.charAt(i);
            if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '+' || c == '-' || c == '.')) {
                return false;
            }
        }
        return true;
    }

    private static int indexOrEnd(String s, char c, int from) {
        final int i = s.indexOf(c, from);
        return i < 0 ? s.length() : i;
    }

    private static boolean isHex(String s, int i) {
        if (i >= s.length()) {
            return false;
        }
        final char c = s.charAt(i);
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
    }
}
