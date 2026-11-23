package com.atlassian.labs.restbrowser.rest;

import com.atlassian.annotations.security.LicensedOnly;
import com.atlassian.annotations.security.XsrfProtectionExcluded;
import com.atlassian.sal.api.user.UserManager;
import jakarta.inject.Inject;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.ws.rs.DELETE;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.PATCH;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.PUT;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.Context;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The headers of a request as the server received them: what the browser added (User-Agent, Accept-Language,
 * Sec-Fetch-*, cookies) and what proxies added on the way, which a page cannot read itself. The new UI sends a copy
 * of a request here (same method and headers, no body) to show them beside the headers it set.
 * <p>
 * Secrets never come back: cookies are listed by name and length only (a page's script must not read an HttpOnly
 * session cookie through this), credentials by scheme only, and headers named like a secret not at all.
 */
@Path("/echo")
@LicensedOnly
public class EchoResource {

    /**
     * The words of a header name that make its value a secret: keys, tokens and passwords, and what a proxy adds
     * about the user (client certificates, OIDC and SAML data). Whole words only, so X-Author-Id and X-Processor
     * stay visible; "api-key" is two. The new UI keeps the same names out of its history (isCredentialHeader).
     */
    static final Set<String> SECRET_WORDS = Set.of("secret", "secrets", "password", "passwords", "passwd", "pwd",
            "session", "sessions", "sessionid", "api-key", "api-keys", "apikey", "apikeys", "token", "tokens",
            "credential", "credentials", "jwt", "assertion", "assertions", "signature", "signatures", "auth",
            "authorization", "authn", "cert", "certs", "certificate", "certificates", "oidc", "sso", "saml",
            "principal", "jsessionid", "oauth", "csrf", "xsrf");
    /** An authorization scheme as it may be shown (Basic, Bearer, Negotiate, AWS4-HMAC-SHA256), then whitespace. */
    static final Pattern SCHEME = Pattern.compile("^([A-Za-z][A-Za-z0-9._-]{0,31})\\s");
    /**
     * Endings that make a run-together word a secret too: HTTP/2 lowercases header names, so X-AccessToken arrives as
     * x-accesstoken, one word. A word is secret when it is longer than the ending and ends with it (accesstoken,
     * apitoken, clientsecret, xapikey).
     */
    static final List<String> SECRET_ENDINGS = List.of("token", "tokens", "secret", "secrets", "password", "passwords",
            "passwd", "apikey", "apikeys", "credential", "credentials", "sessionid", "signature");
    static final int MAX_VALUE = 1000;

    private final UserManager userManager;

    @Inject
    public EchoResource(UserManager userManager) {
        this.userManager = userManager;
    }

    @GET
    @Produces(MediaType.APPLICATION_JSON)
    public Response get(@Context HttpServletRequest request) {
        return echo(request);
    }

    // No XSRF check here and below: the echo changes nothing, and a copy sent without X-Atlassian-Token must arrive.
    @POST
    @Produces(MediaType.APPLICATION_JSON)
    @XsrfProtectionExcluded
    public Response post(@Context HttpServletRequest request) {
        return echo(request);
    }

    @PUT
    @Produces(MediaType.APPLICATION_JSON)
    @XsrfProtectionExcluded
    public Response put(@Context HttpServletRequest request) {
        return echo(request);
    }

    @PATCH
    @Produces(MediaType.APPLICATION_JSON)
    @XsrfProtectionExcluded
    public Response patch(@Context HttpServletRequest request) {
        return echo(request);
    }

    @DELETE
    @Produces(MediaType.APPLICATION_JSON)
    @XsrfProtectionExcluded
    public Response delete(@Context HttpServletRequest request) {
        return echo(request);
    }

    private Response echo(HttpServletRequest request) {
        if (userManager.getRemoteUserKey(request) == null) {
            return Response.status(Response.Status.UNAUTHORIZED).type(CatalogResource.JSON).header("Cache-Control", "no-store")
                    .entity("{\"error\":\"login-required\"}").build();
        }
        return Response.ok(json(request), CatalogResource.JSON).header("Cache-Control", "no-store").build();
    }

    static String json(HttpServletRequest request) {
        StringBuilder out = new StringBuilder("{\"method\":").append(quote(request.getMethod())).append(",\"headers\":[");
        boolean first = true;
        for (String name : Collections.list(request.getHeaderNames())) {
            for (String value : Collections.list(request.getHeaders(name))) {
                out.append(first ? "" : ",").append('[').append(quote(name)).append(',').append(quote(safe(name, value))).append(']');
                first = false;
            }
        }
        return out.append("]}").toString();
    }

    /**
     * The value as it may be shown: cookies by name and length (a cookie without a name by its length only),
     * credentials by scheme, secrets not at all.
     */
    static String safe(String name, String value) {
        String n = name.toLowerCase(Locale.ROOT);
        if (value == null) {
            return "";
        }
        if (n.equals("cookie") || n.equals("cookie2") || n.equals("set-cookie")) {
            List<String> cookies = new ArrayList<>();
            for (String c : value.split(";")) {
                String t = c.trim();
                int eq = t.indexOf('=');
                if (!t.isEmpty()) {
                    cookies.add(eq < 0 ? "… (a value without a name, " + t.length() + " characters, hidden)"
                            : t.substring(0, eq) + "=… (" + (t.length() - eq - 1) + " characters, hidden)");
                }
            }
            return String.join("; ", cookies);
        }
        if (n.equals("authorization") || n.equals("proxy-authorization")) {
            // the first word only when it looks like a scheme: a bare token with a space in it stays hidden whole
            Matcher scheme = SCHEME.matcher(value);
            return (scheme.find() ? scheme.group(1) + " " : "") + "… (hidden)";
        }
        if (secret(name)) {
            return "… (hidden)";
        }
        if (value.length() <= MAX_VALUE) {
            return value;
        }
        int end = Character.isHighSurrogate(value.charAt(MAX_VALUE - 1)) ? MAX_VALUE - 1 : MAX_VALUE;
        return value.substring(0, end) + "…"; // never half of a surrogate pair
    }

    /**
     * Whether a header's value is a secret, by the words of its name once separators are dashes: X_API_KEY,
     * x-api-key and X-ApiKey alike. X-Atlassian-Token ("no-check") is not a secret.
     */
    static boolean secret(String name) {
        String n = name.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-");
        if (n.equals("x-atlassian-token")) {
            return false;
        }
        String[] words = n.split("-");
        for (int i = 0; i < words.length; i++) {
            if (SECRET_WORDS.contains(words[i])
                    || (i + 1 < words.length && SECRET_WORDS.contains(words[i] + "-" + words[i + 1]))) {
                return true;
            }
            for (String ending : SECRET_ENDINGS) {
                if (words[i].length() > ending.length() && words[i].endsWith(ending)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static String quote(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (char c : String.valueOf(s).toCharArray()) {
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '<' -> b.append("\\u003c");
                default -> {
                    if (c < 0x20) {
                        b.append(String.format("\\u%04x", (int) c));
                    } else {
                        b.append(c);
                    }
                }
            }
        }
        return b.append('"').toString();
    }
}
