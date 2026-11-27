package com.atlassian.labs.restbrowser.rest;

import com.atlassian.labs.restbrowser.catalog.CatalogQuery;
import com.atlassian.labs.restbrowser.catalog.OpenApiExporter;

import com.atlassian.annotations.security.LicensedOnly;
import com.atlassian.annotations.security.SystemAdminOnly;
import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.CatalogSnapshot;
import com.atlassian.labs.restbrowser.catalog.JerseyModelSource;
import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.State;
import com.atlassian.labs.restbrowser.catalog.OperationDetails;
import com.atlassian.labs.restbrowser.catalog.OperationSource;
import com.atlassian.labs.restbrowser.json.Json;
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

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * The catalog of this node's REST API, for the new UI.
 */
@Path("/catalog")
@LicensedOnly
public class CatalogResource {

    static final String JSON = RestAuth.JSON_MEDIA_TYPE;
    static final String IMMUTABLE = "private, max-age=31536000, immutable";
    static final long STARTED_WAIT_MS = 2_000;

    private final CatalogService catalog;
    private final UserManager userManager;
    private final ApplicationProperties applicationProperties;
    private final OperationDetails details;
    private final OperationSource source;

    @Inject
    public CatalogResource(CatalogService catalog, UserManager userManager,
                           ApplicationProperties applicationProperties, OperationDetails details,
                           OperationSource source) {
        this.catalog = catalog;
        this.userManager = userManager;
        this.applicationProperties = applicationProperties;
        this.details = details;
        this.source = source;
    }

    CatalogResource(CatalogService catalog, UserManager userManager,
                    ApplicationProperties applicationProperties, OperationDetails details) {
        this(catalog, userManager, applicationProperties, details, null);
    }

    @GET
    @Produces(MediaType.APPLICATION_JSON)
    public Response summary(@Context HttpServletRequest request) {
        Response denied = RestAuth.requireLicensed(userManager, request);
        if (denied != null) {
            return denied;
        }
        CatalogSnapshot snapshot = catalog.current(request.getServletContext());
        UserKey user = userManager.getRemoteUserKey(request);
        boolean sysadmin = RestAuth.isSystemAdmin(userManager, user);
        boolean admin = sysadmin || RestAuth.isAdmin(userManager, user);
        String productName = applicationProperties.getDisplayName();
        String productVersion = applicationProperties.getVersion();
        String productBuild = applicationProperties.getBuildNumber();
        String baseUrl = applicationProperties.getBaseUrl(UrlMode.RELATIVE);
        String tag = tag(snapshot, envTag(productName, productVersion, productBuild, baseUrl), admin, sysadmin);
        String etag = "\"" + tag + "\"";
        if (matches(request.getHeader("If-None-Match"), tag)) {
            return Response.notModified().header("ETag", etag).header("Cache-Control", "private, no-cache").build();
        }
        String body = snapshot.summary(productName, productVersion, productBuild, baseUrl, admin, sysadmin);
        return Response.ok(body, JSON).header("ETag", etag).header("Cache-Control", "private, no-cache").build();
    }

    private static final String MARKDOWN = "text/markdown;charset=UTF-8";

    @GET
    @Path("/index/{hash}")
    @Produces(MediaType.APPLICATION_JSON)
    public Response index(@PathParam("hash") String hash, @Context HttpServletRequest request) {
        Response denied = RestAuth.requireLicensed(userManager, request);
        if (denied != null) {
            return denied;
        }
        CatalogSnapshot snapshot = catalog.current(request.getServletContext());
        if (!snapshot.hash().equals(hash)) {
            String err = new Json().beginObject()
                    .field("error", "unknown-hash")
                    .field("hash", snapshot.hash())
                    .field("hint", "Fetch /rest/restbrowser/1/catalog/index/current or search via /rest/restbrowser/1/catalog/operations.")
                    .endObject().toString();
            return Response.status(Response.Status.NOT_FOUND).header("Cache-Control", "no-store")
                    .type(JSON).entity(err).build();
        }
        StreamingOutput body = snapshot::writeIndex;
        return Response.ok(body, JSON).header("Content-Length", snapshot.indexLength())
                .header("X-Catalog-Hash", snapshot.hash())
                .header("Cache-Control", snapshot.complete() ? IMMUTABLE : "private, no-cache").build();
    }

    @GET
    @Path("/index/current")
    @Produces(MediaType.APPLICATION_JSON)
    public Response indexCurrent(@Context HttpServletRequest request) {
        Response denied = RestAuth.requireLicensed(userManager, request);
        if (denied != null) {
            return denied;
        }
        CatalogSnapshot snapshot = catalog.current(request.getServletContext());
        String tag = snapshot.hash();
        String etag = "\"" + tag + "\"";
        if (matches(request.getHeader("If-None-Match"), tag)) {
            return Response.notModified()
                    .header("ETag", etag)
                    .header("X-Catalog-Hash", tag)
                    .header("Cache-Control", "private, no-cache")
                    .build();
        }
        StreamingOutput body = snapshot::writeIndex;
        return Response.ok(body, JSON)
                .header("ETag", etag)
                .header("X-Catalog-Hash", tag)
                .header("Content-Length", snapshot.indexLength())
                .header("Cache-Control", "private, no-cache")
                .build();
    }

