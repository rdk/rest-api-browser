package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.OperationSpec;
import com.atlassian.labs.restbrowser.catalog.Model.Param;
import com.atlassian.labs.restbrowser.json.Json;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * Stateless server-side search, filtering, and JAX-RS URL template matching over an immutable {@link CatalogSnapshot}.
 * Avoids forcing AI agents to download and parse the full multi-megabyte catalog index for targeted discovery.
 */
public final class CatalogQuery {

    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_LIMIT = 200;
    private static final int MAX_RESOLVE_LIMIT = 25;
    private static final int MAX_PATH_REGEX_LEN = 80;
    private static final Pattern NESTED_QUANTIFIERS = Pattern.compile("\\([^)]*[+*][^)]*\\)[+*]");

    public record OperationFilter(String query, String methods, String path, String module, String plugin,
                                  String access, Boolean deprecated, String usesClass,
                                  int limit, int offset, boolean fullFields) {
    }

    private record ScoredOp(Operation op, ModuleEntry module, String fullPath, int score) {
    }

    private record ResolvedMatch(Operation op, ModuleEntry module, String fullPath,
                                 Map<String, String> pathParams, int score) {
    }

    public record TopResolution(Operation operation, ModuleEntry module, String fullPath,
                                Map<String, String> pathParams, Map<String, List<String>> queryParams) {
    }

    private CatalogQuery() {
    }

    public static String searchJson(CatalogSnapshot snapshot, OperationFilter filter) {
        SearchOutcome outcome = evaluateSearch(snapshot, filter);
        Json j = new Json().beginObject()
                .field("format", 1)
                .field("hash", snapshot.hash())
                .field("complete", snapshot.complete())
                .field("totalMatches", outcome.totalMatches)
                .field("limit", outcome.limit)
                .field("offset", outcome.offset)
                .field("truncated", outcome.offset + outcome.page.size() < outcome.totalMatches)
                .name("operations").beginArray();
        for (ScoredOp item : outcome.page) {
            writeSearchItem(j, item, filter.fullFields());
        }
        return j.endArray().endObject().toString();
    }

    public static String searchMarkdown(CatalogSnapshot snapshot, OperationFilter filter) {
        SearchOutcome outcome = evaluateSearch(snapshot, filter);
        StringBuilder md = new StringBuilder(1024);
        md.append("# Catalog Operations (")
                .append(outcome.totalMatches).append(" matches; showing ")
                .append(outcome.page.isEmpty() ? 0 : outcome.offset + 1)
                .append('-').append(outcome.offset + outcome.page.size())
                .append(", hash `").append(snapshot.hash()).append("`)\n\n");
        if (outcome.page.isEmpty()) {
            md.append("_No operations matched._\n");
            return md.toString();
        }
        for (ScoredOp item : outcome.page) {
            Operation op = item.op();
            OperationSpec spec = op.spec();
            md.append("- **`").append(spec.method()).append(' ').append(item.fullPath()).append("`** · `")
                    .append(op.key()).append('`');
            if (item.module() != null && item.module().pluginKey() != null) {
                md.append(" · plugin `").append(item.module().pluginKey()).append('`');
            }
            if (spec.access() != null) {
                md.append(" · ").append(spec.access());
            }
            if (spec.deprecated()) {
                md.append(" · _deprecated_");
            }
            md.append('\n');
            if (spec.summary() != null && !spec.summary().isBlank()) {
                md.append("  ").append(spec.summary()).append('\n');
            }
            if (!spec.params().isEmpty()) {
                md.append("  Params: ");
                for (int i = 0; i < spec.params().size(); i++) {
                    if (i > 0) md.append(", ");
                    Param p = spec.params().get(i);
                    md.append('`').append(p.name()).append("` (").append(p.in()).append(", ").append(p.type())
                            .append(p.required() ? ", required)" : ")");
                }
                md.append('\n');
            }
            if (spec.bodyType() != null || spec.returnType() != null) {
                md.append("  Types:");
                if (spec.bodyType() != null) {
                    md.append(" in=`").append(spec.bodyJavaType() != null ? spec.bodyJavaType() : spec.bodyType()).append('`');
                }
                if (spec.returnType() != null) {
                    md.append(" out=`").append(spec.returnJavaType() != null ? spec.returnJavaType() : spec.returnType()).append('`');
                }
                md.append('\n');
            }
        }
        return md.toString();
    }

