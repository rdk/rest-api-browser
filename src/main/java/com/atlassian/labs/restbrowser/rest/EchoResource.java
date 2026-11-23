package com.atlassian.labs.restbrowser.rest;

import com.atlassian.annotations.security.LicensedOnly;
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

    /** Header names whose values are secrets; X-Atlassian-Token ("no-check") is not one. */
    static final Pattern SECRET = Pattern.compile("(?i)secret|password|passwd|session|api-?key|token|credential");
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

    @POST
    @Produces(MediaType.APPLICATION_JSON)
    public Response post(@Context HttpServletRequest request) {
        return echo(request);
    }

    @PUT
    @Produces(MediaType.APPLICATION_JSON)
    public Response put(@Context HttpServletRequest request) {
        return echo(request);
    }

    @PATCH
    @Produces(MediaType.APPLICATION_JSON)
    public Response patch(@Context HttpServletRequest request) {
        return echo(request);
    }

    @DELETE
    @Produces(MediaType.APPLICATION_JSON)
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

    /** The value as it may be shown: cookies by name and length, credentials by scheme, secrets not at all. */
    static String safe(String name, String value) {
        String n = name.toLowerCase(Locale.ROOT);
        if (value == null) {
            return "";
        }
        if (n.equals("cookie")) {
            List<String> cookies = new ArrayList<>();
            for (String c : value.split(";")) {
                String t = c.trim();
                int eq = t.indexOf('=');
                if (!t.isEmpty()) {
                    cookies.add(eq < 0 ? t : t.substring(0, eq) + "=… (" + (t.length() - eq - 1) + " characters, hidden)");
                }
            }
            return String.join("; ", cookies);
        }
        if (n.equals("authorization") || n.equals("proxy-authorization")) {
            int space = value.indexOf(' ');
            return (space < 0 ? "" : value.substring(0, space) + " ") + "… (hidden)";
        }
        if (!n.equals("x-atlassian-token") && SECRET.matcher(n).find()) {
            return "… (hidden)";
        }
        return value.length() <= MAX_VALUE ? value : value.substring(0, MAX_VALUE) + "…";
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
