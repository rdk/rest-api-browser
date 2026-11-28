package com.atlassian.labs.restbrowser.rest;

import com.atlassian.annotations.security.LicensedOnly;
import com.atlassian.annotations.security.XsrfProtectionExcluded;
import com.atlassian.labs.restbrowser.catalog.CatalogQuery;
import com.atlassian.labs.restbrowser.catalog.CatalogQuery.OperationFilter;
import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.CatalogSnapshot;
import com.atlassian.labs.restbrowser.catalog.OpenApiExporter;
import com.atlassian.labs.restbrowser.catalog.OperationDetails;
import com.atlassian.labs.restbrowser.catalog.OperationDetails.Result;
import com.atlassian.labs.restbrowser.catalog.OperationSource;
import com.atlassian.labs.restbrowser.json.Json;
import com.atlassian.labs.restbrowser.json.JsonParser;
import com.atlassian.labs.restbrowser.servlet.LlmsTxtServlet;
import com.atlassian.labs.restbrowser.spring.LocalBeans;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.UrlMode;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import jakarta.inject.Inject;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.Context;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.util.Map;

import static com.atlassian.labs.restbrowser.rest.McpProtocolCatalog.boolArg;
import static com.atlassian.labs.restbrowser.rest.McpProtocolCatalog.boolObjArg;
import static com.atlassian.labs.restbrowser.rest.McpProtocolCatalog.decodeSegment;
import static com.atlassian.labs.restbrowser.rest.McpProtocolCatalog.intArg;
import static com.atlassian.labs.restbrowser.rest.McpProtocolCatalog.intObjArg;
import static com.atlassian.labs.restbrowser.rest.McpProtocolCatalog.isKnownSysadminTool;
import static com.atlassian.labs.restbrowser.rest.McpProtocolCatalog.longArg;
import static com.atlassian.labs.restbrowser.rest.McpProtocolCatalog.longObjArg;
import static com.atlassian.labs.restbrowser.rest.McpProtocolCatalog.nonBlank;
import static com.atlassian.labs.restbrowser.rest.McpProtocolCatalog.rpcErrorResponse;
import static com.atlassian.labs.restbrowser.rest.McpProtocolCatalog.rpcResourceText;
import static com.atlassian.labs.restbrowser.rest.McpProtocolCatalog.rpcResultResponse;
import static com.atlassian.labs.restbrowser.rest.McpProtocolCatalog.rpcToolResult;
import static com.atlassian.labs.restbrowser.rest.McpProtocolCatalog.rpcToolText;
import static com.atlassian.labs.restbrowser.rest.McpProtocolCatalog.strArg;

/**
 * Built-in strictly read-only Model Context Protocol (MCP) Streamable HTTP JSON-RPC 2.0 endpoint at
 * {@code /rest/restbrowser/1/mcp}. Works with standard Jira/Confluence PAT {@code Authorization: Bearer <token>}
 * headers with zero external adapters.
 */
@Path("/mcp")
@LicensedOnly
public class McpResource {

    static final String PROTOCOL_VERSION = McpProtocolCatalog.PROTOCOL_VERSION;
    static final int MAX_RPC_BODY_BYTES = McpProtocolCatalog.MAX_RPC_BODY_BYTES;

    private final CatalogService catalog;
    private final UserManager userManager;
    private final ApplicationProperties applicationProperties;
    private final PluginAccessor pluginAccessor;
    private final OperationDetails details;
    private final OperationSource source;

    @Inject
    public McpResource(CatalogService catalog,
                       UserManager userManager,
                       ApplicationProperties applicationProperties,
                       PluginAccessor pluginAccessor,
                       OperationDetails details,
                       OperationSource source) {
        this.catalog = catalog;
        this.userManager = userManager;
        this.applicationProperties = applicationProperties;
        this.pluginAccessor = pluginAccessor;
        this.details = details;
        this.source = source;
    }