    /** Renders a compact ~150-250 token plain-text triage brief of catalog state, top modules, and failures. */
    public static String briefText(CatalogSnapshot snapshot, String productName, String productVersion,
                                   String nodeId, boolean sysadmin, boolean liveScalpel, int topModules) {
        int limit = topModules <= 0 ? 12 : Math.min(topModules, 50);
        int ok = 0;
        int waiting = 0;
        int failed = 0;
        List<ModuleEntry> okMods = new ArrayList<>();
        List<ModuleEntry> problemMods = new ArrayList<>();
        for (ModuleEntry m : snapshot.modules()) {
            if (m.state() == Model.State.ok) {
                ok++;
                if (m.opCount() > 0) {
                    okMods.add(m);
                }
            } else if (m.state() == Model.State.pending || "not-started".equals(m.reason()) || "not-startable".equals(m.reason())) {
                waiting++;
                problemMods.add(m);
            } else {
                failed++;
                problemMods.add(m);
            }
        }
        okMods.sort(Comparator.comparingInt(ModuleEntry::opCount).reversed().thenComparing(ModuleEntry::path));

        String prod = ((productName == null ? "" : productName.trim()) + " "
                + (productVersion == null ? "" : productVersion.trim())).trim();
        StringBuilder sb = new StringBuilder(512);
        sb.append("RAB ").append(prod.isEmpty() ? "Atlassian" : prod);
        if (nodeId != null && !nodeId.isBlank()) {
            sb.append(" | node:").append(nodeId.trim());
        }
        sb.append(" | hash:").append(snapshot.hash())
                .append(" | ").append(snapshot.complete() ? "complete" : (snapshot.done() + "/" + snapshot.total()))
                .append(" | ").append(snapshot.operations().size()).append(" ops / ")
                .append(snapshot.modules().size()).append(" modules (ok:").append(ok)
                .append(" wait:").append(waiting).append(" fail:").append(failed).append(")\n");

        sb.append("role: ").append(sysadmin ? "sysadmin" : "licensed");
        if (sysadmin && liveScalpel) {
            sb.append(" | companions: live-scalpel");
        }
        sb.append('\n');

        int shownOk = Math.min(limit, okMods.size());
        if (shownOk > 0) {
            sb.append("top modules (").append(shownOk).append('/').append(okMods.size()).append("):\n");
            for (int i = 0; i < shownOk; i++) {
                ModuleEntry m = okMods.get(i);
                sb.append("- ").append(m.path()).append(" (").append(m.opCount()).append(" ops, ")
                        .append(m.stability()).append(", ").append(m.pluginKey()).append(")\n");
            }
        }

        if (!problemMods.isEmpty()) {
            int shownProb = Math.min(10, problemMods.size());
            sb.append("waiting/failed (").append(problemMods.size()).append("):\n");
            for (int i = 0; i < shownProb; i++) {
                ModuleEntry m = problemMods.get(i);
                String reason = m.reason() != null && !m.reason().isBlank() ? m.reason() : m.state().name();
                sb.append("- ").append(m.path()).append(" [").append(m.state().name()).append(": ").append(reason)
                        .append("] (").append(m.id()).append(")\n");
            }
        }

        sb.append("next: GET /catalog/operations?q=...&format=markdown | GET /catalog/resolve?url=/rest/...");
        if (sysadmin) {
            sb.append(" | POST /code/context");
        }
        sb.append('\n');
        return sb.toString();
    }

    public static String resolveUrlJson(CatalogSnapshot snapshot, String rawMethod, String rawUrl, int rawLimit) {
        UrlResolution res = evaluateResolve(snapshot, rawMethod, rawUrl, rawLimit);
        Json j = new Json().beginObject()
                .field("format", 1)
                .field("hash", snapshot.hash())
                .field("complete", snapshot.complete())
                .name("input").beginObject()
                .optional("method", res.method)
                .field("url", rawUrl == null ? "" : rawUrl)
                .field("normalizedPath", res.normalizedPath)
                .name("queryParams").beginObject();
        for (Map.Entry<String, List<String>> e : res.queryParams.entrySet()) {
            j.strings(e.getKey(), e.getValue());
        }
        j.endObject().endObject()
                .field("matchCount", res.matches.size())
                .name("matches").beginArray();
        for (ResolvedMatch m : res.matches) {
            j.beginObject()
                    .field("key", m.op().key())
                    .field("module", m.op().moduleId())
                    .optional("pluginKey", m.module() == null ? null : m.module().pluginKey())
                    .field("method", m.op().spec().method())
                    .field("fullPath", m.fullPath())
                    .field("score", m.score())
                    .stringMap("pathParams", m.pathParams())
                    .name("operation").raw(CatalogSnapshot.serializeOperation(m.op()))
                    .endObject();
        }
        return j.endArray().endObject().toString();
    }

