package com.atlassian.labs.restbrowser.rest;

import com.atlassian.labs.restbrowser.json.Json;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Shared authentication, licensing, authorization, XSRF, and no-store error response helpers for REST endpoints
 * and servlets. Ensures licensed-user checks cannot silently drop if optional security annotations fail to resolve.
 */
public final class RestAuth {

    public static final String JSON_MEDIA_TYPE = MediaType.APPLICATION_JSON + ";charset=UTF-8";
    public static final String MARKDOWN_MEDIA_TYPE = "text/markdown;charset=UTF-8";

    private RestAuth() {
    }

    /** Returns true when {@code user} holds system administrator privileges, failing closed on lookup errors. */
    public static boolean isSystemAdmin(UserManager userManager, UserKey user) {
        if (userManager == null || user == null) {
            return false;
        }
        try {
            return userManager.isSystemAdmin(user);
        } catch (RuntimeException | LinkageError e) {
            return false;
        }
    }

    /** Returns true when {@code user} holds administrator privileges, failing closed on lookup errors. */
    public static boolean isAdmin(UserManager userManager, UserKey user) {
        if (userManager == null || user == null) {
            return false;
        }
        try {
            return userManager.isAdmin(user);
        } catch (RuntimeException | LinkageError e) {
            return false;
        }
    }

    /** Returns true when {@code user} is logged in AND holds a product license (or admin/sysadmin role). */
    public static boolean isLicensedUser(UserManager userManager, UserKey user) {
        if (userManager == null || user == null) {
            return false;
        }
        try {
            return userManager.isSystemAdmin(user) || userManager.isAdmin(user) || userManager.isLicensed(user);
        } catch (RuntimeException | LinkageError e) {
            return false;
        }
    }

    public static UserKey remoteUser(UserManager userManager, HttpServletRequest request) {
        if (userManager == null || request == null) {
            return null;
        }
        try {
            return userManager.getRemoteUserKey(request);
        } catch (RuntimeException | LinkageError e) {
            return null;
        }
    }

    /** Returns null when authorized as a licensed user, or a 401/403 JSON {@link Response}. */
    public static Response requireLicensed(UserManager userManager, HttpServletRequest request) {
        UserKey user = remoteUser(userManager, request);
        if (user == null) {
            return error(Response.Status.UNAUTHORIZED, "login-required");
        }
        if (!isLicensedUser(userManager, user)) {
            return error(Response.Status.FORBIDDEN, "licensed-user-required");
        }
        return null;
    }

    /** Returns null when authorized as a system administrator, or a 401/403 JSON {@link Response}. */
    public static Response requireSysadmin(UserManager userManager, HttpServletRequest request) {
        UserKey user = remoteUser(userManager, request);
        if (user == null) {
            return error(Response.Status.UNAUTHORIZED, "login-required");
        }
        if (!isSystemAdmin(userManager, user)) {
            return error(Response.Status.FORBIDDEN, "system-admin-only");
        }
        return null;
    }

    public static boolean xsrfHeader(HttpServletRequest request) {
        return "no-check".equals(request.getHeader("X-Atlassian-Token"));
    }

    public static Response error(Response.Status status, String code) {
        String body = new Json().beginObject().field("error", code).endObject().toString();
        return Response.status(status).type(JSON_MEDIA_TYPE).header("Cache-Control", "no-store").entity(body).build();
    }

    public static Response error(Response.Status status, String code, String hint) {
        String body = new Json().beginObject().field("error", code).optional("hint", hint).endObject().toString();
        return Response.status(status).type(JSON_MEDIA_TYPE).header("Cache-Control", "no-store").entity(body).build();
    }

    public static boolean wantsMarkdown(String format, HttpServletRequest request) {
        if ("markdown".equalsIgnoreCase(format) || "md".equalsIgnoreCase(format)) {
            return true;
        }
        if (format != null && !format.isBlank()) {
            return false;
        }
        return request != null && prefersMarkdown(request.getHeader("Accept"));
    }

    public static boolean prefersMarkdown(String accept) {
        return prefersMediaType(accept, "text/markdown", "application/json", "text/plain");
    }

    public static boolean prefersPlainText(String accept) {
        return prefersMediaType(accept, "text/plain", "application/json", "text/markdown");
    }

