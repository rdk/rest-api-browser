package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.decompile.LineSlicer;
import com.atlassian.labs.restbrowser.json.JsonParser;

import java.util.List;
import java.util.Map;

/**
 * Renders concise, token-efficient Markdown representations of decompiled Java sources, class metadata, operation
 * bundles, and DTO JSON Schemas for AI coding agents ({@code format=markdown} or {@code Accept: text/markdown}).
 */
public final class AgentMarkdown {

    private AgentMarkdown() {
    }

    /** Caps long Markdown/tool text output cleanly on a line boundary to keep agent responses within context budgets. */
    public static String truncateToChars(String text, Integer maxChars) {
        if (text == null || maxChars == null || maxChars <= 0) {
            return text;
        }
        int limit = Math.max(200, Math.min(200_000, maxChars));
        if (text.length() <= limit) {
            return text;
        }
        String note = "\n\n… [truncated to " + limit + " chars; pass maxChars=0 or narrow scope/maxLines to inspect further]\n";
        int cutMax = Math.max(80, limit - note.length());
        int nl = text.lastIndexOf('\n', cutMax);
        int cut = nl > cutMax / 2 ? nl : cutMax;
        return text.substring(0, cut) + note;
    }

    public static String renderSourceJson(String sourceJson) {
        Map<String, Object> m = safeObject(sourceJson);
        if (m == null || m.containsKey("error")) {
            return renderErrorJson(sourceJson);
        }
        return renderSource(
                str(m, "class"),
                str(m, "scope"),
                str(m, "method"),
                str(m, "decompiler"),
                numInt(m.get("startLine"), 1),
                numInt(m.get("endLine"), 1),
                numInt(m.get("totalLines"), 1),
                m.get("truncated") == Boolean.TRUE,
                str(m, "source"),
                m.get("lineNumbers") == Boolean.TRUE,
                false);
    }

    public static String renderSource(String className, String scope, String methodName, String decompiler,
                                      int startLine, int endLine, int totalLines, boolean truncated,
                                      String source, boolean alreadyNumbered, boolean lineNumbers) {
        StringBuilder md = new StringBuilder(source.length() + 256);
        md.append("# ").append(nonEmpty(className, "Java Source")).append('\n');
        md.append("- **Scope**: `").append(nonEmpty(scope, "class")).append('`');
        if (methodName != null && !methodName.isBlank()) {
            md.append(" (`").append(methodName).append("`)");
        }
        md.append(" · **Decompiler**: ").append(nonEmpty(decompiler, "Vineflower"));
        md.append(" · **Lines**: ").append(startLine).append('-').append(endLine).append(" / ").append(totalLines);
        if (truncated) {
            md.append(" _(sliced; use `startLine=").append(endLine + 1).append("` to continue)_");
        }
        md.append("\n\n");
        String body = (lineNumbers && !alreadyNumbered)
                ? LineSlicer.formatWithLineNumbers(source, startLine)
                : source;
        appendCodeBlock(md, "java", body);
        return md.toString();
    }