    public static String resolveUrlMarkdown(CatalogSnapshot snapshot, String rawMethod, String rawUrl, int rawLimit) {
        UrlResolution res = evaluateResolve(snapshot, rawMethod, rawUrl, rawLimit);
        StringBuilder md = new StringBuilder(512);
        md.append("# URL Resolution (`").append(res.method == null ? "*" : res.method).append(' ')
                .append(res.normalizedPath).append("`)\n\n");
        if (!res.queryParams.isEmpty()) {
            md.append("- **Query**: ").append(res.queryParams).append('\n');
        }
        md.append("- **Matches**: ").append(res.matches.size()).append("\n\n");
        for (ResolvedMatch m : res.matches) {
            md.append("- **`").append(m.op().spec().method()).append(' ').append(m.fullPath()).append("`** → `")
                    .append(m.op().key()).append('`');
            if (!m.pathParams().isEmpty()) {
                md.append(" · pathParams=").append(m.pathParams());
            }
            md.append('\n');
        }
        return md.toString();
    }

    /** Returns the highest-scoring resolved operation for a URL, or {@code null} if nothing matches. */
    public static TopResolution resolveTopOperation(CatalogSnapshot snapshot, String rawMethod, String rawUrl) {
        if (snapshot == null || rawUrl == null || rawUrl.isBlank()) {
            return null;
        }
        UrlResolution res = evaluateResolve(snapshot, rawMethod, rawUrl, 1);
        if (res.matches.isEmpty()) {
            return null;
        }
        ResolvedMatch top = res.matches.get(0);
        return new TopResolution(top.op(), top.module(), top.fullPath(), top.pathParams(), res.queryParams);
    }

    // ---- search internals

    private record SearchOutcome(int totalMatches, int limit, int offset, List<ScoredOp> page) {
    }

    private static SearchOutcome evaluateSearch(CatalogSnapshot snapshot, OperationFilter f) {
        Set<String> methodSet = parseUpperCsv(f.methods());
        String pathNeedle = stripRestPrefix(f.path()).toLowerCase(Locale.ROOT);
        String modFilter = trimOrNull(f.module());
        String pluginFilter = trimOrNull(f.plugin());
        Set<String> accessFilters = parseLowerCsv(f.access());
        String usesClass = trimOrNull(f.usesClass());
        String[] tokens = parseTokens(f.query());

        List<ScoredOp> hits = new ArrayList<>();
        for (Operation op : snapshot.operations()) {
            ModuleEntry mod = snapshot.module(op.moduleId()).orElse(null);
            OperationSpec spec = op.spec();
            if (!methodSet.isEmpty() && !methodSet.contains(spec.method().toUpperCase(Locale.ROOT))) {
                continue;
            }
            if (f.deprecated() != null && spec.deprecated() != f.deprecated()) {
                continue;
            }
            if (modFilter != null && !matchesModule(modFilter, op.moduleId(), mod)) {
                continue;
            }
            if (pluginFilter != null && (mod == null || mod.pluginKey() == null
                    || !mod.pluginKey().equalsIgnoreCase(pluginFilter))) {
                continue;
            }
            if (!accessFilters.isEmpty() && !matchesAccess(accessFilters, spec, mod)) {
                continue;
            }
            String fullPath = fullPath(mod, spec);
            if (!pathNeedle.isEmpty() && !fullPath.toLowerCase(Locale.ROOT).contains(pathNeedle)) {
                continue;
            }
            if (usesClass != null && !operationUsesClass(spec, usesClass)) {
                continue;
            }
            int score = scoreTokens(tokens, op, mod, spec, fullPath);
            if (score < 0) {
                continue;
            }
            if (mod != null && "supported".equalsIgnoreCase(mod.stability())) {
                score += 5;
            }
            if (spec.deprecated()) {
                score -= 10;
            }
            hits.add(new ScoredOp(op, mod, fullPath, score));
        }

        hits.sort(Comparator.<ScoredOp>comparingInt(ScoredOp::score).reversed()
                .thenComparing(s -> s.op().key()));
        int limit = Math.max(1, Math.min(MAX_LIMIT, f.limit() <= 0 ? DEFAULT_LIMIT : f.limit()));
        int offset = Math.max(0, f.offset());
        int from = Math.min(offset, hits.size());
        int to = Math.min(hits.size(), from + limit);
        return new SearchOutcome(hits.size(), limit, offset, hits.subList(from, to));
    }

