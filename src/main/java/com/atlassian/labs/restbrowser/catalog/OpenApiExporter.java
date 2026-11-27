package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.OperationSpec;
import com.atlassian.labs.restbrowser.catalog.Model.Param;
import com.atlassian.labs.restbrowser.catalog.OperationSource.OperationSchemas;
import com.atlassian.labs.restbrowser.json.Json;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Generates OpenAPI 3.1.0 specifications both for REST API Browser's own agent/UI endpoints ({@code /openapi} /
 * {@code /openapi.json})
 * and on-demand for any indexed REST module ({@code /catalog/openapi?module=...}). Pure JDK + internal DTO schema
 * synthesizer (zero OpenAPI/Jackson/Swagger dependencies).
 */
public final class OpenApiExporter {

    private static final int MAX_MODULE_SCHEMA_OPS = 60;

    private OpenApiExporter() {
    }

    /** Generates an OpenAPI 3.1.0 document describing REST API Browser's own API (role-filtered). */
    public static String selfSpecJson(String baseUrl, String pluginVersion, boolean includeSysadmin) {
        String root = stripTrailingSlash(baseUrl);
        String ver = (pluginVersion == null || pluginVersion.isBlank()) ? "4.4.0" : pluginVersion;

        Json j = new Json().beginObject()
                .field("openapi", "3.1.0")
                .name("info").beginObject()
                .field("title", "REST API Browser API")
                .field("version", ver)
                .field("description", "REST catalog discovery, OpenAPI export, URL resolution, Java bytecode/OSGi inspection, decompilation, and read-only MCP endpoints.")
                .endObject()
                .name("servers").beginArray()
                .beginObject().field("url", root + "/rest/restbrowser/1").field("description", "REST API Browser base path").endObject()
                .endArray()
                .name("components").beginObject()
                .name("securitySchemes").beginObject()
                .name("bearerAuth").beginObject().field("type", "http").field("scheme", "bearer").endObject()
                .name("basicAuth").beginObject().field("type", "http").field("scheme", "basic").endObject()
                .endObject()
                .endObject()
                .name("security").beginArray()
                .beginObject().name("bearerAuth").beginArray().endArray().endObject()
                .beginObject().name("basicAuth").beginArray().endArray().endObject()
                .endArray();

        Map<String, List<SelfOp>> paths = new LinkedHashMap<>();
        addSelf(paths, "/catalog", "get", "getCatalogSummary", "Catalog summary, hash, and module states (supports ?format=brief&top=12)", List.of("catalog"),
                List.of("format", "top"), false);
        addSelf(paths, "/catalog/brief", "get", "getCatalogBrief", "Compact plain-text triage brief (~200 tokens) of product, node, and top/problem modules", List.of("catalog"),
                List.of("top"), false);
        addSelf(paths, "/catalog/operations", "get", "searchOperations", "Scored server-side search over indexed REST operations", List.of("catalog"),
                List.of("q", "method", "path", "module", "plugin", "access", "deprecated", "usesClass", "limit", "offset", "fields", "format"), false);
        addSelf(paths, "/catalog/resolve", "get", "resolveUrl", "Match a live URL against JAX-RS URI templates", List.of("catalog"),
                List.of("url", "method", "limit", "format"), false);
        addSelf(paths, "/catalog/index/current", "get", "getCurrentIndex", "Current catalog snapshot operation index", List.of("catalog"), List.of(), false);
        addSelf(paths, "/catalog/index/{hash}", "get", "getIndexByHash", "Immutable catalog snapshot index for a specific hash", List.of("catalog"), List.of(), false);
        addSelf(paths, "/catalog/started", "post", "markModuleStarted", "Index a lazy module that finished starting", List.of("catalog"), List.of("module"), true);
        addSelf(paths, "/catalog/openapi", "get", "exportModuleOpenApi", "Export OpenAPI 3.1.0 spec for one REST module", List.of("catalog"),
                List.of("module", "includeSchemas", "schemaDepth"), false);
        addSelf(paths, "/openapi", "get", "getSelfOpenApi",
                "OpenAPI 3.1.0 specification of REST API Browser itself (also reachable at /openapi.json)",
                List.of("meta"), List.of(), false);
        addSelf(paths, "/mcp", "post", "mcpRpc", "Read-only JSON-RPC 2.0 Model Context Protocol endpoint", List.of("mcp"), List.of(), false);
        addSelf(paths, "/echo", "get", "echoHeaders", "Echo request headers with credentials redacted", List.of("utility"), List.of(), false);

        if (includeSysadmin) {
            addSelf(paths, "/catalog/refresh", "post", "refreshCatalog", "Rebuild full catalog or a single module", List.of("catalog", "sysadmin"), List.of("module"), true);
            addSelf(paths, "/code/operation", "get", "inspectOperationBundle", "Operation reflection details, OSGi provenance, and decompiled source", List.of("code", "sysadmin"),
                    List.of("op", "scope", "decompiler", "view", "startLine", "maxLines", "lineNumbers", "format"), false);
            addSelf(paths, "/code/class", "get", "inspectClass", "Class metadata, fields, enum constants, bytecode outlines, and OSGi provenance", List.of("code", "sysadmin"),
                    List.of("class", "op", "fromBundle", "view", "outline", "includeImplementations", "format"), false);
            addSelf(paths, "/code/plugin", "get", "inspectPlugin", "Plugin dependencies, modules, and owning OSGi bundle", List.of("code", "sysadmin"),
                    List.of("key", "view"), false);
            addSelf(paths, "/code/source", "get", "decompileSource", "On-demand bytecode decompilation via Vineflower or CFR", List.of("code", "sysadmin"),
                    List.of("class", "op", "method", "scope", "decompiler", "fromBundle", "startLine", "maxLines", "includeMeta", "lineNumbers", "format"), false);
            addSelf(paths, "/code/schema", "get", "inspectSchema", "Generate Draft 2020-12 JSON Schema and example payload for a DTO or operation", List.of("code", "sysadmin"),
                    List.of("class", "op", "fromBundle", "depth", "includeExample", "format"), false);
            addSelf(paths, "/code/implementations", "get", "findImplementations", "Find live OSGi service providers and concrete bytecode subtypes", List.of("code", "sysadmin"),
                    List.of("class", "op", "fromBundle", "bundleId", "plugin", "includeAbstract", "limit"), false);
            addSelf(paths, "/code/callers", "get", "findCallers", "Find classes whose constant pool invokes methods on target class", List.of("code", "sysadmin"),
                    List.of("class", "method", "op", "fromBundle", "bundleId", "plugin", "packagePrefix", "limit"), false);
            addSelf(paths, "/code/grep", "get", "grepBytecode", "Grep string and UTF-8 constants across active OSGi bundles", List.of("code", "sysadmin"),
                    List.of("q", "bundleId", "plugin", "packagePrefix", "caseSensitive", "includeUtf8", "limit"), false);
            addSelf(paths, "/code/graph", "get", "traverseGraph", "Typed BFS traversal of class references across OSGi bundle wires", List.of("code", "sysadmin"),
                    List.of("class", "op", "fromBundle", "depth", "maxNodes", "includeJdk", "excludeLibraries", "preset", "edgeKinds", "packagePrefix", "includeSources", "decompiler"), false);
            addSelf(paths, "/code/search", "get", "searchClasses", "Search Java class names across active OSGi bundles", List.of("code", "sysadmin"),
                    List.of("q", "limit", "bundleId"), false);
            addSelf(paths, "/code/resource", "get", "inspectBundleResource", "List or read non-binary text resources inside an OSGi bundle", List.of("code", "sysadmin"),
                    List.of("bundleId", "plugin", "path", "prefix", "startLine", "maxLines", "lineNumbers", "limit", "format"), false);
            addSelf(paths, "/code/batch", "post", "batchCode", "Batch inspect, decompile, or generate schemas for up to 10 items", List.of("code", "sysadmin"), List.of(), true);
            addSelf(paths, "/code/context", "post", "investigationContext",
                    "One-shot investigation bundle: metadata, schemas, handler source, and dependency impls",
                    List.of("code", "sysadmin"), List.of("format", "maxChars"), true);
        }

        j.name("paths").beginObject();
        for (Map.Entry<String, List<SelfOp>> entry : paths.entrySet()) {
            j.name(entry.getKey()).beginObject();
            for (SelfOp op : entry.getValue()) {
                j.name(op.method).beginObject()
                        .field("operationId", op.id)
                        .field("summary", op.summary)
                        .strings("tags", op.tags);
                List<String> pathVars = extractPathVars(entry.getKey());
                if (!pathVars.isEmpty() || !op.queryParams.isEmpty() || op.requiresXsrf) {
                    j.name("parameters").beginArray();
                    for (String pv : pathVars) {
                        j.beginObject().field("name", pv).field("in", "path").field("required", true)
                                .name("schema").beginObject().field("type", "string").endObject().endObject();
                    }
                    for (String qp : op.queryParams) {
                        j.beginObject().field("name", qp).field("in", "query").field("required", false)
                                .name("schema").beginObject().field("type", guessSelfParamType(qp)).endObject().endObject();
                    }
                    if (op.requiresXsrf) {
                        j.beginObject().field("name", "X-Atlassian-Token").field("in", "header").field("required", true)
                                .name("schema").beginObject().field("type", "string").field("default", "no-check").endObject().endObject();
                    }
                    j.endArray();
                }
                if ("post".equals(op.method) && !"/catalog/started".equals(entry.getKey()) && !"/catalog/refresh".equals(entry.getKey())) {
                    j.name("requestBody").beginObject().field("required", true)
                            .name("content").beginObject()
                            .name("application/json").beginObject()
                            .name("schema").beginObject().field("type", "object").endObject()
                            .endObject().endObject().endObject();
                }
                j.name("responses").beginObject()
                        .name("200").beginObject().field("description", "Success").endObject()
                        .endObject()
                        .endObject();
            }
            j.endObject();
        }
        return j.endObject().endObject().toString();
    }