    public static String renderClassJson(String classJson) {
        Map<String, Object> m = safeObject(classJson);
        if (m == null || m.containsKey("error")) {
            return renderErrorJson(classJson);
        }
        StringBuilder md = new StringBuilder(1024);
        String name = str(m, "name");
        md.append("# ").append(nonEmpty(name, "Class")).append("\n\n");
        String kind = str(m, "kind");
        String mods = str(m, "modifiers");
        md.append("- **Declaration**: `").append((mods.isEmpty() ? "" : mods + " ") + nonEmpty(kind, "class")).append(" ")
                .append(str(m, "simpleName")).append("` (`package`: `").append(str(m, "package")).append("`)\n");
        if (m.get("superclass") != null) {
            md.append("- **Extends**: `").append(m.get("superclass")).append("`\n");
        }
        List<String> ifaces = strList(m.get("interfaces"));
        if (!ifaces.isEmpty()) {
            md.append("- **Implements**: ").append(joinCode(ifaces)).append('\n');
        }
        appendProvenance(md, m);
        List<String> enums = strList(m.get("enumConstants"));
        if (!enums.isEmpty()) {
            md.append("\n## Enum Constants\n\n").append(joinCode(enums)).append('\n');
        }
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> fields = m.get("fields") instanceof List<?> l ? (List<Map<String, Object>>) l : List.of();
        if (!fields.isEmpty()) {
            md.append("\n## Fields\n\n| Name | Type | Serialized | Modifiers |\n| --- | --- | --- | --- |\n");
            for (Map<String, Object> f : fields) {
                md.append("| `").append(escPipe(str(f, "name"))).append("` | `")
                        .append(escPipe(nonEmpty(str(f, "shortType"), str(f, "type")))).append("` | `")
                        .append(escPipe(str(f, "serializedName"))).append("` | `")
                        .append(escPipe(str(f, "modifiers"))).append("` |\n");
            }
        }
        List<String> methods = strList(m.get("methods"));
        if (!methods.isEmpty()) {
            md.append("\n## Methods (").append(m.get("methodCount")).append(")\n\n");
            for (String sig : methods) {
                md.append("- `").append(sig).append("`\n");
            }
        }
        appendOutlineTable(md, m.get("outline"));
        appendServiceList(md, m.get("osgiServices"), "OSGi Services");
        appendImplList(md, m.get("implementations"));
        return md.toString();
    }

    public static String renderResourceJson(String resourceJson) {
        Map<String, Object> m = safeObject(resourceJson);
        if (m == null || m.containsKey("error")) {
            return renderErrorJson(resourceJson);
        }
        StringBuilder md = new StringBuilder(1024);
        md.append("# Bundle #").append(m.get("bundleId")).append(' ');
        if (m.containsKey("path")) {
            String path = str(m, "path");
            md.append('`').append(path).append("`\n\n");
            md.append("- **Lines**: ").append(numInt(m.get("startLine"), 1))
                    .append('-').append(numInt(m.get("endLine"), 1))
                    .append(" / ").append(numInt(m.get("totalLines"), 1)).append('\n');
            if (m.get("bundle") != null) {
                md.append("- **Bundle**: `").append(m.get("bundle")).append("`\n");
            }
            if (m.get("plugin") != null) {
                md.append("- **Plugin**: `").append(m.get("plugin")).append("`\n");
            }
            md.append('\n');
            appendCodeBlock(md, langForPath(path), str(m, "content"));
            return md.toString();
        }
        md.append("Resources (").append(m.get("count")).append(")\n\n");
        if (m.get("entries") instanceof List<?> list) {
            for (Object item : list) {
                if (item instanceof Map<?, ?> e) {
                    md.append("- [`").append(e.get("kind")).append("`] `").append(e.get("path")).append("`\n");
                }
            }
        }
        return md.toString();
    }