    private static void writeSearchItem(Json j, ScoredOp item, boolean fullFields) {
        Operation op = item.op();
        OperationSpec spec = op.spec();
        ModuleEntry mod = item.module();
        if (fullFields) {
            j.beginObject()
                    .field("fullPath", item.fullPath())
                    .optional("pluginKey", mod == null ? null : mod.pluginKey())
                    .name("operation").raw(CatalogSnapshot.serializeOperation(op))
                    .endObject();
            return;
        }
        j.beginObject()
                .field("key", op.key())
                .field("module", op.moduleId())
                .optional("pluginKey", mod == null ? null : mod.pluginKey())
                .field("method", spec.method())
                .field("fullPath", item.fullPath())
                .optional("access", spec.access());
        if (spec.deprecated()) {
            j.field("deprecated", true);
        }
        j.optional("summary", spec.summary());
        if (!spec.params().isEmpty()) {
            List<String> compactParams = new ArrayList<>(spec.params().size());
            for (Param p : spec.params()) {
                compactParams.add(p.name() + " (" + p.in() + ", " + p.type() + (p.required() ? ", required)" : ")"));
            }
            j.strings("params", compactParams);
        }
        j.optional("bodyType", spec.bodyJavaType() != null ? spec.bodyJavaType() : spec.bodyType())
                .optional("returnType", spec.returnJavaType() != null ? spec.returnJavaType() : spec.returnType())
                .endObject();
    }

    private static boolean matchesModule(String filter, String opModuleId, ModuleEntry mod) {
        if (filter.equals(opModuleId)) {
            return true;
        }
        if (mod != null && trimSlashes(filter).equalsIgnoreCase(trimSlashes(mod.path()))) {
            return true;
        }
        return false;
    }

    private static boolean matchesAccess(Set<String> allowed, OperationSpec spec, ModuleEntry mod) {
        String stability = mod == null || mod.stability() == null ? "" : mod.stability().toLowerCase(Locale.ROOT);
        String access = spec.access() == null ? "licensed" : spec.access();
        String accLower = access.toLowerCase(Locale.ROOT);
        for (String want : allowed) {
            switch (want) {
                case "supported", "public" -> {
                    if ("supported".equals(stability)) return true;
                }
                case "open", "anonymous" -> {
                    if (accLower.contains("anonymous") || "unrestrictedaccess".equals(accLower) || "open".equals(accLower)) {
                        return true;
                    }
                }
                case "unlicensed" -> {
                    if (accLower.contains("unlicensed")) return true;
                }
                case "admin" -> {
                    if (accLower.contains("admin") || "systemadminonly".equals(accLower)) return true;
                }
                case "sysadmin" -> {
                    if ("systemadminonly".equals(accLower) || "sysadmin".equals(accLower)) return true;
                }
                case "licensed" -> {
                    if ("licensedonly".equals(accLower) || "licensed".equals(accLower)) return true;
                }
                default -> {
                    if (accLower.equals(want) || stability.equals(want)) return true;
                }
            }
        }
        return false;
    }

    private static boolean operationUsesClass(OperationSpec spec, String needle) {
        return typeMatchesClass(spec.bodyJavaType(), needle)
                || typeMatchesClass(spec.returnJavaType(), needle)
                || typeMatchesClass(spec.bodyType(), needle)
                || typeMatchesClass(spec.returnType(), needle)
                || spec.params().stream().anyMatch(
                        p -> typeMatchesClass(p.javaType(), needle) || typeMatchesClass(p.type(), needle));
    }

