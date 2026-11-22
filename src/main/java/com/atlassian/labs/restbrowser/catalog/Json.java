package com.atlassian.labs.restbrowser.catalog;

import java.util.Collection;
import java.util.Map;

/**
 * A minimal JSON writer. The catalog's hash is computed over its JSON, so the output must be deterministic: fields
 * are written in the order the caller writes them, and nothing depends on a library's settings.
 */
final class Json {

    private final StringBuilder out = new StringBuilder(1024);
    private boolean needComma;

    Json beginObject() {
        comma();
        out.append('{');
        needComma = false;
        return this;
    }

    Json endObject() {
        out.append('}');
        needComma = true;
        return this;
    }

    Json beginArray() {
        comma();
        out.append('[');
        needComma = false;
        return this;
    }

    Json endArray() {
        out.append(']');
        needComma = true;
        return this;
    }

    Json name(String name) {
        comma();
        string(name);
        out.append(':');
        needComma = false;
        return this;
    }

    Json value(String value) {
        comma();
        if (value == null) {
            out.append("null");
        } else {
            string(value);
        }
        needComma = true;
        return this;
    }

    Json value(boolean value) {
        comma();
        out.append(value);
        needComma = true;
        return this;
    }

    Json value(long value) {
        comma();
        out.append(value);
        needComma = true;
        return this;
    }

    /** Raw JSON produced by another writer, inserted as one value. */
    Json raw(String json) {
        comma();
        out.append(json);
        needComma = true;
        return this;
    }

    Json field(String name, String value) {
        return name(name).value(value);
    }

    /** Writes the field only when the value is not null. */
    Json optional(String name, String value) {
        return value == null ? this : field(name, value);
    }

    Json field(String name, boolean value) {
        return name(name).value(value);
    }

    Json field(String name, long value) {
        return name(name).value(value);
    }

    Json strings(String name, Collection<String> values) {
        name(name).beginArray();
        for (String v : values) {
            value(v);
        }
        return endArray();
    }

    Json stringMap(String name, Map<String, String> values) {
        name(name).beginObject();
        values.forEach((k, v) -> field(k, v));
        return endObject();
    }

    @Override
    public String toString() {
        return out.toString();
    }

    private void comma() {
        if (needComma) {
            out.append(',');
        }
    }

    private void string(String s) {
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                case '<' -> out.append("\\u003c"); // never closes a script element if embedded anywhere
                default -> {
                    if (c < 0x20 || c == 0x2028 || c == 0x2029) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        out.append('"');
    }
}
