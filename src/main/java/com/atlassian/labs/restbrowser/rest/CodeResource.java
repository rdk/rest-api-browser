package com.atlassian.labs.restbrowser.rest;

import com.atlassian.annotations.security.SystemAdminOnly;
import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.OperationDetails;
import com.atlassian.labs.restbrowser.catalog.OperationSource;
import com.atlassian.labs.restbrowser.json.JsonParser;
import com.atlassian.labs.restbrowser.json.JsonParser.JsonParseException;
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

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Agent-friendly and UI REST API for Java class inspection, OSGi/plugin provenance, on-demand decompilation,
 * and reference graph traversal. System administrators only.
 */
@Path("/code")
@SystemAdminOnly
public class CodeResource {

    static final String JSON = RestAuth.JSON_MEDIA_TYPE;
    static final String TEXT = MediaType.TEXT_PLAIN + ";charset=UTF-8";
    static final int MAX_BATCH_BODY_BYTES = 16_384;

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
        if (op != null && !op.isBlank()) {
            catalog.current(request.getServletContext());
        }
        long bundleId = fromBundle == null ? -1L : fromBundle;
        return jsonResponse(source.inspectClass(op, className, bundleId));
    }

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
        if (op != null && !op.isBlank()) {
            catalog.current(request.getServletContext());
        }
        long bundleId = fromBundle == null ? -1L : fromBundle;
        boolean plain = "text".equalsIgnoreCase(format)
                || ((format == null || format.isBlank()) && wantsPlainText(request.getHeader("Accept")));
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
        if (op != null && !op.isBlank()) {
            catalog.current(request.getServletContext());
        }
        long bundleId = fromBundle == null ? -1L : fromBundle;
        return jsonResponse(source.traverseGraph(op, className, bundleId, depth, maxNodes, includeJdk,
                packagePrefix, includeSources, decompiler));
    }

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
        return jsonResponse(source.searchClasses(query, limit, bundleId));
    }

    @POST
    @Path("/batch")
    @Consumes(MediaType.APPLICATION_JSON)
    @Produces(MediaType.APPLICATION_JSON)
    public Response batch(InputStream body, @Context HttpServletRequest request) {
        Response denied = checkSysadmin(request);
        if (denied != null) {
            return denied;
        }
        if (!RestAuth.xsrfHeader(request)) {
            return RestAuth.error(Response.Status.FORBIDDEN, "xsrf-check-failed");
        }
        String bodyText;
        try {
            bodyText = readBoundedUtf8(body, MAX_BATCH_BODY_BYTES);
        } catch (BodyTooLargeException e) {
            return RestAuth.error(Response.Status.BAD_REQUEST, "body-too-large");
        } catch (IOException e) {
            return RestAuth.error(Response.Status.BAD_REQUEST, "invalid-json");
        }
        BatchRequest req;
        try {
            req = parseBatchRequest(bodyText);
        } catch (IllegalArgumentException e) {
            return RestAuth.error(Response.Status.BAD_REQUEST, "invalid-json");
        }
        if (req.classes().isEmpty()) {
            return RestAuth.error(Response.Status.BAD_REQUEST, "missing-classes");
        }
        if (req.op() != null && !req.op().isBlank()) {
            catalog.current(request.getServletContext());
        }
        return jsonResponse(source.batch(req.classes(), req.fromBundle(), req.op(), req.decompiler(),
                req.includeSource(), req.includeMeta(), req.maxLines()));
    }

    private static final class BodyTooLargeException extends IOException {
    }

    static String readBoundedUtf8(InputStream body, int maxBytes) throws IOException {
        if (body == null) {
            return "";
        }
        try (body) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[Math.min(4096, maxBytes + 1)];
            int total = 0;
            int n;
            while ((n = body.read(buf, 0, Math.min(buf.length, (maxBytes + 1) - total))) > 0) {
                total += n;
                if (total > maxBytes) {
                    throw new BodyTooLargeException();
                }
                out.write(buf, 0, n);
            }
            return out.toString(StandardCharsets.UTF_8);
        }
    }

    record BatchRequest(List<String> classes, long fromBundle, String op, String decompiler,
                        boolean includeSource, boolean includeMeta, Integer maxLines) {
    }

    static BatchRequest parseBatchRequest(String body) {
        if (body == null || body.isBlank()) {
            return new BatchRequest(List.of(), -1L, null, "vineflower", true, false, null);
        }
        Map<String, Object> obj = JsonParser.parseObject(body);
        List<String> classes = new ArrayList<>();
        Object rawClasses = obj.get("classes");
        if (rawClasses != null) {
            if (!(rawClasses instanceof List<?> list)) {
                throw new JsonParseException("expected array for classes");
            }
            for (Object item : list) {
                if (!(item instanceof String s)) {
                    throw new JsonParseException("expected string in classes");
                }
                if (!s.isBlank()) {
                    classes.add(s);
                }
            }
        }
        long fromBundle = toLong(obj.get("fromBundle"), -1L);
        Integer maxLines = toOptionalInt(obj.get("maxLines"));
        String op = optionalString(obj.get("op"), null, "op");
        String decompiler = optionalString(obj.get("decompiler"), "vineflower", "decompiler");
        boolean includeSource = optionalBoolean(obj.get("includeSource"), true, "includeSource");
        boolean includeMeta = optionalBoolean(obj.get("includeMeta"), false, "includeMeta");
        return new BatchRequest(classes, fromBundle, op, decompiler, includeSource, includeMeta, maxLines);
    }

    private static String optionalString(Object v, String fallback, String field) {
        if (v == null) {
            return fallback;
        }
        if (v instanceof String s) {
            return s;
        }
        throw new JsonParseException("expected string for " + field);
    }

    private static boolean optionalBoolean(Object v, boolean fallback, String field) {
        if (v == null) {
            return fallback;
        }
        if (v instanceof Boolean b) {
            return b;
        }
        throw new JsonParseException("expected boolean for " + field);
    }

    private static long toLong(Object v, long fallback) {
        if (v == null) {
            return fallback;
        }
        if (v instanceof Long l) {
            return l;
        }
        throw new JsonParseException("expected integer");
    }

    private static Integer toOptionalInt(Object v) {
        if (v == null) {
            return null;
        }
        if (v instanceof Long l) {
            if (l < Integer.MIN_VALUE || l > Integer.MAX_VALUE) {
                throw new JsonParseException("maxLines out of int range");
            }
            return l.intValue();
        }
        throw new JsonParseException("expected integer");
    }

    static boolean wantsPlainText(String accept) {
        if (accept == null || accept.isBlank()) {
            return false;
        }
        double textQ = -1;
        double jsonQ = -1;
        double anyQ = -1;
        for (String part : accept.toLowerCase(Locale.ROOT).split(",")) {
            String[] segs = part.trim().split(";");
            String type = segs[0].trim();
            double q = 1.0;
            for (int i = 1; i < segs.length; i++) {
                String p = segs[i].trim();
                if (p.startsWith("q=")) {
                    try {
                        double parsed = Double.parseDouble(p.substring(2).trim());
                        q = Double.isFinite(parsed) && parsed >= 0.0 && parsed <= 1.0 ? parsed : 0.0;
                    } catch (NumberFormatException ignored) {
                        q = 0.0;
                    }
                }
            }
            if ("text/plain".equals(type)) {
                textQ = Math.max(textQ, q);
            } else if ("application/json".equals(type)) {
                jsonQ = Math.max(jsonQ, q);
            } else if ("*/*".equals(type)) {
                anyQ = Math.max(anyQ, q);
            }
        }
        double effectiveJsonQ = Math.max(jsonQ, anyQ);
        return textQ > 0 && textQ > effectiveJsonQ;
    }

    private Response checkSysadmin(HttpServletRequest request) {
        Response denied = RestAuth.requireSysadmin(userManager, request);
        if (denied != null) {
            return denied;
        }
        if (source == null) {
            return RestAuth.error(Response.Status.NOT_FOUND, "not-described");
        }
        return null;
    }

    private static Response jsonResponse(OperationDetails.Result result) {
        return Response.status(result.status()).type(JSON).header("Cache-Control", "no-store")
                .entity(result.json()).build();
    }
}