    static boolean typeMatchesClass(String typeExpr, String className) {
        if (typeExpr == null || typeExpr.isEmpty()) {
            return false;
        }
        int idx = typeExpr.indexOf(className);
        while (idx >= 0) {
            boolean leftOk = idx == 0 || !isJavaIdent(typeExpr.charAt(idx - 1));
            int end = idx + className.length();
            boolean rightOk = end == typeExpr.length() || !isJavaIdent(typeExpr.charAt(end));
            if (leftOk && rightOk) {
                return true;
            }
            idx = typeExpr.indexOf(className, idx + 1);
        }
        return false;
    }

    private static boolean isJavaIdent(char c) {
        return Character.isJavaIdentifierPart(c) || c == '$';
    }

    private static int scoreTokens(String[] tokens, Operation op, ModuleEntry mod, OperationSpec spec, String fullPath) {
        if (tokens.length == 0) {
            return 0;
        }
        String fpLow = fullPath.toLowerCase(Locale.ROOT);
        String methodLow = spec.method().toLowerCase(Locale.ROOT);
        String sumLow = lower(spec.summary());
        String descLow = lower(spec.description());
        String modLow = lower(op.moduleId());
        String pluginLow = mod == null ? "" : (lower(mod.pluginKey()) + " " + lower(mod.pluginName()));
        StringBuilder extra = new StringBuilder();
        extra.append(lower(spec.bodyType())).append(' ').append(lower(spec.bodyJavaType())).append(' ')
                .append(lower(spec.returnType())).append(' ').append(lower(spec.returnJavaType()));
        for (Param p : spec.params()) {
            extra.append(' ').append(lower(p.name())).append(' ').append(lower(p.type())).append(' ')
                    .append(lower(p.javaType())).append(' ').append(lower(p.description()));
        }
        String extraLow = extra.toString();

        int score = 0;
        for (String t : tokens) {
            boolean hit = false;
            if (fpLow.equals(t)) {
                score += 1000;
                hit = true;
            } else if (fpLow.startsWith(t)) {
                score += 400;
                hit = true;
            } else if (fpLow.contains(t)) {
                score += 150;
                hit = true;
            }
            if (methodLow.equals(t)) {
                score += 100;
                hit = true;
            }
            if (sumLow.contains(t)) {
                score += 40;
                hit = true;
            }
            if (descLow.contains(t) || modLow.contains(t) || pluginLow.contains(t) || extraLow.contains(t)) {
                score += 15;
                hit = true;
            }
            if (!hit) {
                return -1;
            }
        }
        return score;
    }

    // ---- URL resolver internals

    private record UrlResolution(String method, String normalizedPath, Map<String, List<String>> queryParams,
                                 List<ResolvedMatch> matches) {
    }

    private static UrlResolution evaluateResolve(CatalogSnapshot snapshot, String rawMethod, String rawUrl, int rawLimit) {
        String method = trimOrNull(rawMethod);
        if (method != null) {
            method = method.toUpperCase(Locale.ROOT);
        }
        String raw = rawUrl == null ? "" : rawUrl.trim();
        int qIdx = raw.indexOf('?');
        String beforeQuery = qIdx >= 0 ? raw.substring(0, qIdx) : raw;
        String queryPart = qIdx >= 0 ? raw.substring(qIdx + 1) : "";
        String pathOnly = extractUrlPath(beforeQuery);
        String normalized = stripRestPrefix(pathOnly);
        Map<String, List<String>> queryParams = parseQueryParams(queryPart);
        List<String> targetSegs = splitSegments(normalized);

        int limit = Math.max(1, Math.min(MAX_RESOLVE_LIMIT, rawLimit <= 0 ? 10 : rawLimit));
        List<ResolvedMatch> matches = new ArrayList<>();
        for (Operation op : snapshot.operations()) {
            OperationSpec spec = op.spec();
            if (method != null && !method.equalsIgnoreCase(spec.method())) {
                continue;
            }
            ModuleEntry mod = snapshot.module(op.moduleId()).orElse(null);
            String fp = fullPath(mod, spec);
            List<String> tplSegs = splitSegments(fp);
            SegmentMatch matched = matchSegments(tplSegs, targetSegs);
            if (matched != null) {
                matches.add(new ResolvedMatch(op, mod, fp, matched.params, matched.score));
            }
        }
        matches.sort(Comparator.<ResolvedMatch>comparingInt(ResolvedMatch::score).reversed()
                .thenComparing(m -> m.op().key()));
        if (matches.size() > limit) {
            matches = matches.subList(0, limit);
        }
        return new UrlResolution(method, normalized, queryParams, matches);
    }