    @GET
    @Produces(MediaType.APPLICATION_JSON)
    public Response getNotAllowed() {
        String err = new Json().beginObject()
                .field("error", "method-not-allowed")
                .field("hint", "Send JSON-RPC 2.0 POST requests to /rest/restbrowser/1/mcp.")
                .endObject().toString();
        return Response.status(Response.Status.METHOD_NOT_ALLOWED)
                .header("Allow", "POST")
                .type(RestAuth.JSON_MEDIA_TYPE)
                .header("Cache-Control", "no-store")
                .entity(err)
                .build();
    }

    @POST
    @Consumes(MediaType.APPLICATION_JSON)
    @Produces(MediaType.APPLICATION_JSON)
    @XsrfProtectionExcluded
    public Response rpc(InputStream body, @Context HttpServletRequest request) {
        Response denied = RestAuth.requireLicensed(userManager, request);
        if (denied != null) {
            return denied;
        }
        // Defend browser sessions against cross-origin form/fetch CSRF without blocking PAT/CLI clients
        if (isCrossOriginCookiePost(request)) {
            return RestAuth.error(Response.Status.FORBIDDEN, "xsrf-check-failed",
                    "Cross-origin cookie POST rejected; pass Authorization: Bearer <token> or X-Atlassian-Token: no-check.");
        }

        String raw;
        try {
            raw = CodeResource.readBoundedUtf8(body, MAX_RPC_BODY_BYTES);
        } catch (IOException e) {
            return rpcErrorResponse(null, -32700, "Parse error: unable to read request body");
        }
        if (raw == null || raw.isBlank()) {
            return rpcErrorResponse(null, -32600, "Invalid Request: empty JSON-RPC payload");
        }

        Map<String, Object> req;
        try {
            req = JsonParser.parseObject(raw);
        } catch (IllegalArgumentException e) {
            return rpcErrorResponse(null, -32700, "Parse error: malformed JSON");
        }

        Object id = req.get("id");
        Object rawMethod = req.get("method");
        if (!(rawMethod instanceof String method) || method.isBlank()) {
            return rpcErrorResponse(id, -32600, "Invalid Request: missing method");
        }

        if (id == null && method.startsWith("notifications/")) {
            return Response.accepted().header("Cache-Control", "no-store").build();
        }

        UserKey user = RestAuth.remoteUser(userManager, request);
        boolean sysadmin = RestAuth.isSystemAdmin(userManager, user);

        return switch (method) {
            case "initialize" -> rpcResultResponse(id,
                    McpProtocolCatalog.buildInitializeResult(sysadmin, LocalBeans.pluginVersion(pluginAccessor)));
            case "ping" -> rpcResultResponse(id, "{}");
            case "tools/list" -> rpcResultResponse(id, McpProtocolCatalog.buildToolsList(sysadmin));
            case "tools/call" -> handleToolCall(id, req.get("params"), sysadmin, request);
            case "resources/list" -> rpcResultResponse(id, McpProtocolCatalog.buildResourcesList());
            case "resources/templates/list" -> rpcResultResponse(id,
                    McpProtocolCatalog.buildResourceTemplatesList(sysadmin));
            case "resources/read" -> handleResourceRead(id, req.get("params"), sysadmin, request);
            case "prompts/list" -> rpcResultResponse(id,
                    McpProtocolCatalog.buildPromptsList(sysadmin, sysadmin && LocalBeans.isLiveScalpelEnabled(pluginAccessor)));
            case "prompts/get" -> McpProtocolCatalog.renderPromptGet(id, req.get("params"), sysadmin, canonicalOrRelativeBase());
            default -> rpcErrorResponse(id, -32601, "Method not found: " + method);
        };
    }