    /** Generates an OpenAPI 3.1.0 document for a single catalog REST module, or returns {@code null} if unknown. */
    public static String moduleSpecJson(CatalogSnapshot snapshot, String moduleId, String baseUrl,
                                        boolean includeSchemas, int schemaDepth, OperationSource source) {
        if (snapshot == null || moduleId == null || moduleId.isBlank()) {
            return null;
        }
        ModuleEntry mod = snapshot.module(moduleId).orElse(null);
        if (mod == null) {
            return null;
        }
        List<Operation> ops = new ArrayList<>();
        for (Operation op : snapshot.operations()) {
            if (moduleId.equals(op.moduleId())) {
                ops.add(op);
            }
        }
        Map<String, OperationSchemas> schemas = (includeSchemas && source != null && mod.opCount() > 0)
                ? source.moduleOperationSchemas(moduleId, schemaDepth, MAX_MODULE_SCHEMA_OPS)
                : Map.of();

        String root = stripTrailingSlash(baseUrl);
        Json j = new Json().beginObject()
                .field("openapi", "3.1.0")
                .name("info").beginObject()
                .field("title", nonEmpty(mod.pluginName(), mod.id()) + " (" + mod.path() + ")")
                .field("version", nonEmpty(mod.pluginVersion(), "1.0"))
                .endObject()
                .field("x-catalog-hash", snapshot.hash())
                .field("x-module", mod.id())
                .field("x-plugin", mod.pluginKey())
                .name("servers").beginArray()
                .beginObject().field("url", root + "/rest").endObject()
                .endArray();

        Map<String, List<Operation>> byPath = new LinkedHashMap<>();
        for (Operation op : ops) {
            String full = "/" + CatalogQuery.fullPath(mod, op.spec());
            byPath.computeIfAbsent(full, k -> new ArrayList<>()).add(op);
        }

        j.name("paths").beginObject();
        for (Map.Entry<String, List<Operation>> entry : byPath.entrySet()) {
            j.name(entry.getKey()).beginObject();
            Map<String, Operation> byMethod = new LinkedHashMap<>();
            for (Operation op : entry.getValue()) {
                String httpMethod = op.spec().method().toLowerCase(Locale.ROOT);
                byMethod.putIfAbsent(httpMethod, op);
            }
            for (Map.Entry<String, Operation> me : byMethod.entrySet()) {
                writeModuleOperation(j, me.getKey(), me.getValue(), schemas.get(me.getValue().key()));
            }
            j.endObject();
        }
        return j.endObject().endObject().toString();
    }