    private record SegmentMatch(Map<String, String> params, int score) {
    }

    static SegmentMatch matchSegments(List<String> tpl, List<String> target) {
        Map<String, String> params = new LinkedHashMap<>();
        int score = 0;
        int ti = 0;
        int vi = 0;
        while (ti < tpl.size()) {
            String pat = tpl.get(ti);
            if (ti == tpl.size() - 1 && isCatchAllTemplate(pat)) {
                String varName = templateVarName(pat);
                String joined = vi >= target.size() ? "" : String.join("/", target.subList(vi, target.size()));
                if (pat.endsWith(":.+}") && joined.isEmpty()) {
                    return null;
                }
                params.put(varName, decodeComponent(joined));
                return new SegmentMatch(params, score + 1);
            }
            if (vi >= target.size()) {
                return null;
            }
            String actual = target.get(vi);
            Integer segScore = matchSingleSegment(pat, actual, params);
            if (segScore == null) {
                return null;
            }
            score += segScore;
            ti++;
            vi++;
        }
        return vi == target.size() ? new SegmentMatch(params, score) : null;
    }

    private static Integer matchSingleSegment(String pat, String actual, Map<String, String> params) {
        if (!pat.contains("{")) {
            return pat.equals(actual) ? 10 : null;
        }
        if (pat.startsWith("{") && pat.endsWith("}") && pat.indexOf('{', 1) < 0) {
            int colon = pat.indexOf(':');
            String varName = (colon > 1 ? pat.substring(1, colon) : pat.substring(1, pat.length() - 1)).trim();
            String decoded = decodeComponent(actual);
            if (decoded.isEmpty()) {
                return null;
            }
            if (colon > 1) {
                String regex = pat.substring(colon + 1, pat.length() - 1).trim();
                if (!matchesSafeRegex(regex, decoded)) {
                    return null;
                }
                params.put(varName, decoded);
                return 5;
            }
            params.put(varName, decoded);
            return 3;
        }
        // Mixed literal + {var} segment (e.g. "item-{id}.json")
        StringBuilder rx = new StringBuilder("^");
        List<String> names = new ArrayList<>();
        int idx = 0;
        while (idx < pat.length()) {
            int open = pat.indexOf('{', idx);
            if (open < 0) {
                rx.append(Pattern.quote(pat.substring(idx)));
                break;
            }
            if (open > idx) {
                rx.append(Pattern.quote(pat.substring(idx, open)));
            }
            int close = findMatchingBrace(pat, open);
            if (close < 0) {
                return null;
            }
            String inner = pat.substring(open + 1, close);
            int colon = inner.indexOf(':');
            String name = (colon > 0 ? inner.substring(0, colon) : inner).trim();
            names.add(name);
            rx.append("([^/]+)");
            idx = close + 1;
        }
        rx.append('$');
        try {
            Matcher m = Pattern.compile(rx.toString()).matcher(decodeComponent(actual));
            if (!m.matches()) {
                return null;
            }
            for (int k = 0; k < names.size(); k++) {
                params.put(names.get(k), m.group(k + 1));
            }
            return 6;
        } catch (PatternSyntaxException e) {
            return null;
        }
    }

    private static boolean isCatchAllTemplate(String seg) {
        return seg.startsWith("{") && (seg.endsWith(":.*}") || seg.endsWith(":.+}"));
    }

    private static String templateVarName(String seg) {
        int colon = seg.indexOf(':');
        return (colon > 1 ? seg.substring(1, colon) : seg.substring(1, seg.length() - 1)).trim();
    }