    @GET
    @Path("/operations")
    @Produces({MediaType.APPLICATION_JSON, MARKDOWN, MediaType.TEXT_PLAIN})
    public Response searchOperations(@QueryParam("q") String q,
                                     @QueryParam("method") String method,
                                     @QueryParam("path") String path,
                                     @QueryParam("module") String module,
                                     @QueryParam("plugin") String plugin,
                                     @QueryParam("access") String access,
                                     @QueryParam("deprecated") Boolean deprecated,
                                     @QueryParam("usesClass") String usesClass,
                                     @QueryParam("limit") int limit,
                                     @QueryParam("offset") int offset,
                                     @QueryParam("fields") String fields,
                                     @QueryParam("format") String format,
                                     @Context HttpServletRequest request) {
        Response denied = RestAuth.requireLicensed(userManager, request);
        if (denied != null) {
            return denied;
        }
        CatalogSnapshot snapshot = catalog.current(request.getServletContext());
        CatalogQuery.OperationFilter filter = new CatalogQuery.OperationFilter(
                q, method, path, module, plugin, access, deprecated, usesClass,
                limit, offset, "full".equalsIgnoreCase(fields));
        if (RestAuth.wantsMarkdown(format, request)) {
            return Response.ok(CatalogQuery.searchMarkdown(snapshot, filter), MARKDOWN)
                    .header("X-Catalog-Hash", snapshot.hash())
                    .header("Cache-Control", "private, no-cache")
                    .build();
        }
        return Response.ok(CatalogQuery.searchJson(snapshot, filter), JSON)
                .header("X-Catalog-Hash", snapshot.hash())
                .header("Cache-Control", "private, no-cache")
                .build();
    }

    @GET
    @Path("/resolve")
    @Produces({MediaType.APPLICATION_JSON, MARKDOWN, MediaType.TEXT_PLAIN})
    public Response resolveUrl(@QueryParam("url") String url,
                               @QueryParam("method") String method,
                               @QueryParam("limit") int limit,
                               @QueryParam("format") String format,
                               @Context HttpServletRequest request) {
        Response denied = RestAuth.requireLicensed(userManager, request);
        if (denied != null) {
            return denied;
        }
        if (url == null || url.isBlank()) {
            return RestAuth.error(Response.Status.BAD_REQUEST, "missing-url",
                    "Pass ?url=/rest/... or a full endpoint URL.");
        }
        CatalogSnapshot snapshot = catalog.current(request.getServletContext());
        if (RestAuth.wantsMarkdown(format, request)) {
            return Response.ok(CatalogQuery.resolveUrlMarkdown(snapshot, method, url, limit), MARKDOWN)
                    .header("X-Catalog-Hash", snapshot.hash())
                    .header("Cache-Control", "private, no-cache")
                    .build();
        }
        return Response.ok(CatalogQuery.resolveUrlJson(snapshot, method, url, limit), JSON)
                .header("X-Catalog-Hash", snapshot.hash())
                .header("Cache-Control", "private, no-cache")
                .build();
    }

    @GET
    @Path("/openapi")
    @Produces(MediaType.APPLICATION_JSON)
    public Response moduleOpenApi(@QueryParam("module") String module,
                                  @QueryParam("includeSchemas") Boolean includeSchemas,
                                  @QueryParam("schemaDepth") int schemaDepth,
                                  @Context HttpServletRequest request) {
        Response denied = RestAuth.requireLicensed(userManager, request);
        if (denied != null) {
            return denied;
        }
        if (module == null || module.isBlank()) {
            return RestAuth.error(Response.Status.BAD_REQUEST, "missing-module",
                    "Pass ?module={moduleId} from GET /rest/restbrowser/1/catalog.");
        }
        CatalogSnapshot snapshot = catalog.current(request.getServletContext());
        UserKey user = RestAuth.remoteUser(userManager, request);
        boolean sysadmin = RestAuth.isSystemAdmin(userManager, user);
        boolean withSchemas = sysadmin && !Boolean.FALSE.equals(includeSchemas);
        String baseUrl = applicationProperties.getBaseUrl(UrlMode.RELATIVE);
        String spec = OpenApiExporter.moduleSpecJson(snapshot, module.trim(), baseUrl, withSchemas,
                schemaDepth <= 0 ? 2 : schemaDepth, withSchemas ? source : null);
        if (spec == null) {
            return RestAuth.error(Response.Status.NOT_FOUND, "unknown-module",
                    "Unknown module '" + module.trim() + "'. Inspect modules via GET /rest/restbrowser/1/catalog.");
        }
        return RestAuth.cacheableResponse(request, 200, JSON, spec, snapshot.hash());
    }

