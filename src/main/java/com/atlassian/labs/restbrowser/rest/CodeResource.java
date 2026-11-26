package com.atlassian.labs.restbrowser.rest;

import com.atlassian.labs.restbrowser.catalog.AgentMarkdown;
import com.atlassian.labs.restbrowser.catalog.OperationSource.BatchItem;

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

    private static final String MARKDOWN = RestAuth.MARKDOWN_MEDIA_TYPE;

    @GET
    @Path("/class")
    @Produces({MediaType.APPLICATION_JSON, MARKDOWN, MediaType.TEXT_PLAIN})
    public Response inspectClass(@QueryParam("class") String className,
                                 @QueryParam("op") String op,
                                 @QueryParam("fromBundle") Long fromBundle,
                                 @QueryParam("view") String view,
                                 @QueryParam("outline") @DefaultValue("false") boolean outline,
                                 @QueryParam("includeImplementations") @DefaultValue("false") boolean includeImplementations,
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
        boolean compact = "compact".equalsIgnoreCase(view);
        OperationDetails.Result r = source.inspectClass(op, className, bundleId, compact, outline, includeImplementations);
        if (RestAuth.wantsMarkdown(format, request)) {
            return markdownResponse(request, r, AgentMarkdown.renderClassJson(r.json()));
        }
        return cacheableJson(request, r);
    }

    Response inspectClass(String className, String op, Long fromBundle, HttpServletRequest request) {
        return inspectClass(className, op, fromBundle, "full", false, false, null, request);
    }

    Response inspectClass(String className, String op, Long fromBundle, String view, String format, HttpServletRequest request) {
        return inspectClass(className, op, fromBundle, view, false, false, format, request);
    }

    @GET
    @Path("/plugin")
    @Produces(MediaType.APPLICATION_JSON)
    public Response inspectPlugin(@QueryParam("key") String pluginKey,
                                  @QueryParam("view") String view,
                                  @Context HttpServletRequest request) {
        Response denied = checkSysadmin(request);
        if (denied != null) {
            return denied;
        }
        return cacheableJson(request, source.inspectPlugin(pluginKey, "compact".equalsIgnoreCase(view)));
    }

    Response inspectPlugin(String pluginKey, HttpServletRequest request) {
        return inspectPlugin(pluginKey, "full", request);
    }

    @GET
    @Path("/source")
    @Produces({MediaType.APPLICATION_JSON, MediaType.TEXT_PLAIN, MARKDOWN})
    public Response decompileSource(@QueryParam("class") String className,
                                    @QueryParam("op") String op,
                                    @QueryParam("method") String method,
                                    @QueryParam("scope") String scope,
                                    @QueryParam("decompiler") String decompiler,
                                    @QueryParam("fromBundle") Long fromBundle,
                                    @QueryParam("startLine") Integer startLine,
                                    @QueryParam("maxLines") Integer maxLines,
                                    @QueryParam("includeMeta") @DefaultValue("false") boolean includeMeta,
                                    @QueryParam("lineNumbers") @DefaultValue("false") boolean lineNumbers,
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
                    startLine, maxLines, lineNumbers);
            return RestAuth.cacheableResponse(request, r.status(), r.status() == 200 ? TEXT : JSON, r.json());
        }
        OperationDetails.Result r = source.decompile(op, className, bundleId, scope, decompiler, method,
                startLine, maxLines, includeMeta, lineNumbers);
        if (RestAuth.wantsMarkdown(format, request)) {
            return markdownResponse(request, r, AgentMarkdown.renderSourceJson(r.json()));
        }
        return cacheableJson(request, r);
    }

    Response decompileSource(String className, String op, String method, String scope, String decompiler,
                             Long fromBundle, Integer startLine, Integer maxLines, boolean includeMeta,
                             String format, HttpServletRequest request) {
        return decompileSource(className, op, method, scope, decompiler, fromBundle, startLine, maxLines,
                includeMeta, false, format, request);
    }

    @GET
    @Path("/operation")
    @Produces({MediaType.APPLICATION_JSON, MARKDOWN, MediaType.TEXT_PLAIN})
    public Response operationBundle(@QueryParam("op") String op,
                                    @QueryParam("scope") @DefaultValue("method") String scope,
                                    @QueryParam("decompiler") @DefaultValue("vineflower") String decompiler,
                                    @QueryParam("view") String view,
                                    @QueryParam("startLine") Integer startLine,
                                    @QueryParam("maxLines") Integer maxLines,
                                    @QueryParam("lineNumbers") @DefaultValue("false") boolean lineNumbers,
                                    @QueryParam("format") String format,
                                    @Context HttpServletRequest request) {
        Response denied = checkSysadmin(request);
        if (denied != null) {
            return denied;
        }
        catalog.current(request.getServletContext());
        boolean compact = "compact".equalsIgnoreCase(view);
        OperationDetails.Result r = source.operationBundle(op, scope, decompiler, details,
                compact, startLine, maxLines, lineNumbers);
        if (RestAuth.wantsMarkdown(format, request)) {
            return noStoreMarkdown(r, AgentMarkdown.renderOperationBundle(r.json()));
        }
        return jsonResponse(r);
    }

    Response operationBundle(String op, String scope, String decompiler, HttpServletRequest request) {
        return operationBundle(op, scope, decompiler, "full", null, null, false, null, request);
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
                                  @QueryParam("excludeLibraries") @DefaultValue("false") boolean excludeLibraries,
                                  @QueryParam("preset") String preset,
                                  @QueryParam("edgeKinds") String edgeKinds,
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
        boolean domainPreset = "domain".equalsIgnoreCase(preset);
        return jsonResponse(source.traverseGraph(op, className, bundleId, depth, maxNodes,
                !domainPreset && includeJdk, domainPreset || excludeLibraries,
                packagePrefix, includeSources, decompiler, edgeKinds));
    }

    Response traverseGraph(String className, String op, Long fromBundle, int depth, int maxNodes,
                           boolean includeJdk, boolean excludeLibraries, String preset,
                           String packagePrefix, boolean includeSources,
                           String decompiler, HttpServletRequest request) {
        return traverseGraph(className, op, fromBundle, depth, maxNodes, includeJdk, excludeLibraries, preset,
                null, packagePrefix, includeSources, decompiler, request);
    }

    Response traverseGraph(String className, String op, Long fromBundle, int depth, int maxNodes,
                           boolean includeJdk, String packagePrefix, boolean includeSources,
                           String decompiler, HttpServletRequest request) {
        return traverseGraph(className, op, fromBundle, depth, maxNodes, includeJdk, false, null, null,
                packagePrefix, includeSources, decompiler, request);
    }

    @GET
    @Path("/schema")
    @Produces({MediaType.APPLICATION_JSON, MARKDOWN, MediaType.TEXT_PLAIN})
    public Response inspectSchema(@QueryParam("class") String className,
                                  @QueryParam("op") String op,
                                  @QueryParam("fromBundle") Long fromBundle,
                                  @QueryParam("depth") @DefaultValue("3") int depth,
                                  @QueryParam("includeExample") @DefaultValue("true") boolean includeExample,
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
        OperationDetails.Result r = source.inspectSchema(op, className, bundleId, depth, includeExample);
        if (RestAuth.wantsMarkdown(format, request)) {
            return markdownResponse(request, r, AgentMarkdown.renderSchemaJson(r.json()));
        }
        return cacheableJson(request, r);
    }

    @GET
    @Path("/resource")
    @Produces({MediaType.APPLICATION_JSON, MediaType.TEXT_PLAIN, MARKDOWN})
    public Response inspectResource(@QueryParam("bundleId") Long bundleId,
                                    @QueryParam("plugin") String plugin,
                                    @QueryParam("path") String path,
                                    @QueryParam("prefix") String prefix,
                                    @QueryParam("startLine") Integer startLine,
                                    @QueryParam("maxLines") Integer maxLines,
                                    @QueryParam("lineNumbers") @DefaultValue("false") boolean lineNumbers,
                                    @QueryParam("limit") @DefaultValue("100") int limit,
                                    @QueryParam("format") String format,
                                    @Context HttpServletRequest request) {
        Response denied = checkSysadmin(request);
        if (denied != null) {
            return denied;
        }
        boolean plain = "text".equalsIgnoreCase(format)
                || ((format == null || format.isBlank()) && wantsPlainText(request.getHeader("Accept")));
        if (plain) {
            OperationDetails.Result r = source.inspectResourceText(bundleId, plugin, path, prefix,
                    startLine, maxLines, lineNumbers, limit);
            return RestAuth.cacheableResponse(request, r.status(), r.status() == 200 ? TEXT : JSON, r.json());
        }
        OperationDetails.Result r = source.inspectResource(bundleId, plugin, path, prefix,
                startLine, maxLines, lineNumbers, limit);
        if (RestAuth.wantsMarkdown(format, request)) {
            return markdownResponse(request, r, AgentMarkdown.renderResourceJson(r.json()));
        }
        return cacheableJson(request, r);
    }

    @GET
    @Path("/implementations")
    @Produces(MediaType.APPLICATION_JSON)
    public Response findImplementations(@QueryParam("class") String className,
                                        @QueryParam("op") String op,
                                        @QueryParam("fromBundle") Long fromBundle,
                                        @QueryParam("bundleId") Long bundleId,
                                        @QueryParam("plugin") String plugin,
                                        @QueryParam("includeAbstract") @DefaultValue("false") boolean includeAbstract,
                                        @QueryParam("limit") @DefaultValue("30") int limit,
                                        @Context HttpServletRequest request) {
        Response denied = checkSysadmin(request);
        if (denied != null) {
            return denied;
        }
        if (op != null && !op.isBlank()) {
            catalog.current(request.getServletContext());
        }
        long fb = fromBundle == null ? -1L : fromBundle;
        return jsonResponse(source.findImplementations(op, className, fb, bundleId, plugin, includeAbstract, limit));
    }

    @GET
    @Path("/grep")
    @Produces(MediaType.APPLICATION_JSON)
    public Response grepBytecode(@QueryParam("q") String query,
                                 @QueryParam("bundleId") Long bundleId,
                                 @QueryParam("plugin") String plugin,
                                 @QueryParam("packagePrefix") String packagePrefix,
                                 @QueryParam("caseSensitive") @DefaultValue("false") boolean caseSensitive,
                                 @QueryParam("includeUtf8") @DefaultValue("true") boolean includeUtf8,
                                 @QueryParam("limit") @DefaultValue("50") int limit,
                                 @Context HttpServletRequest request) {
        Response denied = checkSysadmin(request);
        if (denied != null) {
            return denied;
        }
        return jsonResponse(source.grepBytecode(query, caseSensitive, includeUtf8, bundleId, plugin, packagePrefix, limit));
    }

    @GET
    @Path("/callers")
    @Produces(MediaType.APPLICATION_JSON)
    public Response findCallers(@QueryParam("class") String className,
                                @QueryParam("method") String method,
                                @QueryParam("op") String op,
                                @QueryParam("fromBundle") Long fromBundle,
                                @QueryParam("bundleId") Long bundleId,
                                @QueryParam("plugin") String plugin,
                                @QueryParam("packagePrefix") String packagePrefix,
                                @QueryParam("limit") @DefaultValue("50") int limit,
                                @Context HttpServletRequest request) {
        Response denied = checkSysadmin(request);
        if (denied != null) {
            return denied;
        }
        if (op != null && !op.isBlank()) {
            catalog.current(request.getServletContext());
        }
        long fb = fromBundle == null ? -1L : fromBundle;
        return jsonResponse(source.findCallers(op, className, method, fb, bundleId, plugin, packagePrefix, limit));
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
            return RestAuth.error(Response.Status.FORBIDDEN, "xsrf-check-failed", "Add header X-Atlassian-Token: no-check");
        }
        String bodyText;
        try {
            bodyText = readBoundedUtf8(body, MAX_BATCH_BODY_BYTES);
        } catch (BodyTooLargeException e) {
            return RestAuth.error(Response.Status.BAD_REQUEST, "body-too-large");
        } catch (IOException e) {
            return RestAuth.error(Response.Status.BAD_REQUEST, "invalid-json");
        }
        List<BatchItem> items;
        try {
            items = parseBatchItems(bodyText);
        } catch (IllegalArgumentException e) {
            return RestAuth.error(Response.Status.BAD_REQUEST, "invalid-json");
        }
        if (items.isEmpty()) {
            return RestAuth.error(Response.Status.BAD_REQUEST, "missing-classes",
                    "Pass \"classes\":[...] or \"items\":[...] in the JSON request body.");
        }
        for (BatchItem item : items) {
            if (item.opKey() != null && !item.opKey().isBlank()) {
                catalog.current(request.getServletContext());
                break;
            }
        }
        return jsonResponse(source.batchItems(items));
    }

    @POST
    @Path("/context")
    @Consumes(MediaType.APPLICATION_JSON)
    @Produces({MediaType.APPLICATION_JSON, MARKDOWN, MediaType.TEXT_PLAIN})
    public Response context(InputStream body,
                            @QueryParam("format") String queryFormat,
                            @Context HttpServletRequest request) {
        Response denied = checkSysadmin(request);
        if (denied != null) {
            return denied;
        }
        if (!RestAuth.xsrfHeader(request)) {
            return RestAuth.error(Response.Status.FORBIDDEN, "xsrf-check-failed", "Add header X-Atlassian-Token: no-check");
        }
        String bodyText;
        try {
            bodyText = readBoundedUtf8(body, MAX_BATCH_BODY_BYTES);
        } catch (BodyTooLargeException e) {
            return RestAuth.error(Response.Status.BAD_REQUEST, "body-too-large");
        } catch (IOException e) {
            return RestAuth.error(Response.Status.BAD_REQUEST, "invalid-json");
        }
        if (bodyText == null || bodyText.isBlank()) {
            return RestAuth.error(Response.Status.BAD_REQUEST, "missing-target",
                    "Pass {\"op\":\"...\"} or {\"url\":\"/rest/...\"}.");
        }
        Map<String, Object> obj;
        try {
            obj = JsonParser.parseObject(bodyText);
        } catch (IllegalArgumentException e) {
            return RestAuth.error(Response.Status.BAD_REQUEST, "invalid-json");
        }
        String op = optionalString(obj.get("op"), null, "op");
        String url = optionalString(obj.get("url"), null, "url");
        if ((op == null || op.isBlank()) && (url == null || url.isBlank())) {
            return RestAuth.error(Response.Status.BAD_REQUEST, "missing-target",
                    "Pass {\"op\":\"...\"} or {\"url\":\"/rest/...\"}.");
        }
        String method = optionalString(obj.get("method"), null, "method");
        Integer maxLinesObj = toOptionalInt(obj.get("maxLines"));
        Integer schemaDepthObj = toOptionalInt(obj.get("schemaDepth"));
        boolean includeSchemas = optionalBoolean(obj.get("includeSchemas"), true, "includeSchemas");
        boolean includeImplementations = optionalBoolean(obj.get("includeImplementations"), true, "includeImplementations");
        boolean includeSource = optionalBoolean(obj.get("includeSource"), true, "includeSource");
        boolean lineNumbers = optionalBoolean(obj.get("lineNumbers"), true, "lineNumbers");
        String decompiler = optionalString(obj.get("decompiler"), "vineflower", "decompiler");
        String format = (queryFormat != null && !queryFormat.isBlank())
                ? queryFormat : optionalString(obj.get("format"), null, "format");

        OperationDetails.Result r = source.investigationContext(
                catalog.current(request.getServletContext()),
                op, url, method,
                maxLinesObj == null ? 400 : maxLinesObj,
                schemaDepthObj == null ? 3 : schemaDepthObj,
                includeSchemas, includeImplementations, includeSource, lineNumbers, decompiler, details);
        if (RestAuth.wantsMarkdown(format, request)) {
            return noStoreMarkdown(r, AgentMarkdown.renderContextJson(r.json()));
        }
        return jsonResponse(r);
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

    static List<BatchItem> parseBatchItems(String body) {
        if (body == null || body.isBlank()) {
            return List.of();
        }
        Map<String, Object> obj = JsonParser.parseObject(body);
        long defFromBundle = toLong(obj.get("fromBundle"), -1L);
        Integer defStartLine = toOptionalInt(obj.get("startLine"));
        Integer defMaxLines = toOptionalInt(obj.get("maxLines"));
        String defOp = optionalString(obj.get("op"), null, "op");
        String defDecompiler = optionalString(obj.get("decompiler"), "vineflower", "decompiler");
        String defScope = optionalString(obj.get("scope"), "class", "scope");
        String defMethod = optionalString(obj.get("method"), null, "method");
        boolean defIncludeSource = optionalBoolean(obj.get("includeSource"), true, "includeSource");
        boolean defIncludeMeta = optionalBoolean(obj.get("includeMeta"), false, "includeMeta");
        boolean defIncludeSchema = optionalBoolean(obj.get("includeSchema"), false, "includeSchema");
        boolean defLineNumbers = optionalBoolean(obj.get("lineNumbers"), false, "lineNumbers");

        Object rawItems = obj.get("items");
        if (rawItems != null) {
            if (!(rawItems instanceof List<?> list)) {
                throw new JsonParseException("expected array for items");
            }
            List<BatchItem> items = new ArrayList<>(list.size());
            for (Object entry : list) {
                if (!(entry instanceof Map<?, ?> rawMap)) {
                    throw new JsonParseException("expected object in items");
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> m = (Map<String, Object>) rawMap;
                String cls = optionalString(m.get("class"), null, "class");
                String op = optionalString(m.get("op"), defOp, "op");
                if ((cls == null || cls.isBlank()) && (op == null || op.isBlank())) {
                    throw new JsonParseException("item requires class or op");
                }
                long fromBundle = toLong(m.get("fromBundle"), defFromBundle);
                String scope = optionalString(m.get("scope"), defScope, "scope");
                String method = optionalString(m.get("method"), defMethod, "method");
                String decompiler = optionalString(m.get("decompiler"), defDecompiler, "decompiler");
                boolean incSrc = optionalBoolean(m.get("includeSource"), defIncludeSource, "includeSource");
                boolean incMeta = optionalBoolean(m.get("includeMeta"), defIncludeMeta, "includeMeta");
                boolean incSchema = optionalBoolean(m.get("includeSchema"), defIncludeSchema, "includeSchema");
                Integer startLine = m.containsKey("startLine") ? toOptionalInt(m.get("startLine")) : defStartLine;
                Integer maxLines = m.containsKey("maxLines") ? toOptionalInt(m.get("maxLines")) : defMaxLines;
                boolean lineNums = optionalBoolean(m.get("lineNumbers"), defLineNumbers, "lineNumbers");
                items.add(new BatchItem(cls, fromBundle, op, scope, method, decompiler,
                        incSrc, incMeta, incSchema, startLine, maxLines, lineNums));
            }
            return items;
        }

        BatchRequest req = parseBatchRequest(obj);
        List<BatchItem> items = new ArrayList<>(req.classes().size());
        for (String cls : req.classes()) {
            items.add(new BatchItem(cls, req.fromBundle(), req.op(), defScope, defMethod, req.decompiler(),
                    req.includeSource(), req.includeMeta(), defIncludeSchema, defStartLine, req.maxLines(), defLineNumbers));
        }
        return items;
    }

    static BatchRequest parseBatchRequest(String body) {
        if (body == null || body.isBlank()) {
            return new BatchRequest(List.of(), -1L, null, "vineflower", true, false, null);
        }
        return parseBatchRequest(JsonParser.parseObject(body));
    }

    private static BatchRequest parseBatchRequest(Map<String, Object> obj) {
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
        return RestAuth.prefersPlainText(accept);
    }

    private static Response cacheableJson(HttpServletRequest request, OperationDetails.Result result) {
        return RestAuth.cacheableResponse(request, result.status(), JSON, result.json());
    }

    private static Response markdownResponse(HttpServletRequest request, OperationDetails.Result result, String markdown) {
        return RestAuth.cacheableResponse(request, result.status(), MARKDOWN, markdown);
    }

    private static Response noStoreMarkdown(OperationDetails.Result result, String markdown) {
        return Response.status(result.status()).type(MARKDOWN).header("Cache-Control", "no-store")
                .entity(markdown).build();
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
