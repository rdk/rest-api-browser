package com.atlassian.labs.restbrowser.rest;

import com.atlassian.annotations.security.SystemAdminOnly;
import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.OperationDetails;
import com.atlassian.labs.restbrowser.catalog.OperationSource;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import jakarta.inject.Inject;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.DefaultValue;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.core.Context;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Agent-friendly and UI REST API for Java class inspection, OSGi/plugin provenance, on-demand decompilation
 * (CFR 0.152 &amp; Vineflower 1.11.1), and deep decompiled code traversal across OSGi bundle wires.
 * <p>
 * Mounted at {@code /rest/restbrowser/1/code/*}. System administrators only.
 */
@Path("/code")
@SystemAdminOnly
public class CodeResource {

    static final String JSON = MediaType.APPLICATION_JSON + ";charset=UTF-8";
    static final String TEXT = MediaType.TEXT_PLAIN + ";charset=UTF-8";

    private final CatalogService catalog;
    private final UserManager userManager;
    private final OperationDetails details;
    private final OperationSource source;

    @Inject
    public CodeResource(CatalogService catalog, UserManager userManager,
                        OperationDetails details, OperationSource source) {
        this.catalog = catalog;
        this.userManager = userManager;
        this.details = details;
        this.source = source;
    }

    /** Rich class metadata: reflection, bytecode version/size, OSGi bundle headers/wiring, plugin ownership, timestamps, refs. */
    @GET
    @Path("/class")
    @Produces(MediaType.APPLICATION_JSON)
    public Response inspectClass(@QueryParam("class") String className,
                                 @QueryParam("op") String op,
                                 @QueryParam("fromBundle") Long fromBundle,
                                 @Context HttpServletRequest request) {
        Response denied = checkSysadmin(request);
        if (denied != null) {
            return denied;
        }
        catalog.current(request.getServletContext());
        long bundleId = fromBundle == null ? -1L : fromBundle;
        return jsonResponse(source.inspectClass(op, className, bundleId));
    }

    /** Rich plugin & OSGi bundle metadata for an app lozenge tooltip or agent query. */
    @GET
    @Path("/plugin")
    @Produces(MediaType.APPLICATION_JSON)
    public Response inspectPlugin(@QueryParam("key") String pluginKey,
                                  @Context HttpServletRequest request) {
        Response denied = checkSysadmin(request);
        if (denied != null) {
            return denied;
        }
        return jsonResponse(source.inspectPlugin(pluginKey));
    }

    /**
     * Decompiled source of a class or method with optional line slicing ({@code startLine}, {@code maxLines}),
     * {@code methodLine} anchoring, optional {@code includeMeta=true}, and raw plain-text mode ({@code format=text}
     * or {@code Accept: text/plain}).
     */
    @GET
    @Path("/source")
    @Produces({MediaType.APPLICATION_JSON, MediaType.TEXT_PLAIN})
    public Response decompileSource(@QueryParam("class") String className,
                                    @QueryParam("op") String op,
                                    @QueryParam("method") String method,
                                    @QueryParam("scope") String scope,
                                    @QueryParam("decompiler") String decompiler,
                                    @QueryParam("fromBundle") Long fromBundle,
                                    @QueryParam("startLine") Integer startLine,
                                    @QueryParam("maxLines") Integer maxLines,
                                    @QueryParam("includeMeta") @DefaultValue("false") boolean includeMeta,
                                    @QueryParam("format") String format,
                                    @Context HttpServletRequest request) {
        Response denied = checkSysadmin(request);
        if (denied != null) {
            return denied;
        }
        catalog.current(request.getServletContext());
        long bundleId = fromBundle == null ? -1L : fromBundle;
        boolean plain = "text".equalsIgnoreCase(format) || wantsPlainText(request.getHeader("Accept"));
        if (plain) {
            OperationDetails.Result r = source.decompileText(op, className, bundleId, scope, decompiler, method,
                    startLine, maxLines);
            return Response.status(r.status())
                    .type(r.status() == 200 ? TEXT : JSON)
                    .header("Cache-Control", "no-store")
                    .entity(r.json())
                    .build();
        }
        return jsonResponse(source.decompile(op, className, bundleId, scope, decompiler, method,
                startLine, maxLines, includeMeta));
    }

    /** Combined operation details + decompiled source in a single agent-friendly round trip. */
    @GET
    @Path("/operation")
    @Produces(MediaType.APPLICATION_JSON)
    public Response operationBundle(@QueryParam("op") String op,
                                    @QueryParam("scope") @DefaultValue("method") String scope,
                                    @QueryParam("decompiler") @DefaultValue("vineflower") String decompiler,
                                    @Context HttpServletRequest request) {
        Response denied = checkSysadmin(request);
        if (denied != null) {
            return denied;
        }
        catalog.current(request.getServletContext());
        return jsonResponse(source.operationBundle(op, scope, decompiler, details));
    }

    /** BFS traversal of referenced Java classes across OSGi bundle wires. */
    @GET
    @Path("/graph")
    @Produces(MediaType.APPLICATION_JSON)
    public Response traverseGraph(@QueryParam("class") String className,
                                  @QueryParam("op") String op,
                                  @QueryParam("fromBundle") Long fromBundle,
                                  @QueryParam("depth") @DefaultValue("1") int depth,
                                  @QueryParam("maxNodes") @DefaultValue("30") int maxNodes,
                                  @QueryParam("includeJdk") @DefaultValue("false") boolean includeJdk,
                                  @QueryParam("packagePrefix") String packagePrefix,
                                  @QueryParam("includeSources") @DefaultValue("false") boolean includeSources,
                                  @QueryParam("decompiler") @DefaultValue("vineflower") String decompiler,
                                  @Context HttpServletRequest request) {
        Response denied = checkSysadmin(request);
        if (denied != null) {
            return denied;
        }
        catalog.current(request.getServletContext());
        long bundleId = fromBundle == null ? -1L : fromBundle;
        return jsonResponse(source.traverseGraph(op, className, bundleId, depth, maxNodes, includeJdk,
                packagePrefix, includeSources, decompiler));
    }

    /** Search Java classes across active OSGi bundles by substring or package prefix. */
    @GET
    @Path("/search")
    @Produces(MediaType.APPLICATION_JSON)
    public Response searchClasses(@QueryParam("q") String query,
                                  @QueryParam("limit") @DefaultValue("30") int limit,
                                  @QueryParam("bundleId") Long bundleId,
                                  @Context HttpServletRequest request) {
        Response denied = checkSysadmin(request);
        if (denied != null) {
            return denied;
        }
        catalog.current(request.getServletContext());
        return jsonResponse(source.searchClasses(query, limit, bundleId));
    }

    /**
     * Batch inspect or decompile up to 10 classes in one request.
     * Body: {@code {"classes":["a.b.Foo","a.b.Bar"],"fromBundle":-1,"decompiler":"vineflower","includeSource":true,"includeMeta":false,"maxLines":200}}.
     */
    @POST
    @Path("/batch")
    @Consumes(MediaType.APPLICATION_JSON)
    @Produces(MediaType.APPLICATION_JSON)
    public Response batch(String body, @Context HttpServletRequest request) {
        Response denied = checkSysadmin(request);
        if (denied != null) {
            return denied;
        }
        if (!"no-check".equals(request.getHeader("X-Atlassian-Token"))) {
            return error(Response.Status.FORBIDDEN, "xsrf-check-failed");
        }
        catalog.current(request.getServletContext());
        BatchRequest req = parseBatchRequest(body);
        if (req.classes().isEmpty()) {
            return error(Response.Status.BAD_REQUEST, "missing-classes");
        }
        return jsonResponse(source.batch(req.classes(), req.fromBundle(), req.op(), req.decompiler(),
                req.includeSource(), req.includeMeta(), req.maxLines()));
    }

    // ---- lightweight JSON parsing for batch body (no Jackson dependency needed)

    record BatchRequest(List<String> classes, long fromBundle, String op, String decompiler,
                        boolean includeSource, boolean includeMeta, Integer maxLines) {
    }

    private static final Pattern CLASSES_ARR = Pattern.compile("\"classes\"\\s*:\\s*\\[([^\\]]*)]");
    private static final Pattern QUOTED_STR = Pattern.compile("\"([^\"]+)\"");
    private static final Pattern STR_FIELD = Pattern.compile("\"([a-zA-Z]+)\"\\s*:\\s*\"([^\"]*)\"");
    private static final Pattern NUM_FIELD = Pattern.compile("\"([a-zA-Z]+)\"\\s*:\\s*(-?\\d+)");
    private static final Pattern BOOL_FIELD = Pattern.compile("\"([a-zA-Z]+)\"\\s*:\\s*(true|false)");

    static BatchRequest parseBatchRequest(String body) {
        if (body == null || body.isBlank()) {
            return new BatchRequest(List.of(), -1L, null, "vineflower", true, false, null);
        }
        List<String> classes = new ArrayList<>();
        Matcher arr = CLASSES_ARR.matcher(body);
        if (arr.find()) {
            Matcher item = QUOTED_STR.matcher(arr.group(1));
            while (item.find()) {
                classes.add(item.group(1));
            }
        }
        long fromBundle = -1L;
        Integer maxLines = null;
        Matcher nm = NUM_FIELD.matcher(body);
        while (nm.find()) {
            switch (nm.group(1)) {
                case "fromBundle" -> fromBundle = Long.parseLong(nm.group(2));
                case "maxLines" -> maxLines = Integer.parseInt(nm.group(2));
                default -> { }
            }
        }
        String op = null;
        String decompiler = "vineflower";
        Matcher sm = STR_FIELD.matcher(body);
        while (sm.find()) {
            switch (sm.group(1)) {
                case "op" -> op = sm.group(2);
                case "decompiler" -> decompiler = sm.group(2);
                default -> { }
            }
        }
        boolean includeSource = true;
        boolean includeMeta = false;
        Matcher bm = BOOL_FIELD.matcher(body);
        while (bm.find()) {
            switch (bm.group(1)) {
                case "includeSource" -> includeSource = Boolean.parseBoolean(bm.group(2));
                case "includeMeta" -> includeMeta = Boolean.parseBoolean(bm.group(2));
                default -> { }
            }
        }
        return new BatchRequest(classes, fromBundle, op, decompiler, includeSource, includeMeta, maxLines);
    }

    private static boolean wantsPlainText(String accept) {
        if (accept == null) {
            return false;
        }
        String a = accept.toLowerCase();
        return a.contains("text/plain") && !a.contains("application/json");
    }

    private Response checkSysadmin(HttpServletRequest request) {
        UserKey user = userManager.getRemoteUserKey(request);
        if (user == null) {
            return error(Response.Status.UNAUTHORIZED, "login-required");
        }
        if (!userManager.isSystemAdmin(user)) {
            return error(Response.Status.FORBIDDEN, "system-admin-only");
        }
        if (source == null) {
            return error(Response.Status.NOT_FOUND, "not-described");
        }
        return null;
    }

    private static Response jsonResponse(OperationDetails.Result result) {
        return Response.status(result.status()).type(JSON).header("Cache-Control", "no-store")
                .entity(result.json()).build();
    }

    private static Response error(Response.Status status, String code) {
        return Response.status(status).type(JSON).header("Cache-Control", "no-store")
                .entity("{\"error\":\"" + code + "\"}").build();
    }
}