    @POST
    @Path("/refresh")
    @SystemAdminOnly
    public Response refresh(@QueryParam("module") String module, @Context HttpServletRequest request) {
        Response denied = RestAuth.requireSysadmin(userManager, request);
        if (denied != null) {
            return denied;
        }
        if (!RestAuth.xsrfHeader(request)) {
            return RestAuth.error(Response.Status.FORBIDDEN, "xsrf-check-failed", "Add header X-Atlassian-Token: no-check");
        }
        catalog.current(request.getServletContext());
        catalog.refresh(module == null || module.isBlank() ? null : module);
        return Response.noContent().build();
    }

    @POST
    @Path("/started")
    public Response started(@QueryParam("module") String module, @Context HttpServletRequest request) {
        Response denied = RestAuth.requireLicensed(userManager, request);
        if (denied != null) {
            return denied;
        }
        if (!RestAuth.xsrfHeader(request)) {
            return RestAuth.error(Response.Status.FORBIDDEN, "xsrf-check-failed", "Add header X-Atlassian-Token: no-check");
        }
        ModuleEntry entry = catalog.current(request.getServletContext()).module(module).orElse(null);
        if (entry == null) {
            return RestAuth.error(Response.Status.NOT_FOUND, "unknown-module");
        }
        if (entry.state() == State.ok) {
            return Response.noContent().header("Cache-Control", "no-store").build();
        }
        if (entry.state() == State.pending) {
            return Response.accepted().header("Cache-Control", "no-store").build();
        }
        if (!JerseyModelSource.NOT_STARTED.equals(entry.reason())
                && !JerseyModelSource.NOT_STARTABLE.equals(entry.reason())) {
            return RestAuth.error(Response.Status.CONFLICT, "not-waiting-to-start");
        }
        CatalogService.Started started = catalog.readStarted(module, STARTED_WAIT_MS);
        return switch (started.outcome()) {
            case READ -> Response.ok(entryJson(started.entry()), JSON).header("Cache-Control", "no-store").build();
            case QUEUED -> Response.accepted().header("Cache-Control", "no-store").build();
            case STILL_NOT_STARTED -> RestAuth.error(Response.Status.CONFLICT, "still-not-started");
            case UNKNOWN -> RestAuth.error(Response.Status.NOT_FOUND, "unknown-module");
            case FAILED -> RestAuth.error(Response.Status.INTERNAL_SERVER_ERROR, "read-failed");
        };
    }

    static String entryJson(ModuleEntry e) {
        String reason = e.reason() == null ? null : e.reason().replaceAll("[^A-Za-z0-9-]", "");
        return new Json().beginObject()
                .field("state", e.state().name())
                .field("reason", reason)
                .field("opCount", e.opCount())
                .endObject().toString();
    }

    @GET
    @Path("/details")
    @Produces(MediaType.APPLICATION_JSON)
    @SystemAdminOnly
    public Response details(@QueryParam("op") String op, @Context HttpServletRequest request) {
        Response denied = RestAuth.requireSysadmin(userManager, request);
        if (denied != null) {
            return denied;
        }
        catalog.current(request.getServletContext());
        OperationDetails.Result result = details.describe(op);
        return Response.status(result.status()).type(JSON).header("Cache-Control", "no-store")
                .entity(result.json()).build();
    }

    @GET
    @Path("/details/source")
    @Produces(MediaType.APPLICATION_JSON)
    @SystemAdminOnly
    public Response detailsSource(@QueryParam("op") String op,
                                  @QueryParam("class") String className,
                                  @QueryParam("fromBundle") Long fromBundle,
                                  @QueryParam("scope") String scope,
                                  @QueryParam("decompiler") String decompiler,
                                  @Context HttpServletRequest request) {
        Response denied = RestAuth.requireSysadmin(userManager, request);
        if (denied != null) {
            return denied;
        }
        if (source == null) {
            return RestAuth.error(Response.Status.NOT_FOUND, "not-described");
        }
        catalog.current(request.getServletContext());
        long bundleId = fromBundle == null ? -1L : fromBundle;
        OperationDetails.Result result = source.decompile(op, className, bundleId, scope, decompiler);
        return Response.status(result.status()).type(JSON).header("Cache-Control", "no-store")
                .entity(result.json()).build();
    }

    static String tag(CatalogSnapshot snapshot, boolean admin, boolean sysadmin) {
        return tag(snapshot, "", admin, sysadmin);
    }

    static String tag(CatalogSnapshot snapshot, String envHash, boolean admin, boolean sysadmin) {
        String base = (admin ? snapshot.adminTag() : snapshot.hash()) + "-" + progress(snapshot);
        if (envHash != null && !envHash.isEmpty()) {
            base += "-" + envHash;
        }
        return base + "-" + (sysadmin ? "s" : admin ? "a" : "u");
    }

    static String envTag(String productName, String productVersion, String productBuild, String baseUrl) {
        try {
            String raw = String.join("\n",
                    String.valueOf(productName),
                    String.valueOf(productVersion),
                    String.valueOf(productBuild),
                    String.valueOf(baseUrl));
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(raw.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest, 0, 4);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static String progress(CatalogSnapshot snapshot) {
        return (snapshot.complete() ? "c" : "p") + snapshot.done() + "." + snapshot.total();
    }

    static boolean matches(String ifNoneMatch, String tag) {
        return RestAuth.matchesEtag(ifNoneMatch, tag);
    }
}
