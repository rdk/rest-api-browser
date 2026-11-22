package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.OperationSpec;
import com.atlassian.labs.restbrowser.catalog.Model.State;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Test helpers: builds snapshots (CatalogSnapshot.of is package-private) and parses JSON. */
public final class CatalogTestSupport {

    private CatalogTestSupport() {
    }

    public static ModuleEntry module(String id, String path, State state, String version) {
        return new ModuleEntry(id, path, "product", "supported", "jersey", state, null, null, 0,
                "plugin." + id, "Plugin " + id, version);
    }

    public static OperationSpec spec(String method, String path) {
        return new OperationSpec(method, path, List.of(), List.of("application/json"), List.of(), null, false, null);
    }

    public static CatalogSnapshot snapshot(List<ModuleEntry> modules, List<Operation> operations, boolean complete,
                                           String ownVersion) {
        return CatalogSnapshot.of(modules, operations, complete, modules.size(), modules.size(), ownVersion);
    }

    /** A strict, minimal JSON parser: objects become LinkedHashMap, arrays List, numbers Long. Throws on bad JSON. */
    public static Object parseJson(String json) {
        Parser p = new Parser(json);
        Object v = p.value();
        p.ws();
        if (p.i != json.length()) {
            throw new IllegalArgumentException("trailing data at " + p.i);
        }
        return v;
    }

    private static final class Parser {
        final String s;
        int i;

        Parser(String s) {
            this.s = s;
        }

        void ws() {
            while (i < s.length() && " \t\r\n".indexOf(s.charAt(i)) >= 0) {
                i++;
            }
        }

        char peek() {
            ws();
            if (i >= s.length()) {
                throw new IllegalArgumentException("unexpected end");
            }
            return s.charAt(i);
        }

        void expect(char c) {
            if (peek() != c) {
                throw new IllegalArgumentException("expected " + c + " at " + i);
            }
            i++;
        }

        Object value() {
            char c = peek();
            if (c == '{') {
                i++;
                Map<String, Object> m = new LinkedHashMap<>();
                if (peek() == '}') {
                    i++;
                    return m;
                }
                do {
                    String k = string();
                    expect(':');
                    m.put(k, value());
                } while (comma('}'));
                return m;
            }
            if (c == '[') {
                i++;
                List<Object> l = new ArrayList<>();
                if (peek() == ']') {
                    i++;
                    return l;
                }
                do {
                    l.add(value());
                } while (comma(']'));
                return l;
            }
            if (c == '"') {
                return string();
            }
            for (String lit : new String[]{"true", "false", "null"}) {
                if (s.startsWith(lit, i)) {
                    i += lit.length();
                    return lit.equals("null") ? null : Boolean.valueOf(lit);
                }
            }
            int start = i;
            while (i < s.length() && "-0123456789".indexOf(s.charAt(i)) >= 0) {
                i++;
            }
            if (start == i) {
                throw new IllegalArgumentException("bad value at " + i);
            }
            return Long.valueOf(s.substring(start, i));
        }

        boolean comma(char close) {
            char c = peek();
            i++;
            if (c == ',') {
                return true;
            }
            if (c == close) {
                return false;
            }
            throw new IllegalArgumentException("expected , or " + close + " at " + (i - 1));
        }

        String string() {
            expect('"');
            StringBuilder b = new StringBuilder();
            while (true) {
                if (i >= s.length()) {
                    throw new IllegalArgumentException("unterminated string");
                }
                char c = s.charAt(i++);
                if (c == '"') {
                    return b.toString();
                }
                if (c < 0x20) {
                    throw new IllegalArgumentException("raw control char in string");
                }
                if (c == '\\') {
                    char e = s.charAt(i++);
                    switch (e) {
                        case '"', '\\', '/' -> b.append(e);
                        case 'n' -> b.append('\n');
                        case 'r' -> b.append('\r');
                        case 't' -> b.append('\t');
                        case 'b' -> b.append('\b');
                        case 'f' -> b.append('\f');
                        case 'u' -> {
                            b.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                            i += 4;
                        }
                        default -> throw new IllegalArgumentException("bad escape " + e);
                    }
                } else {
                    b.append(c);
                }
            }
        }
    }
}