    private static void writeModuleOperation(Json j, String httpMethod, Operation op, OperationSchemas schemas) {
        OperationSpec spec = op.spec();
        j.name(httpMethod).beginObject()
                .field("operationId", sanitizeOperationId(op.key()))
                .optional("summary", spec.summary())
                .optional("description", spec.description());
        if (spec.deprecated()) {
            j.field("deprecated", true);
        }
        j.field("x-operation-key", op.key())
                .optional("x-access", spec.access())
                .optional("x-body-java-type", spec.bodyJavaType())
                .optional("x-return-java-type", spec.returnJavaType());

        List<Param> nonBodyParams = new ArrayList<>();
        List<Param> formParams = new ArrayList<>();
        for (Param p : spec.params()) {
            if ("form".equalsIgnoreCase(p.in())) {
                formParams.add(p);
            } else {
                nonBodyParams.add(p);
            }
        }
        if (!nonBodyParams.isEmpty()) {
            j.name("parameters").beginArray();
            for (Param p : nonBodyParams) {
                String in = normalizeParamIn(p.in());
                j.beginObject()
                        .field("name", p.name())
                        .field("in", in)
                        .field("required", "path".equals(in) || p.required())
                        .optional("description", p.description());
                if (!in.equals(p.in())) {
                    j.field("x-jaxrs-in", p.in());
                }
                j.name("schema");
                writeParamSchema(j, p);
                j.endObject();
            }
            j.endArray();
        }

        if (!formParams.isEmpty() || spec.bodyType() != null || spec.bodyJavaType() != null) {
            j.name("requestBody").beginObject().field("required", true).name("content").beginObject();
            if (!formParams.isEmpty()) {
                String ct = spec.consumes().isEmpty() ? "application/x-www-form-urlencoded" : spec.consumes().get(0);
                j.name(ct).beginObject().name("schema").beginObject()
                        .field("type", "object").name("properties").beginObject();
                List<String> req = new ArrayList<>();
                for (Param fp : formParams) {
                    j.name(fp.name());
                    writeParamSchema(j, fp);
                    if (fp.required()) {
                        req.add(fp.name());
                    }
                }
                j.endObject();
                if (!req.isEmpty()) {
                    j.strings("required", req);
                }
                j.endObject().endObject();
            } else {
                String ct = spec.consumes().isEmpty() ? "application/json" : spec.consumes().get(0);
                j.name(ct).beginObject().name("schema");
                if (schemas != null && schemas.requestSchemaJson() != null) {
                    j.raw(schemas.requestSchemaJson());
                    if (schemas.requestExampleJson() != null) {
                        j.name("example").raw(schemas.requestExampleJson());
                    }
                } else {
                    j.beginObject().field("type", "object")
                            .optional("x-javaType", spec.bodyJavaType() != null ? spec.bodyJavaType() : spec.bodyType())
                            .endObject();
                }
                j.endObject();
            }
            j.endObject().endObject();
        }

        j.name("responses").beginObject().name("200").beginObject().field("description", "OK");
        if ((schemas != null && schemas.responseSchemaJson() != null)
                || spec.returnType() != null || spec.returnJavaType() != null || !spec.produces().isEmpty()) {
            String ct = spec.produces().isEmpty() ? "application/json" : spec.produces().get(0);
            j.name("content").beginObject().name(ct).beginObject().name("schema");
            if (schemas != null && schemas.responseSchemaJson() != null) {
                j.raw(schemas.responseSchemaJson());
                if (schemas.responseExampleJson() != null) {
                    j.name("example").raw(schemas.responseExampleJson());
                }
            } else {
                j.beginObject().field("type", mapOpenApiType(spec.returnType()))
                        .optional("x-javaType", spec.returnJavaType() != null ? spec.returnJavaType() : spec.returnType())
                        .endObject();
            }
            j.endObject().endObject();
        }
        j.endObject().endObject().endObject();
    }

