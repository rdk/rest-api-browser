package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.OperationSpec;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Gives operations their keys: {@code moduleId:METHOD:path} with every path template written as {}, so the key does
 * not depend on how a source names parameters. Two handlers for the same method and path (told apart by media type
 * or by a template's regular expression) get a suffix: the first consumed media type's subtype, then a counter.
 */
final class OperationKeys {

    /**
     * A total order, so every node assigns the same suffixes to the same operations whatever order Jersey lists them
     * in: normalized path first, so renaming a template does not move a suffix to another operation.
     */
    private static final Comparator<OperationSpec> ORDER = Comparator
            .comparing((OperationSpec o) -> normalize(o.path()))
            .thenComparing(OperationSpec::method)
            .thenComparing(o -> String.join(",", o.consumes()))
            .thenComparing(o -> String.join(",", o.produces()))
            .thenComparing(OperationSpec::path)
            .thenComparing(o -> String.valueOf(o.params()))
            .thenComparing(o -> String.valueOf(o.bodyType()))
            .thenComparing(o -> String.valueOf(o.bodyJavaType()))
            .thenComparing(o -> String.valueOf(o.returnType()))
            .thenComparing(o -> String.valueOf(o.returnJavaType()))
            .thenComparing(o -> String.valueOf(o.access()))
            .thenComparing(OperationSpec::deprecated)
            .thenComparing(o -> String.valueOf(o.summary()))
            .thenComparing(o -> String.valueOf(o.description()));

    private OperationKeys() {
    }

    static List<Operation> assign(String moduleId, List<OperationSpec> specs) {
        List<OperationSpec> sorted = new ArrayList<>(specs);
        sorted.sort(ORDER);
        Map<String, Integer> seen = new HashMap<>();
        List<Operation> out = new ArrayList<>();
        for (OperationSpec spec : sorted) {
            String base = moduleId + ":" + spec.method() + ":" + normalize(spec.path());
            String key = base;
            if (seen.containsKey(base)) {
                key = base + "#" + suffix(spec);
                int n = 2;
                while (seen.containsKey(key)) {
                    key = base + "#" + n++;
                }
            }
            seen.put(base, 1);
            seen.put(key, 1);
            out.add(new Operation(key, moduleId, spec));
        }
        return out;
    }

    private static String suffix(OperationSpec spec) {
        if (spec.consumes().isEmpty()) {
            return "2";
        }
        String type = spec.consumes().get(0);
        int slash = type.indexOf('/');
        String subtype = slash < 0 ? type : type.substring(slash + 1);
        int semicolon = subtype.indexOf(';');
        String clean = (semicolon < 0 ? subtype : subtype.substring(0, semicolon)).trim();
        // only characters that are safe in a URL parameter and readable; "*" and the like fall back to a counter
        return clean.matches("[A-Za-z0-9.+-]+") ? clean : "2";
    }

    /** Replaces every {template}, including ones whose regular expression contains braces, by {}. */
    static String normalize(String path) {
        StringBuilder out = new StringBuilder(path.length());
        int depth = 0;
        for (int i = 0; i < path.length(); i++) {
            char c = path.charAt(i);
            if (c == '{') {
                if (depth++ == 0) {
                    out.append("{}");
                }
            } else if (c == '}') {
                depth = Math.max(0, depth - 1);
            } else if (depth == 0) {
                out.append(c);
            }
        }
        return out.toString();
    }
}
