package com.atlassian.labs.restbrowser.rest;

import com.atlassian.annotations.security.LicensedOnly;
import com.atlassian.annotations.security.XsrfProtectionExcluded;
import com.atlassian.labs.restbrowser.json.Json;
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
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Echoes outgoing browser + reverse-proxy request headers for the new UI's "Request headers" tab.
 * Never touches explored endpoint responses; strictly redacts cookies, credentials, and secret headers here so
 * scripts cannot read HttpOnly cookies or proxy auth tokens.
 */
@Path("/echo")
@LicensedOnly
public class EchoResource {

    /**
     * Whole words (or hyphenated bigrams) that mark a request header as secret.
     * Kept strictly synchronized with {@code isCredentialHeader} in frontend {@code lib/http-redact/redact.ts}.
     */
    static final Set<String> SECRET_WORDS = Set.of(
            "secret", "secrets", "password", "passwords", "passwd", "pwd",
            "session", "sessions", "sessionid",
            "cookie", "cookie2", "set-cookie", "set-cookie2",
            "api-key", "api-keys", "apikey", "apikeys",
            "private-key", "private-keys", "privatekey", "privatekeys",
            "signing-key", "signing-keys", "signingkey", "signingkeys",
            "access-key", "access-keys", "accesskey", "accesskeys",
            "secret-key", "secret-keys", "secretkey", "secretkeys",
            "subscription-key", "subscription-keys", "subscriptionkey",
            "functions-key", "functions-keys", "functionskey",
            "master-key", "master-keys", "masterkey",
            "client-key", "client-keys", "clientkey",
            "session-key", "session-keys", "sessionkey",
            "auth-key", "auth-keys", "authkey",
            "encryption-key", "encryption-keys", "encryptionkey",
            "passkey", "passkeys", "hmac-key",
            "token", "tokens", "credential", "credentials",
            "jwt", "assertion", "assertions", "signature", "signatures",
            "auth", "authz", "authorization", "authn", "bearer",
            "passphrase", "passphrases", "hmac", "digest", "otp", "mfa",
            "cert", "certs", "certificate", "certificates",
            "oidc", "sso", "saml", "principal", "jsessionid", "oauth", "csrf", "xsrf");

    static final Pattern SCHEME = Pattern.compile("^([A-Za-z][A-Za-z0-9._-]{0,31})\\s");

    /** Suffixes that classify a run-together HTTP/2 lowercased word as secret (e.g. {@code x-accesstoken}). */
    static final List<String> SECRET_ENDINGS = List.of(
            "token", "tokens", "secret", "secrets", "password", "passwords", "passwd",
            "apikey", "apikeys", "privatekey", "signingkey", "accesskey", "secretkey",
            "subscriptionkey", "functionskey", "masterkey", "clientkey", "sessionkey", "authkey",
            "passkey", "credential", "credentials", "sessionid", "signature", "cookie", "cookies",
            "bearer", "passphrase", "certificate", "certificates");

    /**
     * Unambiguous compound stems matched anywhere inside a word (catches HTTP/2 prefix compounds such as
     * {@code x-tokenvalue}, {@code x-authheader}, {@code x-jwtpayload}, {@code x-samlresponse} without matching
     * {@code X-Author-Id}, {@code X-Processor}, {@code X-Concert-Id}, or {@code X-Key-Id}).
     */
    static final List<String> SECRET_COMPOUND_STEMS = List.of(
            "token", "secret", "password", "passwd", "apikey", "privatekey", "accesskey",
            "signingkey", "secretkey", "subscriptionkey", "functionskey", "credential",
            "sessionid", "jsessionid", "setcookie", "cookievalue", "cookiedata", "bearer", "passphrase",
            "xsrf", "csrf", "saml", "oidc", "oauth", "jwt",
            "authheader", "webauth", "clientcert", "sslcert");

    static final int MAX_VALUE = 1000;

    private final UserManager userManager;

    @Inject
    public EchoResource(UserManager userManager) {
        this.userManager = userManager;
    }

    @GET @Produces(MediaType.APPLICATION_JSON)
    public Response get(@Context HttpServletRequest request) { return echo(request); }

    @POST @Produces(MediaType.APPLICATION_JSON) @XsrfProtectionExcluded
    public Response post(@Context HttpServletRequest request) { return echo(request); }

    @PUT @Produces(MediaType.APPLICATION_JSON) @XsrfProtectionExcluded
    public Response put(@Context HttpServletRequest request) { return echo(request); }

    @PATCH @Produces(MediaType.APPLICATION_JSON) @XsrfProtectionExcluded
    public Response patch(@Context HttpServletRequest request) { return echo(request); }

    @DELETE @Produces(MediaType.APPLICATION_JSON) @XsrfProtectionExcluded
    public Response delete(@Context HttpServletRequest request) { return echo(request); }

    private Response echo(HttpServletRequest request) {
        Response denied = RestAuth.requireLicensed(userManager, request);
        if (denied != null) {
            return denied;
        }
        return Response.ok(json(request), RestAuth.JSON_MEDIA_TYPE).header("Cache-Control", "no-store").build();
    }

    static String json(HttpServletRequest request) {
        Json j = new Json().beginObject()
                .field("method", request.getMethod())
                .name("headers").beginArray();
        Enumeration<String> names = request.getHeaderNames();
        if (names != null) {
            for (String name : Collections.list(names)) {
                Enumeration<String> values = request.getHeaders(name);
                if (values == null) {
                    continue;
                }
                for (String value : Collections.list(values)) {
                    j.beginArray().value(name).value(safe(name, value)).endArray();
                }
            }
        }
        return j.endArray().endObject().toString();
    }

    static String safe(String name, String value) {
        String n = name == null ? "" : name.trim().toLowerCase(Locale.ROOT);
        if (value == null) {
            return "";
        }
        if (n.equals("cookie") || n.equals("cookie2") || n.equals("set-cookie") || n.equals("set-cookie2")) {
            List<String> cookies = new ArrayList<>();
            for (String c : value.split(";")) {
                String t = c.trim();
                int eq = t.indexOf('=');
                if (!t.isEmpty()) {
                    cookies.add(eq < 0 ? "… (a value without a name, " + t.length() + " characters, hidden)"
                            : t.substring(0, eq) + "=… (" + (t.length() - eq - 1) + " characters, hidden)");
                }
            }
            String joined = String.join("; ", cookies);
            return joined.length() <= MAX_VALUE ? joined
                    : joined.substring(0, MAX_VALUE) + "… (" + joined.length() + " characters)";
        }
        if (n.equals("authorization") || n.equals("proxy-authorization")) {
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
        return value.substring(0, end) + "…";
    }

    static boolean secret(String name) {
        if (name == null) {
            return false;
        }
        String n = name.trim().toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-");
        if (n.equals("x-atlassian-token")) {
            return false;
        }
        String[] words = n.split("-");
        for (int i = 0; i < words.length; i++) {
            String w = words[i];
            if (SECRET_WORDS.contains(w)
                    || (i + 1 < words.length && SECRET_WORDS.contains(w + "-" + words[i + 1]))) {
                return true;
            }
            for (String ending : SECRET_ENDINGS) {
                if (w.length() > ending.length() && w.endsWith(ending)) {
                    return true;
                }
            }
            for (String stem : SECRET_COMPOUND_STEMS) {
                if (w.contains(stem)) {
                    return true;
                }
            }
        }
        return false;
    }
}