    @SuppressWarnings("unchecked")
    public static String renderContextJson(String contextJson) {
        Map<String, Object> root = safeObject(contextJson);
        if (root == null || root.containsKey("error")) {
            return renderErrorJson(contextJson);
        }
        StringBuilder md = new StringBuilder(2048);
        md.append("# Investigation Context `").append(str(root, "key")).append("`\n\n");
        if (root.get("catalog") instanceof Map<?, ?> catRaw) {
            Map<String, Object> cat = (Map<String, Object>) catRaw;
            md.append("- **Endpoint**: `").append(str(cat, "method")).append(' ').append(str(cat, "fullPath")).append("`\n");
            if (cat.get("access") != null) md.append("- **Access**: `").append(cat.get("access")).append("`\n");
            if (cat.get("summary") != null) md.append("- **Summary**: ").append(cat.get("summary")).append('\n');
        }
        if (root.get("details") instanceof Map<?, ?> detRaw) {
            appendProvenance(md, (Map<String, Object>) detRaw);
        }
        if (root.get("requestBody") instanceof Map<?, ?> reqRaw) {
            appendSchemaBlock(md, "Request Body (`" + ((Map<?, ?>) reqRaw).get("javaType") + "`)", (Map<String, Object>) reqRaw);
        }
        if (root.get("responseBody") instanceof Map<?, ?> respRaw) {
            appendSchemaBlock(md, "Response Body (`" + ((Map<?, ?>) respRaw).get("javaType") + "`)", (Map<String, Object>) respRaw);
        }
        if (root.get("source") instanceof Map<?, ?> srcRaw) {
            Map<String, Object> src = (Map<String, Object>) srcRaw;
            if (!src.containsKey("error")) {
                md.append("\n## Source (").append(str(src, "decompiler")).append(", lines ")
                        .append(numInt(src.get("startLine"), 1)).append('-').append(numInt(src.get("endLine"), 1))
                        .append(" / ").append(numInt(src.get("totalLines"), 1)).append(")\n\n");
                appendCodeBlock(md, "java", str(src, "source"));
            }
        }
        if (root.get("dependencies") instanceof List<?> deps && !deps.isEmpty()) {
            md.append("\n## Injected Dependencies\n\n");
            for (Object d : deps) {
                if (d instanceof Map<?, ?> dm) {
                    md.append("- `").append(dm.get("type")).append('`');
                    if (dm.get("field") != null) md.append(" (`").append(dm.get("field")).append("`)");
                    List<String> impls = strList(dm.get("implementations"));
                    if (!impls.isEmpty()) md.append(" → ").append(joinCode(impls));
                    md.append('\n');
                }
            }
        }
        return md.toString();
    }

