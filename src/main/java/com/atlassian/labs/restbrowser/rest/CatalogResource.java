package com.atlassian.labs.restbrowser.rest;

import com.atlassian.annotations.security.LicensedOnly;
import com.atlassian.annotations.security.SystemAdminOnly;
import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.CatalogSnapshot;
import com.atlassian.labs.restbrowser.catalog.JerseyModelSource;
import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.State;
import com.atlassian.labs.restbrowser.catalog.OperationDetails;
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
 *     <li>{@code POST /catalog/refresh}: system administrators rebuild the catalog;</li>
 *     <li>{@code POST /catalog/started?module=id}: a module that had not started is read again, alone, once the page
 *     has started it with a request of its own (any licensed user);</li>
 *     <li>{@code GET /catalog/details?op=key}: system administrators see the Java behind one operation (its method
 *     and class, the OSGi bundle, the plugin and the REST module).</li>
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
    /** How long a start waits for its module to be read; a busy build thread answers 202, and the page follows. */
    static final long STARTED_WAIT_MS = 2_000;

    private final CatalogService catalog;
    private final UserManager userManager;
    private final ApplicationProperties applicationProperties;
    private final OperationDetails details;

    @Inject
    public CatalogResource(CatalogService catalog, UserManager userManager,
                           ApplicationProperties applicationProperties, OperationDetails details) {
        this.catalog = catalog;
        this.userManager = userManager;
        this.applicationProperties = applicationProperties;
        this.details = details;
    }

    @GET
    @Produces(MediaType.APPLICATION_JSON)
    public Response summary(@Context HttpServletRequest request) {
        if (!allowed(request)) {
            return unauthorized();
        }
        CatalogSnapshot snapshot = catalog.current(request.getServletContext());
        UserKey user = userManager.getRemoteUserKey(request);
        boolean sysadmin = user != null && userManager.isSystemAdmin(user);
        // a system administrator sees what administrators see, even where the product does not make them one too
        boolean admin = sysadmin || (user != null && userManager.isAdmin(user));
        String tag = tag(snapshot, admin, sysadmin);
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
        if (user == null) {
            return unauthorized(); // an expired session logs in again; it is not a missing permission
        }
        if (!userManager.isSystemAdmin(user)) {
            return error(Response.Status.FORBIDDEN, "system-admin-only");
        }
        if (!xsrfHeader(request)) {
            return error(Response.Status.FORBIDDEN, "xsrf-check-failed");
        }
        catalog.current(request.getServletContext());
        catalog.refresh(module == null || module.isBlank() ? null : module);
        return Response.noContent().build();
    }

    /**
     * Reads one module again that had not started. Some products (Confluence) start a REST module's Jersey
     * application on the first request to it, on each node, so the catalog cannot read it before; the page first sends
     * a request to the module (it lands on the same node, the session sticks to it), then asks for this. Any licensed
     * user may ask, for such a module only. The module's application must run now on this node, else nothing happens
     * (409 still-not-started), so asking again and again costs a lookup; then only that module is read, and the
     * catalog stays complete.
     * <ul>
     *     <li>200: read again, {@code {"state", "reason", "opCount"}} say how;</li>
     *     <li>202: being read (a build is running, or the module was pending anyway); the summary shows it once done;</li>
     *     <li>204: nothing to do, the module is described already;</li>
     *     <li>404: no such module; 409: still not started, or failed for another reason (not-waiting-to-start);</li>
     *     <li>500: the read failed, or the catalog is shutting down.</li>
     * </ul>
     */
    @POST
    @Path("/started")
    public Response started(@QueryParam("module") String module, @Context HttpServletRequest request) {
        if (!allowed(request)) {
            return unauthorized();
        }
        if (!xsrfHeader(request)) {
            return error(Response.Status.FORBIDDEN, "xsrf-check-failed");
        }
        ModuleEntry entry = catalog.current(request.getServletContext()).module(module).orElse(null);
        if (entry == null) {
            return error(Response.Status.NOT_FOUND, "unknown-module");
        }
        if (entry.state() == State.ok) {
            return Response.noContent().header("Cache-Control", "no-store").build();
        }
        if (entry.state() == State.pending) {
            return Response.accepted().header("Cache-Control", "no-store").build();
        }
        if (!JerseyModelSource.NOT_STARTED.equals(entry.reason())) {
            return error(Response.Status.CONFLICT, "not-waiting-to-start");
        }
        CatalogService.Started started = catalog.readStarted(module, STARTED_WAIT_MS);
        return switch (started.outcome()) {
            case READ -> Response.ok(entryJson(started.entry()), JSON).header("Cache-Control", "no-store").build();
            case QUEUED -> Response.accepted().header("Cache-Control", "no-store").build();
            case STILL_NOT_STARTED -> error(Response.Status.CONFLICT, "still-not-started");
            case UNKNOWN -> error(Response.Status.NOT_FOUND, "unknown-module");
            case FAILED -> error(Response.Status.INTERNAL_SERVER_ERROR, "read-failed");
        };
    }

    /** A module's state after a start: the state, its reason code (letters, digits and dashes only) and its operations. */
    static String entryJson(ModuleEntry e) {
        String reason = e.reason() == null ? "null" : "\"" + e.reason().replaceAll("[^A-Za-z0-9-]", "") + "\"";
        return "{\"state\":\"" + e.state().name() + "\",\"reason\":" + reason + ",\"opCount\":" + e.opCount() + "}";
    }

    /**
     * The Java behind one operation. System administrators only: it shows the internals of the product and its
     * apps (class names, code locations, the bundle wiring). Read on demand, never cached.
     */
    @GET
    @Path("/details")
    @Produces(MediaType.APPLICATION_JSON)
    @SystemAdminOnly
    public Response details(@QueryParam("op") String op, @Context HttpServletRequest request) {
        UserKey user = userManager.getRemoteUserKey(request);
        if (user == null) {
            return unauthorized();
        }
        if (!userManager.isSystemAdmin(user)) {
            return error(Response.Status.FORBIDDEN, "system-admin-only");
        }
        catalog.current(request.getServletContext()); // a module that has not started needs the ServletContext
        OperationDetails.Result result = details.describe(op);
        return Response.status(result.status()).type(JSON).header("Cache-Control", "no-store")
                .entity(result.json()).build();
    }

    /**
     * The summary's ETag: everything its body depends on. The admin tag covers the error details only admins see;
     * the last letter tells admins (a), system administrators (s) and other users (u) apart, so no two kinds of
     * user share a tag.
     */
    static String tag(CatalogSnapshot snapshot, boolean admin, boolean sysadmin) {
        return (admin ? snapshot.adminTag() : snapshot.hash()) + "-" + progress(snapshot) + "-"
                + (sysadmin ? "s" : admin ? "a" : "u");
    }

    /**
     * The summary's progress and completeness for its ETag: a rebuild of an unchanged catalog keeps its hash while
     * modules are read again, and the UI's counter must not freeze on a 304.
     */
    static String progress(CatalogSnapshot snapshot) {
        return (snapshot.complete() ? "c" : "p") + snapshot.done() + "." + snapshot.total();
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

    /** The X-Atlassian-Token: no-check header that the plugin's writes require (on top of the product's own check). */
    private static boolean xsrfHeader(HttpServletRequest request) {
        return "no-check".equals(request.getHeader("X-Atlassian-Token"));
    }

    /** An error answer: the status, {@code {"error": code}}, never cached. */
    private static Response error(Response.Status status, String code) {
        return Response.status(status).type(JSON).header("Cache-Control", "no-store")
                .entity("{\"error\":\"" + code + "\"}").build();
    }

    private static Response unauthorized() {
        return error(Response.Status.UNAUTHORIZED, "login-required");
    }
}