    private static int findMatchingBrace(String s, int open) {
        int depth = 1;
        for (int i = open + 1; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '{') depth++;
            else if (c == '}' && --depth == 0) return i;
        }
        return -1;
    }

    private static boolean matchesSafeRegex(String regex, String candidate) {
        if (regex.isEmpty() || ".*".equals(regex) || ".+".equals(regex)) {
            return !regex.equals(".+") || !candidate.isEmpty();
        }
        if (regex.length() > MAX_PATH_REGEX_LEN || NESTED_QUANTIFIERS.matcher(regex).find()) {
            return true; // avoid ReDoS; treat exotic user regexes permissively
        }
        try {
            return Pattern.compile(regex).matcher(candidate).matches();
        } catch (PatternSyntaxException e) {
            return false;
        }
    }

    static String fullPath(ModuleEntry mod, OperationSpec spec) {
        String mp = mod == null ? "" : trimSlashes(mod.path());
        String sp = trimSlashes(spec.path());
        if (mp.isEmpty()) return sp;
        if (sp.isEmpty()) return mp;
        return mp + "/" + sp;
    }

    private static String extractUrlPath(String beforeQuery) {
        String lower = beforeQuery.toLowerCase(Locale.ROOT);
        if (lower.startsWith("http://") || lower.startsWith("https://")) {
            try {
                URI uri = URI.create(beforeQuery);
                if (uri.getRawPath() != null) {
                    return uri.getRawPath();
                }
            } catch (IllegalArgumentException ignored) {
                // fall back below when URL contains unencoded braces like {id}
            }
            int schemeEnd = beforeQuery.indexOf("://");
            int slash = beforeQuery.indexOf('/', schemeEnd + 3);
            return slash >= 0 ? beforeQuery.substring(slash) : "";
        }
        return beforeQuery;
    }

    static String stripRestPrefix(String raw) {
        if (raw == null || raw.isBlank()) {
            return "";
        }
        String clean = raw.trim().replaceAll("/{2,}", "/");
        String lower = clean.toLowerCase(Locale.ROOT);
        int restIdx = lower.indexOf("/rest/");
        if (restIdx >= 0) {
            clean = clean.substring(restIdx + "/rest/".length());
        } else if (lower.startsWith("rest/")) {
            clean = clean.substring("rest/".length());
        }
        return trimSlashes(clean);
    }

    private static List<String> splitSegments(String path) {
        String clean = trimSlashes(path);
        if (clean.isEmpty()) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (String seg : clean.split("/")) {
            if (!seg.isEmpty()) {
                out.add(seg);
            }
        }
        return out;
    }

    private static Map<String, List<String>> parseQueryParams(String queryPart) {
        Map<String, List<String>> out = new LinkedHashMap<>();
        if (queryPart == null || queryPart.isEmpty()) {
            return out;
        }
        for (String pair : queryPart.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            String k = decodeComponent(eq >= 0 ? pair.substring(0, eq) : pair);
            String v = eq >= 0 ? decodeComponent(pair.substring(eq + 1)) : "";
            out.computeIfAbsent(k, ignored -> new ArrayList<>()).add(v);
        }
        return out;
    }

    private static String decodeComponent(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        try {
            return URLDecoder.decode(raw, StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return raw;
        }
    }

    private static String trimSlashes(String s) {
        if (s == null || s.isEmpty()) return "";
        int start = 0;
        int end = s.length();
        while (start < end && s.charAt(start) == '/') start++;
        while (end > start && s.charAt(end - 1) == '/') end--;
        return s.substring(start, end);
    }

    private static String trimOrNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }

    private static String lower(String s) {
        return s == null ? "" : s.toLowerCase(Locale.ROOT);
    }

    private static Set<String> parseUpperCsv(String raw) {
        Set<String> set = new LinkedHashSet<>();
        if (raw != null && !raw.isBlank()) {
            for (String p : raw.split(",")) {
                if (!p.isBlank()) set.add(p.trim().toUpperCase(Locale.ROOT));
            }
        }
        return set;
    }

    private static Set<String> parseLowerCsv(String raw) {
        Set<String> set = new LinkedHashSet<>();
        if (raw != null && !raw.isBlank()) {
            for (String p : raw.split(",")) {
                if (!p.isBlank()) set.add(p.trim().toLowerCase(Locale.ROOT));
            }
        }
        return set;
    }

    private static String[] parseTokens(String raw) {
        if (raw == null || raw.isBlank()) return new String[0];
        return raw.trim().toLowerCase(Locale.ROOT).split("\\s+");
    }
}