    private Response handleToolCall(Object id, Object rawParams, boolean sysadmin, HttpServletRequest request) {
        if (!(rawParams instanceof Map<?, ?> paramsRaw)) {
            return rpcErrorResponse(id, -32602, "Invalid params: expected object");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> params = (Map<String, Object>) paramsRaw;
        Object rawName = params.get("name");
        if (!(rawName instanceof String toolName) || toolName.isBlank()) {
            return rpcErrorResponse(id, -32602, "Invalid params: missing tool name");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> args = params.get("arguments") instanceof Map<?, ?> m
                ? (Map<String, Object>) m : Map.of();
        Integer maxChars = intObjArg(args, "maxChars");

        return switch (toolName) {
            case "search_operations" -> {
                CatalogSnapshot snap = catalog.current(request.getServletContext());
                OperationFilter filter = new OperationFilter(
                        strArg(args, "q"), strArg(args, "method"), strArg(args, "path"),
                        strArg(args, "module"), strArg(args, "plugin"), strArg(args, "access"),
                        boolObjArg(args, "deprecated"), strArg(args, "usesClass"),
                        intArg(args, "limit", 30), intArg(args, "offset", 0), false);
                String text = "markdown".equalsIgnoreCase(strArg(args, "format"))
                        ? CatalogQuery.searchMarkdown(snap, filter)
                        : CatalogQuery.searchJson(snap, filter);
                yield rpcToolText(id, text, false, maxChars);
            }
            case "resolve_url" -> {
                String url = strArg(args, "url");
                if (url == null || url.isBlank()) {
                    yield rpcToolResult(id, new Result(400, "{\"error\":\"missing-url\",\"hint\":\"Pass url argument.\"}"), maxChars);
                }
                CatalogSnapshot snap = catalog.current(request.getServletContext());
                String text = "markdown".equalsIgnoreCase(strArg(args, "format"))
                        ? CatalogQuery.resolveUrlMarkdown(snap, strArg(args, "method"), url, intArg(args, "limit", 10))
                        : CatalogQuery.resolveUrlJson(snap, strArg(args, "method"), url, intArg(args, "limit", 10));
                yield rpcToolText(id, text, false, maxChars);
            }
            case "get_catalog_summary" -> {
                String text = "brief".equalsIgnoreCase(strArg(args, "format"))
                        ? buildCatalogBrief(sysadmin, intArg(args, "top", 12), request)
                        : buildCatalogSummary(sysadmin, request);
                yield rpcToolText(id, text, false, maxChars);
            }
            case "export_module_openapi" -> {
                String module = strArg(args, "module");
                if (module == null || module.isBlank()) {
                    yield rpcToolResult(id, new Result(400, "{\"error\":\"missing-module\",\"hint\":\"Pass module key.\"}"), maxChars);
                }
                String spec = exportModuleOpenApiJson(module, sysadmin,
                        intArg(args, "schemaDepth", 2), boolArg(args, "includeSchemas", true), request);
                if (spec == null) {
                    yield rpcToolResult(id, new Result(404, "{\"error\":\"unknown-module\"}"), maxChars);
                }
                yield rpcToolText(id, spec, false, maxChars);
            }
            default -> handleSysadminTool(id, toolName, args, sysadmin, maxChars, request);
        };
    }

    private Response handleSysadminTool(Object id, String toolName, Map<String, Object> args,
                                        boolean sysadmin, Integer maxChars, HttpServletRequest request) {
        if (!isKnownSysadminTool(toolName)) {
            return rpcErrorResponse(id, -32602, "Unknown tool: " + toolName);
        }
        if (!sysadmin) {
            return rpcErrorResponse(id, -32003, "Forbidden: system administrator privileges required for " + toolName);
        }
        if (source == null) {
            return rpcToolResult(id, new Result(404, "{\"error\":\"not-described\"}"), maxChars);
        }

        Result res = switch (toolName) {
            case "investigate_operation_context" -> {
                CatalogSnapshot snap = catalog.current(request.getServletContext());
                yield source.investigationContext(
                        snap, strArg(args, "op"), strArg(args, "url"), strArg(args, "method"),
                        intArg(args, "maxLines", 400), intArg(args, "schemaDepth", 3),
                        boolArg(args, "includeSchemas", true),
                        boolArg(args, "includeImplementations", true),
                        boolArg(args, "includeSource", true),
                        boolArg(args, "lineNumbers", true),
                        nonBlank(strArg(args, "decompiler"), "vineflower"), details);
            }
            case "inspect_operation" -> {
                catalog.current(request.getServletContext());
                yield source.operationBundle(
                        strArg(args, "op"),
                        nonBlank(strArg(args, "scope"), "method"),
                        nonBlank(strArg(args, "decompiler"), "vineflower"),
                        details,
                        !"full".equalsIgnoreCase(strArg(args, "view")),
                        intObjArg(args, "startLine"), intObjArg(args, "maxLines"),
                        boolArg(args, "lineNumbers", true));
            }
            case "get_dto_schema" -> {
                maybeTouchCatalog(args, request);
                yield source.inspectSchema(strArg(args, "op"), strArg(args, "class"),
                        longArg(args, "fromBundle", -1L), intArg(args, "depth", 3),
                        boolArg(args, "includeExample", true));
            }
            case "inspect_class" -> {
                maybeTouchCatalog(args, request);
                yield source.inspectClass(strArg(args, "op"), strArg(args, "class"),
                        longArg(args, "fromBundle", -1L),
                        "compact".equalsIgnoreCase(strArg(args, "view")),
                        boolArg(args, "outline", true),
                        boolArg(args, "includeImplementations", false));
            }
            case "find_implementations" -> {
                maybeTouchCatalog(args, request);
                yield source.findImplementations(strArg(args, "op"), strArg(args, "class"),
                        longArg(args, "fromBundle", -1L), longObjArg(args, "bundleId"),
                        strArg(args, "plugin"), boolArg(args, "includeAbstract", false),
                        intArg(args, "limit", 30));
            }
            case "find_callers" -> {
                maybeTouchCatalog(args, request);
                yield source.findCallers(strArg(args, "op"), strArg(args, "class"), strArg(args, "method"),
                        longArg(args, "fromBundle", -1L), longObjArg(args, "bundleId"),
                        strArg(args, "plugin"), strArg(args, "packagePrefix"), intArg(args, "limit", 50));
            }
            case "grep_bytecode" -> source.grepBytecode(
                    strArg(args, "q"), boolArg(args, "caseSensitive", false), boolArg(args, "includeUtf8", true),
                    longObjArg(args, "bundleId"), strArg(args, "plugin"), strArg(args, "packagePrefix"),
                    intArg(args, "limit", 50));
            case "decompile_source" -> {
                maybeTouchCatalog(args, request);
                yield source.decompile(strArg(args, "op"), strArg(args, "class"), longArg(args, "fromBundle", -1L),
                        nonBlank(strArg(args, "scope"), "class"),
                        nonBlank(strArg(args, "decompiler"), "vineflower"),
                        strArg(args, "method"), intObjArg(args, "startLine"), intObjArg(args, "maxLines"),
                        boolArg(args, "includeMeta", false), boolArg(args, "lineNumbers", true));
            }
            case "traverse_graph" -> {
                maybeTouchCatalog(args, request);
                boolean domain = "domain".equalsIgnoreCase(strArg(args, "preset"));
                yield source.traverseGraph(strArg(args, "op"), strArg(args, "class"), longArg(args, "fromBundle", -1L),
                        intArg(args, "depth", 2), intArg(args, "maxNodes", 30),
                        !domain && boolArg(args, "includeJdk", false),
                        domain || boolArg(args, "excludeLibraries", false),
                        strArg(args, "packagePrefix"), boolArg(args, "includeSources", false),
                        nonBlank(strArg(args, "decompiler"), "vineflower"), strArg(args, "edgeKinds"));
            }
            case "search_classes" -> source.searchClasses(
                    strArg(args, "q"), intArg(args, "limit", 30), longObjArg(args, "bundleId"));
            case "inspect_plugin" -> source.inspectPlugin(
                    strArg(args, "key"), "compact".equalsIgnoreCase(strArg(args, "view")));
            case "read_bundle_resource" -> source.inspectResource(
                    longObjArg(args, "bundleId"), strArg(args, "plugin"), strArg(args, "path"),
                    strArg(args, "prefix"), intObjArg(args, "startLine"), intObjArg(args, "maxLines"),
                    boolArg(args, "lineNumbers", false), intArg(args, "limit", 100));
            default -> new Result(400, "{\"error\":\"unknown-tool\"}");
        };
        return rpcToolResult(id, res, maxChars);
    }

    private void maybeTouchCatalog(Map<String, Object> args, HttpServletRequest request) {
        String op = strArg(args, "op");
        if (op != null && !op.isBlank()) {
            catalog.current(request.getServletContext());
        }
    }

    private String buildCatalogSummary(boolean sysadmin, HttpServletRequest request) {
        CatalogSnapshot snap = catalog.current(request.getServletContext());
        boolean admin = sysadmin || RestAuth.isAdmin(userManager, RestAuth.remoteUser(userManager, request));
        return snap.summary(
                applicationProperties.getDisplayName(),
                applicationProperties.getVersion(),
                applicationProperties.getBuildNumber(),
                applicationProperties.getBaseUrl(UrlMode.RELATIVE),
                admin, sysadmin,
                LocalBeans.clusterNodeId(),
                sysadmin && LocalBeans.isLiveScalpelEnabled(pluginAccessor));
    }

    private String buildCatalogBrief(boolean sysadmin, int top, HttpServletRequest request) {
        CatalogSnapshot snap = catalog.current(request.getServletContext());
        return CatalogQuery.briefText(
                snap,
                applicationProperties.getDisplayName(),
                applicationProperties.getVersion(),
                LocalBeans.clusterNodeId(),
                sysadmin,
                sysadmin && LocalBeans.isLiveScalpelEnabled(pluginAccessor),
                top);
    }

    private String exportModuleOpenApiJson(String module, boolean sysadmin, int schemaDepth, boolean includeSchemas,
                                           HttpServletRequest request) {
        CatalogSnapshot snap = catalog.current(request.getServletContext());
        boolean withSchemas = sysadmin && includeSchemas;
        return OpenApiExporter.moduleSpecJson(snap, module,
                applicationProperties.getBaseUrl(UrlMode.RELATIVE),
                withSchemas, schemaDepth, withSchemas ? source : null);
    }

    private String canonicalOrRelativeBase() {
        String base = applicationProperties.getBaseUrl(UrlMode.CANONICAL);
        if (base == null || base.isBlank()) {
            base = applicationProperties.getBaseUrl(UrlMode.RELATIVE);
        }
        if (base == null) {
            return "";
        }
        int end = base.length();
        while (end > 0 && base.charAt(end - 1) == '/') {
            end--;
        }
        return base.substring(0, end);
    }

    private Response handleResourceRead(Object id, Object rawParams, boolean sysadmin, HttpServletRequest request) {
        if (!(rawParams instanceof Map<?, ?> params)) {
            return rpcErrorResponse(id, -32602, "Invalid params: expected object");
        }
        Object rawUri = params.get("uri");
        if (!(rawUri instanceof String uri) || uri.isBlank()) {
            return rpcErrorResponse(id, -32602, "Invalid params: missing resource uri");
        }
        return switch (uri) {
            case "rab://llms.txt" -> rpcResourceText(id, uri, "text/markdown",
                    LlmsTxtServlet.renderGuide(applicationProperties, pluginAccessor, catalog, true, sysadmin, false));
            case "rab://llms-full.txt" -> rpcResourceText(id, uri, "text/markdown",
                    LlmsTxtServlet.renderGuide(applicationProperties, pluginAccessor, catalog, true, sysadmin, true));
            case "rab://catalog/summary" -> rpcResourceText(id, uri, "application/json",
                    buildCatalogSummary(sysadmin, request));
            case "rab://catalog/brief" -> rpcResourceText(id, uri, "text/plain",
                    buildCatalogBrief(sysadmin, 12, request));
            case "rab://openapi/self" -> rpcResourceText(id, uri, "application/json",
                    OpenApiExporter.selfSpecJson(canonicalOrRelativeBase(), LocalBeans.pluginVersion(pluginAccessor), sysadmin));
            default -> handleTemplateResourceRead(id, uri, sysadmin, request);
        };
    }

    private Response handleTemplateResourceRead(Object id, String uri, boolean sysadmin, HttpServletRequest request) {
        if (uri.startsWith("rab://catalog/openapi/")) {
            String mod = decodeSegment(uri.substring("rab://catalog/openapi/".length()));
            if (mod == null) {
                return rpcErrorResponse(id, -32602, "Invalid module identifier in resource URI");
            }
            String spec = exportModuleOpenApiJson(mod, sysadmin, 2, true, request);
            if (spec == null) {
                return rpcErrorResponse(id, -32002, "Resource not found: unknown module " + mod);
            }
            return rpcResourceText(id, uri, "application/json", spec);
        }
        if (uri.startsWith("rab://code/")) {
            if (!sysadmin) {
                return rpcErrorResponse(id, -32003, "Forbidden: system administrator privileges required for " + uri);
            }
            if (source == null) {
                return rpcErrorResponse(id, -32002, "Resource unavailable: code inspector disabled");
            }
            Result res;
            if (uri.startsWith("rab://code/class/")) {
                String fqcn = decodeSegment(uri.substring("rab://code/class/".length()));
                if (fqcn == null) {
                    return rpcErrorResponse(id, -32602, "Invalid class name in resource URI");
                }
                res = source.inspectClass(null, fqcn, -1L, false, true, false);
            } else if (uri.startsWith("rab://code/source/")) {
                String fqcn = decodeSegment(uri.substring("rab://code/source/".length()));
                if (fqcn == null) {
                    return rpcErrorResponse(id, -32602, "Invalid class name in resource URI");
                }
                res = source.decompile(null, fqcn, -1L, "class", "vineflower", null, 1, 500, false, true);
            } else if (uri.startsWith("rab://code/plugin/")) {
                String key = decodeSegment(uri.substring("rab://code/plugin/".length()));
                if (key == null) {
                    return rpcErrorResponse(id, -32602, "Invalid plugin key in resource URI");
                }
                res = source.inspectPlugin(key, false);
            } else {
                return rpcErrorResponse(id, -32002, "Resource not found: " + uri);
            }
            if (res.status() >= 400) {
                return rpcErrorResponse(id, -32002, "Resource not found: " + uri);
            }
            return rpcResourceText(id, uri, "application/json", res.json());
        }
        return rpcErrorResponse(id, -32002, "Resource not found: " + uri);
    }

    private static boolean isCrossOriginCookiePost(HttpServletRequest request) {
        if (request == null || RestAuth.xsrfHeader(request)) {
            return false;
        }
        String auth = request.getHeader("Authorization");
        if (auth != null && !auth.isBlank()) {
            return false;
        }
        String origin = request.getHeader("Origin");
        if (origin == null || origin.isBlank() || "null".equalsIgnoreCase(origin.trim())) {
            return origin != null && "null".equalsIgnoreCase(origin.trim());
        }
        try {
            URI u = URI.create(origin.trim());
            String originHost = u.getHost();
            String serverHost = request.getServerName();
            if (originHost == null || serverHost == null || !originHost.equalsIgnoreCase(serverHost)) {
                return true;
            }
            if (u.getScheme() != null && !u.getScheme().equalsIgnoreCase(request.getScheme())) {
                return true;
            }
            int op = effectivePort(u.getScheme(), u.getPort());
            int sp = effectivePort(request.getScheme(), request.getServerPort());
            return op > 0 && sp > 0 && op != sp;
        } catch (IllegalArgumentException e) {
            return true;
        }
    }

    private static int effectivePort(String scheme, int port) {
        if (port > 0) return port;
        if ("https".equalsIgnoreCase(scheme)) return 443;
        if ("http".equalsIgnoreCase(scheme)) return 80;
        return -1;
    }
}