    private static void writeParamSchema(Json j, Param p) {
        String oaType = mapOpenApiType(p.type());
        j.beginObject();
        if (p.repeating()) {
            j.field("type", "array").name("items").beginObject().field("type", oaType);
            if (p.options() != null && !p.options().isEmpty()) {
                j.strings("enum", p.options());
            }
            j.endObject();
        } else {
            j.field("type", oaType);
            if (p.options() != null && !p.options().isEmpty()) {
                j.strings("enum", p.options());
            }
        }
        if (p.defaultValue() != null) {
            j.field("default", p.defaultValue());
        }
        j.optional("x-javaType", p.javaType()).endObject();
    }

    private static String normalizeParamIn(String in) {
        if ("path".equalsIgnoreCase(in) || "header".equalsIgnoreCase(in) || "cookie".equalsIgnoreCase(in)) {
            return in.toLowerCase(Locale.ROOT);
        }
        return "query";
    }

    private static String mapOpenApiType(String raw) {
        if (raw == null || raw.isBlank()) {
            return "string";
        }
        String low = raw.toLowerCase(Locale.ROOT);
        if (low.contains("bool")) return "boolean";
        if (low.contains("int") || low.contains("long") || low.contains("short")) return "integer";
        if (low.contains("float") || low.contains("double") || low.contains("decimal") || low.contains("number")) return "number";
        if (low.contains("list") || low.contains("set") || low.contains("collection") || low.endsWith("[]")) return "array";
        return "string";
    }

