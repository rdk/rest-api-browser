package com.atlassian.labs.restbrowser.rest;

import com.atlassian.annotations.security.LicensedOnly;
import com.atlassian.annotations.security.SystemAdminOnly;
import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.CatalogSnapshot;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.UrlMode;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import jakarta.inject.Inject;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.Context;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.core.StreamingOutput;

/**
 * The catalog of this node's REST API, for the new UI.
 * <ul>
 *     <li>{@code GET /catalog}: the small summary, per user, with an ETag;</li>
 *     <li>{@code GET /catalog/index/{hash}}: every operation, the same for every user, cached forever once
 *     complete;</li>
 *     <li>{@code POST /catalog/refresh}: system administrators rebuild the catalog.</li>
 * </ul>
 * Who may read it: licensed users. The catalog lists every endpoint and app of the instance, so unlicensed accounts
 * (for example service desk portal customers) and anonymous users get nothing, whatever
 * {@code -Drest.api.browser.anonymous} says for the classic page.
 */
@Path("/catalog")
@LicensedOnly
public class CatalogResource {

    static final String JSON = MediaType.APPLICATION_JSON + ";charset=UTF-8";
    static final String IMMUTABLE = "private, max-age=31536000, immutable";

    private final CatalogService catalog;
    private final UserManager userManager;
    private final ApplicationProperties applicationProperties;

    @Inject
    public CatalogResource(CatalogService catalog, UserManager userManager,
                           ApplicationProperties applicationProperties) {
        this.catalog = catalog;
        this.userManager = userManager;
        this.applicationProperties = applicationProperties;
    }

    @GET
    @Produces(MediaType.APPLICATION_JSON)
    public Response summary(@Context HttpServletRequest request) {
        if (!allowed(request)) {
            return unauthorized();
        }
        CatalogSnapshot snapshot = catalog.current(request.getServletContext());
        UserKey user = userManager.getRemoteUserKey(request);
        boolean admin = user != null && userManager.isAdmin(user);
        boolean sysadmin = user != null && userManager.isSystemAdmin(user);
        String tag = admin ? snapshot.adminTag() + (sysadmin ? "-s" : "-a") : snapshot.hash() + "-u";
        String etag = "\"" + tag + "\"";
        if (matches(request.getHeader("If-None-Match"), tag)) {
            return Response.notModified().header("ETag", etag).header("Cache-Control", "private, no-cache").build();
        }
        String body = snapshot.summary(applicationProperties.getDisplayName(), applicationProperties.getVersion(),
                applicationProperties.getBuildNumber(), applicationProperties.getBaseUrl(UrlMode.RELATIVE), admin,
                sysadmin);
        return Response.ok(body, JSON).header("ETag", etag).header("Cache-Control", "private, no-cache").build();
    }

    @GET
    @Path("/index/{hash}")
    @Produces(MediaType.APPLICATION_JSON)
    public Response index(@PathParam("hash") String hash, @Context HttpServletRequest request) {
        if (!allowed(request)) {
            return unauthorized();
        }
        CatalogSnapshot snapshot = catalog.current(request.getServletContext());
        if (!snapshot.hash().equals(hash)) {
            // another node's or an older catalog: the client fetches the summary again
            return Response.status(Response.Status.NOT_FOUND).header("Cache-Control", "no-store")
                    .type(JSON).entity("{\"error\":\"unknown-hash\",\"hash\":\"" + snapshot.hash() + "\"}").build();
        }
        StreamingOutput body = snapshot::writeIndex;
        return Response.ok(body, JSON).header("Content-Length", snapshot.indexLength())
                .header("Cache-Control", snapshot.complete() ? IMMUTABLE : "private, no-cache").build();
    }

    @POST
    @Path("/refresh")
    @SystemAdminOnly
    public Response refresh(@QueryParam("module") String module, @Context HttpServletRequest request) {
        UserKey user = userManager.getRemoteUserKey(request);
        if (user == null || !userManager.isSystemAdmin(user)) {
            return Response.status(Response.Status.FORBIDDEN).type(JSON)
                    .entity("{\"error\":\"system-admin-only\"}").build();
        }
        if (!"no-check".equals(request.getHeader("X-Atlassian-Token"))) {
            return Response.status(Response.Status.FORBIDDEN).type(JSON)
                    .entity("{\"error\":\"xsrf-check-failed\"}").build();
        }
        catalog.current(request.getServletContext());
        catalog.refresh(module == null || module.isBlank() ? null : module);
        return Response.noContent().build();
    }

    /** A second line behind @LicensedOnly: never anonymous, whatever the classic page allows. */
    private boolean allowed(HttpServletRequest request) {
        return userManager.getRemoteUserKey(request) != null;
    }

    /**
     * Whether an If-None-Match header names this tag: weak tags (W/), a suffix a compression filter may add
     * ("-gzip") and lists are accepted.
     */
    static boolean matches(String ifNoneMatch, String tag) {
        if (ifNoneMatch == null) {
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

    private static Response unauthorized() {
        return Response.status(Response.Status.UNAUTHORIZED).header("Cache-Control", "no-store").type(JSON)
                .entity("{\"error\":\"login-required\"}").build();
    }
}
