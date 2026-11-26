package com.atlassian.labs.restbrowser.json;

import java.util.Collection;
import java.util.Map;

/**
 * A deterministic, zero-dependency JSON writer: fields are emitted strictly in caller order with safe escaping for
 * inline HTML/script embedding ({@code <}, {@code \u2028}, {@code \u2029}).
 */
public final class Json {

    private final StringBuilder out = new StringBuilder(1024);
    private boolean needComma;

    public Json beginObject() {
        comma();
        out.append('{');
        needComma = false;
        return this;
    }

    public Json endObject() {
        out.append('}');
        needComma = true;
        return this;
    }

    public Json beginArray() {
        comma();
        out.append('[');
        needComma = false;
        return this;
    }

    public Json endArray() {
        out.append(']');
        needComma = true;
        return this;
    }

    public Json name(String name) {
        comma();
        string(name);
        out.append(':');
        needComma = false;
        return this;
    }

    public Json value(String value) {
        comma();
        if (value == null) {
            out.append("null");
        } else {
            string(value);
        }
        needComma = true;
        return this;
    }

    public Json value(boolean value) {
        comma();
        out.append(value);
        needComma = true;
        return this;
    }

    public Json value(long value) {
        comma();
        out.append(value);
        needComma = true;
        return this;
    }

    /** Raw pre-serialized JSON produced by another writer, inserted as one value. */
    public Json raw(String json) {
        comma();
        out.append(json);
        needComma = true;
        return this;
    }

    public Json field(String name, String value) {
        return name(name).value(value);
    }

    /** Writes the field only when the value is not null. */
    public Json optional(String name, String value) {
        return value == null ? this : field(name, value);
    }

    public Json field(String name, boolean value) {
        return name(name).value(value);
    }

    public Json field(String name, long value) {
        return name(name).value(value);
    }

    public Json strings(String name, Collection<String> values) {
        name(name).beginArray();
        for (String v : values) {
            value(v);
        }
        return endArray();
    }

    public Json stringMap(String name, Map<String, String> values) {
        name(name).beginObject();
        values.forEach(this::field);
        return endObject();
    }

    /** Convenience helper returning a JSON-quoted string (or {@code "null"} if null). */
    public static String quote(String s) {
        if (s == null) {
            return "null";
        }
        Json j = new Json();
        j.string(s);
        return j.out.toString();
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
        appendEscaped(out, s);
        out.append('"');
    }

    private static void appendEscaped(StringBuilder out, String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                case '<' -> out.append("\\u003c");
                default -> {
                    if (c < 0x20 || c == 0x2028 || c == 0x2029) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
    }
}
