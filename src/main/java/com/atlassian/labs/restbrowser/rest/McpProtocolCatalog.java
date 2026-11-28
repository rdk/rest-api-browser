package com.atlassian.labs.restbrowser.rest;

import com.atlassian.labs.restbrowser.catalog.AgentMarkdown;
import com.atlassian.labs.restbrowser.catalog.OperationDetails.Result;
import com.atlassian.labs.restbrowser.json.Json;
import com.atlassian.labs.restbrowser.servlet.AdminIntroServlet;
import jakarta.ws.rs.core.Response;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * Static MCP JSON-RPC 2.0 tool/resource/prompt catalog definitions, prompt renderer, response wrappers,
 * and typed argument extraction helpers for {@link McpResource}.
 */
final class McpProtocolCatalog {

    static final String PROTOCOL_VERSION = "2025-03-26";
    static final int MAX_RPC_BODY_BYTES = 65_536;

    private McpProtocolCatalog() {
    }

    static String buildInitializeResult(boolean sysadmin, String pluginVersion) {
        return new Json().beginObject()
                .field("protocolVersion", PROTOCOL_VERSION)
                .name("capabilities").beginObject()
                .name("tools").beginObject().field("listChanged", false).endObject()
                .name("resources").beginObject().field("subscribe", false).field("listChanged", false).endObject()
                .name("prompts").beginObject().field("listChanged", false).endObject()
                .endObject()
                .name("serverInfo").beginObject()
                .field("name", "rest-api-browser")
                .field("version", pluginVersion == null || pluginVersion.isEmpty() ? "unknown" : pluginVersion)
                .endObject()
                .field("instructions", sysadmin
                        ? "Read-only Atlassian REST & JVM inspection tools, resources, and prompts enabled. Start with search_operations, resolve_url, or investigate_operation_context."
                        : "Read-only Atlassian REST catalog tools, resources, and prompts enabled (system administrator role unlocks Java bytecode and source tools).")
                .endObject().toString();
    }

    static String buildResourcesList() {
        Json j = new Json().beginObject().name("resources").beginArray();
        resourceEntry(j, "rab://llms.txt", "llms-txt",
                "Compact llmstxt.org Markdown discovery guide for all REST API Browser endpoints.", "text/markdown");
        resourceEntry(j, "rab://llms-full.txt", "llms-full-txt",
                "Complete Markdown agent reference with curl examples, MCP client config, and error recovery hints.", "text/markdown");
        resourceEntry(j, "rab://catalog/summary", "catalog-summary",
                "Current REST catalog hash, product metadata, completeness progress, and modules.", "application/json");
        resourceEntry(j, "rab://catalog/brief", "catalog-brief",
                "Compact ~200-token plain-text overview of node, catalog hash, top modules, and failures.", "text/plain");
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

    static String buildResourceTemplatesList(boolean sysadmin) {
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

    static String buildPromptsList(boolean sysadmin, boolean liveScalpel) {
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
            if (liveScalpel) {
                promptEntry(j, "dual-profile-and-decompile",
                        "Diagnose a slow or failing REST endpoint across Live Scalpel runtime traces and REST API Browser bytecode.",
                        "target", "Target /rest/... URL or symptom (optional)");
            }
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

    static Response renderPromptGet(Object id, Object rawParams, boolean sysadmin, String base) {
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
            case "dual-profile-and-decompile" -> {
                if (!sysadmin) {
                    return rpcErrorResponse(id, -32003, "Forbidden: system administrator privileges required for " + name);
                }
                description = "Diagnose a slow or failing REST endpoint across Live Scalpel runtime traces and REST API Browser bytecode.";
                promptText = substitutePlaceholder(
                        AdminIntroServlet.buildPromptDualWorkflow(apiBase, base + "/rest/scalpel/1"),
                        "<PASTE /rest/... URL HERE>",
                        strArg(args, "target"));
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

    static String buildToolsList(boolean sysadmin) {
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
        tool(j, "get_catalog_summary", "Fetch current catalog hash, completeness progress, and REST modules (supports format='brief').",
                Map.of("format", "string", "top", "integer"), List.of());
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
        if (!props.containsKey("maxChars")) {
            j.name("maxChars").beginObject().field("type", "integer").endObject();
        }
        j.endObject();
        if (!required.isEmpty()) {
            j.strings("required", required);
        }
        j.endObject().endObject();
    }

    static boolean isKnownSysadminTool(String name) {
        return List.of(
                "investigate_operation_context", "inspect_operation", "get_dto_schema", "inspect_class",
                "find_implementations", "find_callers", "grep_bytecode", "decompile_source",
                "traverse_graph", "search_classes", "inspect_plugin", "read_bundle_resource"
        ).contains(name);
    }

    static String decodeSegment(String raw) {
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

    static Response rpcResourceText(Object id, String uri, String mimeType, String text) {
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

    static Response rpcToolResult(Object id, Result res, Integer maxChars) {
        return rpcToolText(id, res.json(), res.status() >= 400, maxChars);
    }

    static Response rpcToolText(Object id, String text, boolean isError, Integer maxChars) {
        String capped = AgentMarkdown.truncateToChars(text == null ? "" : text, maxChars);
        Json result = new Json().beginObject()
                .name("content").beginArray()
                .beginObject().field("type", "text").field("text", capped).endObject()
                .endArray()
                .field("isError", isError)
                .endObject();
        return rpcResultResponse(id, result.toString());
    }

    static Response rpcResultResponse(Object id, String rawResultJson) {
        Json j = new Json().beginObject().field("jsonrpc", "2.0");
        writeId(j, id);
        j.name("result").raw(rawResultJson).endObject();
        return Response.ok(j.toString(), RestAuth.JSON_MEDIA_TYPE).header("Cache-Control", "no-store").build();
    }

    static Response rpcErrorResponse(Object id, int code, String message) {
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

    static String strArg(Map<String, Object> args, String key) {
        Object v = args.get(key);
        return v instanceof String s ? s : (v == null ? null : String.valueOf(v));
    }

    static String nonBlank(String s, String fallback) {
        return s == null || s.isBlank() ? fallback : s;
    }

    static int intArg(Map<String, Object> args, String key, int fallback) {
        Object v = args.get(key);
        return v instanceof Number n ? n.intValue() : fallback;
    }

    static Integer intObjArg(Map<String, Object> args, String key) {
        Object v = args.get(key);
        return v instanceof Number n ? n.intValue() : null;
    }

    static long longArg(Map<String, Object> args, String key, long fallback) {
        Object v = args.get(key);
        return v instanceof Number n ? n.longValue() : fallback;
    }

    static Long longObjArg(Map<String, Object> args, String key) {
        Object v = args.get(key);
        return v instanceof Number n ? n.longValue() : null;
    }

    static boolean boolArg(Map<String, Object> args, String key, boolean fallback) {
        Object v = args.get(key);
        return v instanceof Boolean b ? b : fallback;
    }

    static Boolean boolObjArg(Map<String, Object> args, String key) {
        Object v = args.get(key);
        return v instanceof Boolean b ? b : null;
    }
}