    private static boolean prefersMediaType(String accept, String target, String other1, String other2) {
        double targetQ = exactMediaQuality(accept, target);
        if (targetQ <= 0.0) {
            return false;
        }
        double competing = Math.max(
                Math.max(exactMediaQuality(accept, other1), exactMediaQuality(accept, other2)),
                exactMediaQuality(accept, "*/*"));
        return targetQ > competing;
    }

    static double exactMediaQuality(String accept, String targetType) {
        if (accept == null || accept.isBlank()) {
            return -1.0;
        }
        double best = -1.0;
        for (String raw : accept.split(",")) {
            String part = raw.trim();
            if (part.isEmpty()) {
                continue;
            }
            int semi = part.indexOf(';');
            String media = (semi < 0 ? part : part.substring(0, semi)).trim().toLowerCase(Locale.ROOT);
            if (!targetType.equals(media)) {
                continue;
            }
            double q = 1.0;
            if (semi >= 0) {
                for (String p : part.substring(semi + 1).split(";")) {
                    String kv = p.trim();
                    if (kv.toLowerCase(Locale.ROOT).startsWith("q=")) {
                        try {
                            double parsed = Double.parseDouble(kv.substring(2).trim());
                            q = Double.isFinite(parsed) && parsed >= 0.0 && parsed <= 1.0 ? parsed : 0.0;
                        } catch (NumberFormatException ignored) {
                            q = 0.0;
                        }
                    }
                }
            }
            best = Math.max(best, q);
        }
        return best;
    }

    /** Returns a 16-hex-char SHA-256 ETag token for arbitrary string components. */
    public static String shortEtag(String... parts) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            for (int i = 0; i < parts.length; i++) {
                if (i > 0) {
                    md.update((byte) '\n');
                }
                md.update(String.valueOf(parts[i]).getBytes(StandardCharsets.UTF_8));
            }
            return HexFormat.of().formatHex(md.digest(), 0, 8);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Evaluates HTTP {@code If-None-Match} (weak tags, quotes, {@code -gzip} suffixes, and {@code *}). */
    public static boolean matchesEtag(String ifNoneMatch, String tag) {
        if (ifNoneMatch == null || tag == null) {
            return false;
        }
        for (String candidate : ifNoneMatch.split(",")) {
            String c = candidate.trim();
            if (c.startsWith("W/")) {
                c = c.substring(2);
            }
            c = c.replace("\"", "");
            if (c.endsWith("-gzip")) {
                c = c.substring(0, c.length() - "-gzip".length());
            }
            if (c.equals(tag) || c.equals("*")) {
                return true;
            }
        }
        return false;
    }

    private static final Pattern VOLATILE_ETAG_FIELDS = Pattern.compile(
            ",\"(?:inspectMs|decompileMs)\":\\d+|,\"cached\":(?:true|false)");

    public static Response cacheableResponse(HttpServletRequest request, int status, String mediaType, String body) {
        return cacheableResponse(request, status, mediaType, body, null);
    }

    /** Returns an ETag-negotiated 200/304 response on success, or {@code Cache-Control: no-store} on error status. */
    public static Response cacheableResponse(HttpServletRequest request, int status, String mediaType,
                                             String body, String catalogHash) {
        if (status != 200) {
            Response.ResponseBuilder err = Response.status(status).type(mediaType).header("Cache-Control", "no-store")
                    .entity(body);
            if (catalogHash != null) {
                err.header("X-Catalog-Hash", catalogHash);
            }
            return err.build();
        }
        String stableBody = body == null ? "" : VOLATILE_ETAG_FIELDS.matcher(body).replaceAll("");
        String tag = shortEtag(mediaType, stableBody);
        String etag = "\"" + tag + "\"";
        if (request != null && matchesEtag(request.getHeader("If-None-Match"), tag)) {
            Response.ResponseBuilder nm = Response.notModified().header("ETag", etag)
                    .header("Cache-Control", "private, no-cache");
            if (catalogHash != null) {
                nm.header("X-Catalog-Hash", catalogHash);
            }
            return nm.build();
        }
        Response.ResponseBuilder ok = Response.ok(body, mediaType).header("ETag", etag)
                .header("Cache-Control", "private, no-cache");
        if (catalogHash != null) {
            ok.header("X-Catalog-Hash", catalogHash);
        }
        return ok.build();
    }
}
