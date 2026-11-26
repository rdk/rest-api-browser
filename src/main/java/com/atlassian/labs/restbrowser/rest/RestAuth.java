package com.atlassian.labs.restbrowser.rest;

import com.atlassian.labs.restbrowser.json.Json;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

/**
 * Shared authentication, licensing, authorization, XSRF, and no-store error response helpers for REST endpoints
 * and servlets. Ensures licensed-user checks cannot silently drop if optional security annotations fail to resolve.
 */
public final class RestAuth {

    public static final String JSON_MEDIA_TYPE = MediaType.APPLICATION_JSON + ";charset=UTF-8";

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
}