    private static String sanitizeOperationId(String key) {
        String clean = key.replaceAll("[^A-Za-z0-9_]", "_");
        return clean.isEmpty() ? "op" : clean;
    }

    private static String guessSelfParamType(String name) {
        if ("limit".equals(name) || "offset".equals(name) || "fromBundle".equals(name) || "bundleId".equals(name)
                || "depth".equals(name) || "maxNodes".equals(name) || "startLine".equals(name)
                || "maxLines".equals(name) || "schemaDepth".equals(name)) {
            return "integer";
        }
        if ("deprecated".equals(name) || "includeMeta".equals(name) || "includeJdk".equals(name)
                || "excludeLibraries".equals(name) || "includeSources".equals(name) || "includeExample".equals(name)
                || "includeAbstract".equals(name) || "includeSchemas".equals(name) || "caseSensitive".equals(name)
                || "includeUtf8".equals(name) || "lineNumbers".equals(name) || "outline".equals(name)
                || "includeImplementations".equals(name)) {
            return "boolean";
        }
        return "string";
    }

    private static List<String> extractPathVars(String path) {
        List<String> vars = new ArrayList<>();
        int idx = 0;
        while ((idx = path.indexOf('{', idx)) >= 0) {
            int close = path.indexOf('}', idx + 1);
            if (close < 0) break;
            vars.add(path.substring(idx + 1, close));
            idx = close + 1;
        }
        return vars;
    }

    private record SelfOp(String method, String id, String summary, List<String> tags,
                          List<String> queryParams, boolean requiresXsrf) {
    }

    private static void addSelf(Map<String, List<SelfOp>> paths, String path, String method, String id,
                                String summary, List<String> tags, List<String> queryParams, boolean requiresXsrf) {
        paths.computeIfAbsent(path, k -> new ArrayList<>())
                .add(new SelfOp(method, id, summary, tags, queryParams, requiresXsrf));
    }

    private static String stripTrailingSlash(String s) {
        if (s == null || s.isBlank()) return "";
        String t = s.trim();
        return t.endsWith("/") ? t.substring(0, t.length() - 1) : t;
    }

    private static String nonEmpty(String s, String fallback) {
        return s == null || s.isBlank() ? fallback : s;
    }
}