    @SuppressWarnings("unchecked")
    private static void appendOutlineTable(StringBuilder md, Object raw) {
        if (!(raw instanceof List<?> list) || list.isEmpty()) {
            return;
        }
        md.append("\n## Bytecode Outline\n\n| Method | Lines | Signature |\n| --- | --- | --- |\n");
        for (Object item : list) {
            if (item instanceof Map<?, ?> m) {
                int s = numInt(m.get("startLine"), 0);
                int e = numInt(m.get("endLine"), 0);
                String range = s > 0 ? (s + "-" + Math.max(s, e)) : "-";
                md.append("| `").append(escPipe(String.valueOf(m.get("name")))).append("` | ")
                        .append(range).append(" | `").append(escPipe(String.valueOf(m.get("signature")))).append("` |\n");
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static void appendServiceList(StringBuilder md, Object raw, String heading) {
        if (!(raw instanceof List<?> list) || list.isEmpty()) {
            return;
        }
        md.append("\n## ").append(heading).append("\n\n");
        for (Object item : list) {
            if (item instanceof Map<?, ?> m) {
                md.append("- Service #").append(m.get("serviceId")).append(" (bundle #").append(m.get("bundleId")).append(')');
                if (m.get("beanName") != null) md.append(" bean `").append(m.get("beanName")).append('`');
                md.append('\n');
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static void appendImplList(StringBuilder md, Object raw) {
        if (!(raw instanceof List<?> list) || list.isEmpty()) {
            return;
        }
        md.append("\n## Implementations\n\n");
        for (Object item : list) {
            if (item instanceof Map<?, ?> m) {
                md.append("- `").append(m.get("class")).append("` (").append(m.get("via")).append(", bundle #")
                        .append(m.get("bundleId")).append(")\n");
            }
        }
    }

    private static String langForPath(String path) {
        int dot = path.lastIndexOf('.');
        String ext = dot >= 0 ? path.substring(dot + 1).toLowerCase(java.util.Locale.ROOT) : "";
        return switch (ext) {
            case "xml", "svg", "html", "htm" -> "xml";
            case "json" -> "json";
            case "yaml", "yml" -> "yaml";
            case "js", "mjs" -> "javascript";
            case "css" -> "css";
            case "properties" -> "properties";
            case "md" -> "markdown";
            default -> "text";
        };
    }

    public static String renderOperationBundle(String bundleJson) {
        Map<String, Object> root = safeObject(bundleJson);
        if (root == null || root.containsKey("error")) {
            return renderErrorJson(bundleJson);
        }
        StringBuilder md = new StringBuilder(2048);
        md.append("# Operation `").append(str(root, "key")).append("`\n\n");
        if (root.get("details") instanceof Map<?, ?> rawDet) {
            @SuppressWarnings("unchecked")
            Map<String, Object> det = (Map<String, Object>) rawDet;
            if (det.get("method") instanceof Map<?, ?> rawM) {
                @SuppressWarnings("unchecked")
                Map<String, Object> method = (Map<String, Object>) rawM;
                md.append("- **Handler**: `").append(str(method, "class")).append('#').append(str(method, "name")).append("`\n");
                md.append("- **Signature**: `").append(str(method, "signature")).append("`\n");
                List<String> anns = strList(method.get("annotations"));
                if (!anns.isEmpty()) {
                    md.append("- **Annotations**: ").append(joinCode(anns)).append('\n');
                }
            }
            appendProvenance(md, det);
        }
        if (root.get("source") instanceof Map<?, ?> rawSrc) {
            @SuppressWarnings("unchecked")
            Map<String, Object> src = (Map<String, Object>) rawSrc;
            if (src.containsKey("error")) {
                md.append("\n_Source unavailable_: `").append(str(src, "error")).append("`\n");
            } else {
                String code = str(src, "source");
                int start = numInt(src.get("startLine"), 1);
                int end = numInt(src.get("endLine"), 1);
                int total = numInt(src.get("totalLines"), end);
                md.append("\n## Source (").append(str(src, "decompiler")).append(", ")
                        .append(str(src, "scope")).append(" lines ").append(start).append('-').append(end)
                        .append(" / ").append(total).append(")\n\n");
                appendCodeBlock(md, "java", code);
            }
        }
        return md.toString();
    }

    public static String renderSchemaJson(String schemaResponseJson) {
        Map<String, Object> root = safeObject(schemaResponseJson);
        if (root == null || root.containsKey("error")) {
            return renderErrorJson(schemaResponseJson);
        }
        StringBuilder md = new StringBuilder(1024);
        if (root.containsKey("class")) {
            md.append("# Schema `").append(str(root, "class")).append("`\n\n");
            appendSchemaBlock(md, null, root);
        } else {
            md.append("# Operation Schemas `").append(str(root, "key")).append("`\n\n");
            if (root.get("requestBody") instanceof Map<?, ?> req) {
                @SuppressWarnings("unchecked")
                Map<String, Object> reqMap = (Map<String, Object>) req;
                appendSchemaBlock(md, "Request Body (`" + str(reqMap, "javaType") + "`)", reqMap);
            }
            if (root.get("responseBody") instanceof Map<?, ?> resp) {
                @SuppressWarnings("unchecked")
                Map<String, Object> respMap = (Map<String, Object>) resp;
                appendSchemaBlock(md, "Response Body (`" + str(respMap, "javaType") + "`)", respMap);
            }
        }
        return md.toString();
    }

    public static String renderErrorJson(String json) {
        Map<String, Object> m = safeObject(json);
        if (m == null) {
            return json == null ? "" : json;
        }
        StringBuilder md = new StringBuilder("**Error**: `").append(str(m, "error")).append("`");
        if (m.get("hint") != null) {
            md.append("\n\n**Hint**: ").append(m.get("hint"));
        }
        List<String> sug = strList(m.get("suggestions"));
        if (!sug.isEmpty()) {
            md.append("\n\n**Suggestions**:\n");
            for (String s : sug) {
                md.append("- `").append(s).append("`\n");
            }
        }
        return md.toString();
    }

    public static void appendCodeBlock(StringBuilder md, String lang, String code) {
        String body = code == null ? "" : code;
        String fence = "```";
        while (body.contains(fence)) {
            fence += "`";
        }
        md.append(fence).append(lang == null ? "" : lang).append('\n')
                .append(body);
        if (!body.endsWith("\n")) {
            md.append('\n');
        }
        md.append(fence).append('\n');
    }

    private static void appendSchemaBlock(StringBuilder md, String heading, Map<String, Object> entry) {
        if (heading != null) {
            md.append("## ").append(heading).append("\n\n");
        }
        if (entry.containsKey("error")) {
            md.append("_Unavailable_: `").append(str(entry, "error")).append("`\n\n");
            return;
        }
        if (entry.containsKey("schema")) {
            md.append("### JSON Schema\n\n");
            appendCodeBlock(md, "json", toSimpleJson(entry.get("schema")));
        }
        if (entry.containsKey("example")) {
            md.append("\n### Example\n\n");
            appendCodeBlock(md, "json", toSimpleJson(entry.get("example")));
        }
    }

    private static void appendProvenance(StringBuilder md, Map<String, Object> m) {
        if (m.get("bundle") instanceof Map<?, ?> b) {
            md.append("- **Bundle**: #").append(b.get("id")).append(" `")
                    .append(b.get("symbolicName")).append("` ").append(b.get("version"))
                    .append(" (").append(b.get("state")).append(")\n");
        }
        if (m.get("plugin") instanceof Map<?, ?> p) {
            md.append("- **Plugin**: `").append(p.get("key")).append("` (")
                    .append(p.get("name")).append(", ").append(p.get("origin")).append(")\n");
        }
    }

    private static String toSimpleJson(Object value) {
        com.atlassian.labs.restbrowser.json.Json j = new com.atlassian.labs.restbrowser.json.Json();
        writeAny(j, value);
        return j.toString();
    }

    @SuppressWarnings("unchecked")
    private static void writeAny(com.atlassian.labs.restbrowser.json.Json j, Object v) {
        if (v == null) {
            j.value((String) null);
        } else if (v instanceof Boolean b) {
            j.value(b);
        } else if (v instanceof Long l) {
            j.value(l);
        } else if (v instanceof Integer i) {
            j.value(i.longValue());
        } else if (v instanceof Number n) {
            j.raw(n.toString());
        } else if (v instanceof String s) {
            j.value(s);
        } else if (v instanceof List<?> list) {
            j.beginArray();
            for (Object item : list) {
                writeAny(j, item);
            }
            j.endArray();
        } else if (v instanceof Map<?, ?> map) {
            j.beginObject();
            for (Map.Entry<String, Object> e : ((Map<String, Object>) map).entrySet()) {
                j.name(e.getKey());
                writeAny(j, e.getValue());
            }
            j.endObject();
        } else {
            j.value(String.valueOf(v));
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> safeObject(String json) {
        try {
            return json == null || json.isBlank() ? null : JsonParser.parseObject(json);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String str(Map<String, Object> m, String key) {
        Object v = m.get(key);
        return v == null ? "" : String.valueOf(v);
    }

    private static List<String> strList(Object raw) {
        if (!(raw instanceof List<?> list)) {
            return List.of();
        }
        return list.stream().map(String::valueOf).toList();
    }

    private static int numInt(Object raw, int fallback) {
        return raw instanceof Number n ? n.intValue() : fallback;
    }

    private static String joinCode(List<String> items) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < items.size(); i++) {
            if (i > 0) sb.append(", ");
            sb.append('`').append(items.get(i)).append('`');
        }
        return sb.toString();
    }

    private static String nonEmpty(String s, String fallback) {
        return s == null || s.isBlank() ? fallback : s;
    }

    private static String escPipe(String s) {
        return s.replace("|", "\\|");
    }
}
