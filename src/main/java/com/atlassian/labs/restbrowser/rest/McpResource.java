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
import com.atlassian.labs.restbrowser.servlet.AdminIntroServlet;
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
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Built-in strictly read-only Model Context Protocol (MCP) Streamable HTTP JSON-RPC 2.0 endpoint at
 * {@code /rest/restbrowser/1/mcp}. Works with standard Jira/Confluence PAT {@code Authorization: Bearer <token>}
 * headers with zero external adapters.
 */
@Path("/mcp")
@LicensedOnly
public class McpResource {

    static final String PROTOCOL_VERSION = "2025-03-26";
    static final int MAX_RPC_BODY_BYTES = 65_536;

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
            case "initialize" -> rpcResultResponse(id, buildInitializeResult(sysadmin));
            case "ping" -> rpcResultResponse(id, "{}");
            case "tools/list" -> rpcResultResponse(id, buildToolsList(sysadmin));
            case "tools/call" -> handleToolCall(id, req.get("params"), sysadmin, request);
            case "resources/list" -> rpcResultResponse(id, buildResourcesList());
            case "resources/templates/list" -> rpcResultResponse(id, buildResourceTemplatesList(sysadmin));
            case "resources/read" -> handleResourceRead(id, req.get("params"), sysadmin, request);
            case "prompts/list" -> rpcResultResponse(id, buildPromptsList(sysadmin));
            case "prompts/get" -> handlePromptGet(id, req.get("params"), sysadmin);
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
                yield rpcToolText(id, text, false);
            }
            case "resolve_url" -> {
                String url = strArg(args, "url");
                if (url == null || url.isBlank()) {
                    yield rpcToolResult(id, new Result(400, "{\"error\":\"missing-url\",\"hint\":\"Pass url argument.\"}"));
                }
                CatalogSnapshot snap = catalog.current(request.getServletContext());
                String text = "markdown".equalsIgnoreCase(strArg(args, "format"))
                        ? CatalogQuery.resolveUrlMarkdown(snap, strArg(args, "method"), url, intArg(args, "limit", 10))
                        : CatalogQuery.resolveUrlJson(snap, strArg(args, "method"), url, intArg(args, "limit", 10));
                yield rpcToolText(id, text, false);
            }
            case "get_catalog_summary" -> rpcToolText(id, buildCatalogSummary(sysadmin, request), false);
            case "export_module_openapi" -> {
                String module = strArg(args, "module");
                if (module == null || module.isBlank()) {
                    yield rpcToolResult(id, new Result(400, "{\"error\":\"missing-module\",\"hint\":\"Pass module key.\"}"));
                }
                String spec = exportModuleOpenApiJson(module, sysadmin,
                        intArg(args, "schemaDepth", 2), boolArg(args, "includeSchemas", true), request);
                if (spec == null) {
                    yield rpcToolResult(id, new Result(404, "{\"error\":\"unknown-module\"}"));
                }
                yield rpcToolText(id, spec, false);
            }
            default -> handleSysadminTool(id, toolName, args, sysadmin, request);
        };
    }

    private Response handleSysadminTool(Object id, String toolName, Map<String, Object> args,
                                        boolean sysadmin, HttpServletRequest request) {
        if (!isKnownSysadminTool(toolName)) {
            return rpcErrorResponse(id, -32602, "Unknown tool: " + toolName);
        }
        if (!sysadmin) {
            return rpcErrorResponse(id, -32003, "Forbidden: system administrator privileges required for " + toolName);
        }
        if (source == null) {
            return rpcToolResult(id, new Result(404, "{\"error\":\"not-described\"}"));
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
        return rpcToolResult(id, res);
    }

    private void maybeTouchCatalog(Map<String, Object> args, HttpServletRequest request) {
        String op = strArg(args, "op");
        if (op != null && !op.isBlank()) {
            catalog.current(request.getServletContext());
        }
    }

    private String buildInitializeResult(boolean sysadmin) {
        String ver = LocalBeans.pluginVersion(pluginAccessor);
        return new Json().beginObject()
                .field("protocolVersion", PROTOCOL_VERSION)
                .name("capabilities").beginObject()
                .name("tools").beginObject().field("listChanged", false).endObject()
                .name("resources").beginObject().field("subscribe", false).field("listChanged", false).endObject()
                .name("prompts").beginObject().field("listChanged", false).endObject()
                .endObject()
                .name("serverInfo").beginObject()
                .field("name", "rest-api-browser")
                .field("version", ver.isEmpty() ? "4.4.0" : ver)
                .endObject()
                .field("instructions", sysadmin
                        ? "Read-only Atlassian REST & JVM inspection tools, resources, and prompts enabled. Start with search_operations, resolve_url, or investigate_operation_context."
                        : "Read-only Atlassian REST catalog tools, resources, and prompts enabled (system administrator role unlocks Java bytecode and source tools).")
                .endObject().toString();
    }

    private String buildCatalogSummary(boolean sysadmin, HttpServletRequest request) {
        CatalogSnapshot snap = catalog.current(request.getServletContext());
        boolean admin = sysadmin || RestAuth.isAdmin(userManager, RestAuth.remoteUser(userManager, request));
        return snap.summary(
                applicationProperties.getDisplayName(),
                applicationProperties.getVersion(),
                applicationProperties.getBuildNumber(),
                applicationProperties.getBaseUrl(UrlMode.RELATIVE),
                admin, sysadmin);
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

    private static String buildResourcesList() {
        Json j = new Json().beginObject().name("resources").beginArray();
        resourceEntry(j, "rab://llms.txt", "llms-txt",
                "Compact llmstxt.org Markdown discovery guide for all REST API Browser endpoints.", "text/markdown");
        resourceEntry(j, "rab://llms-full.txt", "llms-full-txt",
                "Complete Markdown agent reference with curl examples, MCP client config, and error recovery hints.", "text/markdown");
        resourceEntry(j, "rab://catalog/summary", "catalog-summary",
                "Current REST catalog hash, product metadata, completeness progress, and modules.", "application/json");
        resourceEntry(j, "rab://openapi/self", "openapi-self",
                "OpenAPI 3.1.0 specification of REST API Browser's own agent and catalog endpoints.", "application/json");
        return j.endArray().endObject().toString();
    }

    private static void resourceEntry(Json j, String uri, String name, String description, String mimeType) {
        j.beginObject()
                .field("uri", uri)
                .field("name", name)
                .field("description", description)
                .field("mimeType", mimeType)
                .endObject();
    }

    private static String buildResourceTemplatesList(boolean sysadmin) {
        Json j = new Json().beginObject().name("resourceTemplates").beginArray();
        templateEntry(j, "rab://catalog/openapi/{module}", "module-openapi",
                "OpenAPI 3.1.0 specification for an indexed REST module (URL-encoded module ID).", "application/json");
        if (sysadmin) {
            templateEntry(j, "rab://code/class/{fqcn}", "class-metadata",
                    "Class reflection metadata, fields, enums, bytecode outline, and OSGi bundle/plugin ownership.", "application/json");
            templateEntry(j, "rab://code/source/{fqcn}", "class-source",
                    "Decompiled Java class source (Vineflower default with CFR fallback diagnostics).", "application/json");
            templateEntry(j, "rab://code/plugin/{pluginKey}", "plugin-metadata",
                    "Atlassian plugin metadata, dependencies, modules, and backing OSGi bundle.", "application/json");
        }
        return j.endArray().endObject().toString();
    }

    private static void templateEntry(Json j, String uriTemplate, String name, String description, String mimeType) {
        j.beginObject()
                .field("uriTemplate", uriTemplate)
                .field("name", name)
                .field("description", description)
                .field("mimeType", mimeType)
                .endObject();
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

    private static String decodeSegment(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            String decoded = URLDecoder.decode(raw, StandardCharsets.UTF_8);
            return decoded.isBlank() ? null : decoded;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static Response rpcResourceText(Object id, String uri, String mimeType, String text) {
        String out = new Json().beginObject()
                .name("contents").beginArray()
                .beginObject()
                .field("uri", uri)
                .field("mimeType", mimeType)
                .field("text", text == null ? "" : text)
                .endObject()
                .endArray()
                .endObject().toString();
        return rpcResultResponse(id, out);
    }

    private static String buildPromptsList(boolean sysadmin) {
        Json j = new Json().beginObject().name("prompts").beginArray();
        promptEntry(j, "explore-endpoint-payload",
                "Document a REST endpoint's permissions, parameters, and request/response DTO payload.",
                "query", "Search keyword or /rest/... path (optional)");
        if (sysadmin) {
            promptEntry(j, "debug-stuck-endpoint",
                    "Investigate why a REST endpoint is slow or stuck (read-only).",
                    "target", "Endpoint URL, operation key, or thread-dump symptom (optional)");
            promptEntry(j, "trace-rest-error",
                    "Trace an unexpected REST error message or status code back to bytecode and handlers.",
                    "error", "Error text, message fragment, or HTTP status symptom (optional)");
        }
        return j.endArray().endObject().toString();
    }

    private static void promptEntry(Json j, String name, String description, String argName, String argDescription) {
        j.beginObject()
                .field("name", name)
                .field("description", description)
                .name("arguments").beginArray()
                .beginObject()
                .field("name", argName)
                .field("description", argDescription)
                .field("required", false)
                .endObject()
                .endArray()
                .endObject();
    }

    private Response handlePromptGet(Object id, Object rawParams, boolean sysadmin) {
        if (!(rawParams instanceof Map<?, ?> params)) {
            return rpcErrorResponse(id, -32602, "Invalid params: expected object");
        }
        Object rawName = params.get("name");
        if (!(rawName instanceof String name) || name.isBlank()) {
            return rpcErrorResponse(id, -32602, "Invalid params: missing prompt name");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> args = params.get("arguments") instanceof Map<?, ?> m
                ? (Map<String, Object>) m : Map.of();
        String base = canonicalOrRelativeBase();
        String apiBase = base + "/rest/restbrowser/1";
        String uiBase = base + "/plugins/servlet/rest-api-browser";

        String description;
        String promptText;
        switch (name) {
            case "explore-endpoint-payload" -> {
                description = "Document a REST endpoint's permissions, parameters, and DTO payload.";
                promptText = substitutePlaceholder(
                        AdminIntroServlet.buildPromptExplorePayload(apiBase),
                        "<PASTE KEYWORD OR /rest/... URL HERE>",
                        strArg(args, "query"));
            }
            case "debug-stuck-endpoint" -> {
                if (!sysadmin) {
                    return rpcErrorResponse(id, -32003, "Forbidden: system administrator privileges required for " + name);
                }
                description = "Investigate why a REST endpoint is slow or stuck (read-only).";
                promptText = substitutePlaceholder(
                        AdminIntroServlet.buildPromptDebugStuck(apiBase, uiBase),
                        "<PASTE REQUEST URL / THREAD DUMP SYMPTOM HERE>",
                        strArg(args, "target"));
            }
            case "trace-rest-error" -> {
                if (!sysadmin) {
                    return rpcErrorResponse(id, -32003, "Forbidden: system administrator privileges required for " + name);
                }
                description = "Trace an unexpected REST error message or status code back to bytecode and handlers.";
                promptText = substitutePlaceholder(
                        AdminIntroServlet.buildPromptTraceError(apiBase),
                        "<PASTE ERROR STRING / LOG FRAGMENT HERE>",
                        strArg(args, "error"));
            }
            default -> {
                return rpcErrorResponse(id, -32602, "Unknown prompt: " + name);
            }
        }
        String out = new Json().beginObject()
                .field("description", description)
                .name("messages").beginArray()
                .beginObject()
                .field("role", "user")
                .name("content").beginObject()
                .field("type", "text")
                .field("text", promptText)
                .endObject()
                .endObject()
                .endArray()
                .endObject().toString();
        return rpcResultResponse(id, out);
    }

    private static String substitutePlaceholder(String template, String placeholder, String value) {
        if (value == null || value.isBlank()) {
            return template;
        }
        return template.replace(placeholder, value.trim());
    }

    private static String buildToolsList(boolean sysadmin) {
        Json j = new Json().beginObject().name("tools").beginArray();
        tool(j, "search_operations", "Search indexed REST operations by query tokens, HTTP method, path, module, plugin, access, or DTO class.",
                Map.ofEntries(
                        Map.entry("q", "string"), Map.entry("method", "string"), Map.entry("path", "string"),
                        Map.entry("module", "string"), Map.entry("plugin", "string"), Map.entry("access", "string"),
                        Map.entry("deprecated", "boolean"), Map.entry("usesClass", "string"),
                        Map.entry("limit", "integer"), Map.entry("offset", "integer"), Map.entry("format", "string")),
                List.of());
        tool(j, "resolve_url", "Resolve a concrete endpoint URL (full or /rest/...) to matching JAX-RS operation key(s) and extracted pathParams.",
                Map.of("url", "string", "method", "string", "limit", "integer", "format", "string"),
                List.of("url"));
        tool(j, "get_catalog_summary", "Fetch current catalog hash, completeness progress, and REST modules.",
                Map.of(), List.of());
        tool(j, "export_module_openapi", "Generate an OpenAPI 3.1.0 specification for a single catalog REST module.",
                Map.of("module", "string", "includeSchemas", "boolean", "schemaDepth", "integer"),
                List.of("module"));

        if (sysadmin) {
            tool(j, "investigate_operation_context", "One-shot context bundle: operation metadata, DTO schemas, decompiled handler source, and OSGi implementations for injected fields.",
                    Map.of("op", "string", "url", "string", "method", "string", "maxLines", "integer",
                            "schemaDepth", "integer", "includeSchemas", "boolean", "includeImplementations", "boolean",
                            "includeSource", "boolean", "lineNumbers", "boolean", "decompiler", "string"),
                    List.of());
            tool(j, "inspect_operation", "Fetch operation reflection details, OSGi provenance, and decompiled handler source.",
                    Map.of("op", "string", "scope", "string", "decompiler", "string", "view", "string",
                            "startLine", "integer", "maxLines", "integer", "lineNumbers", "boolean"),
                    List.of("op"));
            tool(j, "get_dto_schema", "Generate Draft 2020-12 JSON Schema + example payload for a DTO class or operation request/response.",
                    Map.of("class", "string", "op", "string", "fromBundle", "integer", "depth", "integer", "includeExample", "boolean"),
                    List.of());
            tool(j, "inspect_class", "Inspect Java class fields, enum constants, bytecode line-number outlines, and OSGi/plugin provenance without decompiling.",
                    Map.of("class", "string", "op", "string", "fromBundle", "integer", "view", "string",
                            "outline", "boolean", "includeImplementations", "boolean"),
                    List.of());
            tool(j, "find_implementations", "Find live OSGi registered service providers and concrete bytecode subtypes of an interface/abstract class.",
                    Map.of("class", "string", "op", "string", "fromBundle", "integer", "bundleId", "integer",
                            "plugin", "string", "includeAbstract", "boolean", "limit", "integer"),
                    List.of());
            tool(j, "find_callers", "Find classes in wired OSGi bundles whose bytecode constant pools invoke methods on the target class.",
                    Map.of("class", "string", "method", "string", "op", "string", "fromBundle", "integer",
                            "bundleId", "integer", "plugin", "string", "packagePrefix", "string", "limit", "integer"),
                    List.of());
            tool(j, "grep_bytecode", "Grep string and UTF-8 constants across active OSGi bundles (fast, no decompilation).",
                    Map.of("q", "string", "bundleId", "integer", "plugin", "string", "packagePrefix", "string",
                            "caseSensitive", "boolean", "includeUtf8", "boolean", "limit", "integer"),
                    List.of("q"));
            tool(j, "decompile_source", "Decompile a Java class or method via Vineflower or CFR with optional 1-based line slicing and numbering.",
                    Map.of("class", "string", "op", "string", "method", "string", "scope", "string", "decompiler", "string",
                            "fromBundle", "integer", "startLine", "integer", "maxLines", "integer",
                            "includeMeta", "boolean", "lineNumbers", "boolean"),
                    List.of());
            tool(j, "traverse_graph", "Typed BFS traversal of class references across OSGi bundle wires (supports preset='domain' and edgeKinds).",
                    Map.ofEntries(
                            Map.entry("class", "string"), Map.entry("op", "string"), Map.entry("fromBundle", "integer"),
                            Map.entry("depth", "integer"), Map.entry("maxNodes", "integer"), Map.entry("includeJdk", "boolean"),
                            Map.entry("excludeLibraries", "boolean"), Map.entry("preset", "string"), Map.entry("edgeKinds", "string"),
                            Map.entry("packagePrefix", "string"), Map.entry("includeSources", "boolean"), Map.entry("decompiler", "string")),
                    List.of());
            tool(j, "search_classes", "Search Java class names across active OSGi bundles.",
                    Map.of("q", "string", "limit", "integer", "bundleId", "integer"),
                    List.of("q"));
            tool(j, "inspect_plugin", "Inspect an Atlassian plugin, its dependencies, modules, and OSGi bundle.",
                    Map.of("key", "string", "view", "string"),
                    List.of("key"));
            tool(j, "read_bundle_resource", "List or read non-binary text resources (atlassian-plugin.xml, Spring XML, .vm, .properties) inside an OSGi bundle.",
                    Map.of("bundleId", "integer", "plugin", "string", "path", "string", "prefix", "string",
                            "startLine", "integer", "maxLines", "integer", "lineNumbers", "boolean", "limit", "integer"),
                    List.of());
        }
        return j.endArray().endObject().toString();
    }

    private static void tool(Json j, String name, String description, Map<String, String> props, List<String> required) {
        j.beginObject()
                .field("name", name)
                .field("description", description)
                .name("annotations").beginObject()
                .field("readOnlyHint", true)
                .field("destructiveHint", false)
                .field("idempotentHint", true)
                .field("openWorldHint", false)
                .endObject()
                .name("inputSchema").beginObject()
                .field("type", "object")
                .name("properties").beginObject();
        for (Map.Entry<String, String> e : props.entrySet()) {
            j.name(e.getKey()).beginObject().field("type", e.getValue()).endObject();
        }
        j.endObject();
        if (!required.isEmpty()) {
            j.strings("required", required);
        }
        j.endObject().endObject();
    }

    private static boolean isKnownSysadminTool(String name) {
        return List.of(
                "investigate_operation_context", "inspect_operation", "get_dto_schema", "inspect_class",
                "find_implementations", "find_callers", "grep_bytecode", "decompile_source",
                "traverse_graph", "search_classes", "inspect_plugin", "read_bundle_resource"
        ).contains(name);
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

    private static Response rpcToolResult(Object id, Result res) {
        return rpcToolText(id, res.json(), res.status() >= 400);
    }

    private static Response rpcToolText(Object id, String text, boolean isError) {
        Json result = new Json().beginObject()
                .name("content").beginArray()
                .beginObject().field("type", "text").field("text", text == null ? "" : text).endObject()
                .endArray()
                .field("isError", isError)
                .endObject();
        return rpcResultResponse(id, result.toString());
    }

    private static Response rpcResultResponse(Object id, String rawResultJson) {
        Json j = new Json().beginObject().field("jsonrpc", "2.0");
        writeId(j, id);
        j.name("result").raw(rawResultJson).endObject();
        return Response.ok(j.toString(), RestAuth.JSON_MEDIA_TYPE).header("Cache-Control", "no-store").build();
    }

    private static Response rpcErrorResponse(Object id, int code, String message) {
        Json j = new Json().beginObject().field("jsonrpc", "2.0");
        writeId(j, id);
        j.name("error").beginObject()
                .field("code", code)
                .field("message", message)
                .endObject().endObject();
        return Response.ok(j.toString(), RestAuth.JSON_MEDIA_TYPE).header("Cache-Control", "no-store").build();
    }

    private static void writeId(Json j, Object id) {
        j.name("id");
        if (id == null) {
            j.value((String) null);
        } else if (id instanceof Number n) {
            j.value(n.longValue());
        } else {
            j.value(String.valueOf(id));
        }
    }

    private static String strArg(Map<String, Object> args, String key) {
        Object v = args.get(key);
        return v instanceof String s ? s : (v == null ? null : String.valueOf(v));
    }

    private static String nonBlank(String s, String fallback) {
        return s == null || s.isBlank() ? fallback : s;
    }

    private static int intArg(Map<String, Object> args, String key, int fallback) {
        Object v = args.get(key);
        return v instanceof Number n ? n.intValue() : fallback;
    }

    private static Integer intObjArg(Map<String, Object> args, String key) {
        Object v = args.get(key);
        return v instanceof Number n ? n.intValue() : null;
    }

    private static long longArg(Map<String, Object> args, String key, long fallback) {
        Object v = args.get(key);
        return v instanceof Number n ? n.longValue() : fallback;
    }

    private static Long longObjArg(Map<String, Object> args, String key) {
        Object v = args.get(key);
        return v instanceof Number n ? n.longValue() : null;
    }

    private static boolean boolArg(Map<String, Object> args, String key, boolean fallback) {
        Object v = args.get(key);
        return v instanceof Boolean b ? b : fallback;
    }

    private static Boolean boolObjArg(Map<String, Object> args, String key) {
        Object v = args.get(key);
        return v instanceof Boolean b ? b : null;
    }
}
