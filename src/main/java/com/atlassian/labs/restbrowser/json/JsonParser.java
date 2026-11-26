package com.atlassian.labs.restbrowser.json;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Bounded recursive-descent JSON parser returning standard JDK collections ({@link Map}, {@link List}, {@link String},
 * {@link Long}, {@link Double}, {@link Boolean}, or {@code null}). Rejects malformed syntax, depth past 32, and
 * unrepresentable numbers cleanly via {@link JsonParseException}.
 */
public final class JsonParser {

    public static final int MAX_DEPTH = 32;

    public static final class JsonParseException extends IllegalArgumentException {
        public JsonParseException(String message) {
            super(message);
        }
    }

    private final String s;
    private int i;

    private JsonParser(String s) {
        this.s = s;
    }

    public static Object parse(String json) {
        if (json == null || json.isBlank()) {
            throw new JsonParseException("empty JSON input");
        }
        JsonParser p = new JsonParser(json);
        Object value = p.readValue(0);
        p.skipWs();
        if (p.i != json.length()) {
            throw new JsonParseException("trailing data at offset " + p.i);
        }
        return value;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> parseObject(String json) {
        Object v = parse(json);
        if (!(v instanceof Map<?, ?>)) {
            throw new JsonParseException("expected JSON object");
        }
        return (Map<String, Object>) v;
    }

    private void skipWs() {
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
                i++;
            } else {
                break;
            }
        }
    }

    private char peek() {
        skipWs();
        if (i >= s.length()) {
            throw new JsonParseException("unexpected end of JSON");
        }
        return s.charAt(i);
    }

    private void expect(char c) {
        if (peek() != c) {
            throw new JsonParseException("expected '" + c + "' at offset " + i);
        }
        i++;
    }

    private Object readValue(int depth) {
        if (depth > MAX_DEPTH) {
            throw new JsonParseException("JSON nesting exceeds " + MAX_DEPTH);
        }
        char c = peek();
        return switch (c) {
            case '{' -> readObject(depth + 1);
            case '[' -> readArray(depth + 1);
            case '"' -> readString();
            case 't' -> expectLiteral("true", Boolean.TRUE);
            case 'f' -> expectLiteral("false", Boolean.FALSE);
            case 'n' -> expectLiteral("null", null);
            default -> readNumber();
        };
    }

    private Map<String, Object> readObject(int depth) {
        if (depth > MAX_DEPTH) {
            throw new JsonParseException("JSON nesting exceeds " + MAX_DEPTH);
        }
        i++; // '{'
        Map<String, Object> map = new LinkedHashMap<>();
        if (peek() == '}') {
            i++;
            return map;
        }
        do {
            String key = readString();
            expect(':');
            map.put(key, readValue(depth));
        } while (readComma('}'));
        return map;
    }

    private List<Object> readArray(int depth) {
        if (depth > MAX_DEPTH) {
            throw new JsonParseException("JSON nesting exceeds " + MAX_DEPTH);
        }
        i++; // '['
        List<Object> list = new ArrayList<>();
        if (peek() == ']') {
            i++;
            return list;
        }
        do {
            list.add(readValue(depth));
        } while (readComma(']'));
        return list;
    }

    private boolean readComma(char close) {
        char c = peek();
        i++;
        if (c == ',') {
            return true;
        }
        if (c == close) {
            return false;
        }
        throw new JsonParseException("expected ',' or '" + close + "' at offset " + (i - 1));
    }

    private Object expectLiteral(String literal, Object value) {
        if (!s.startsWith(literal, i)) {
            throw new JsonParseException("unexpected token at offset " + i);
        }
        i += literal.length();
        return value;
    }

    private String readString() {
        expect('"');
        StringBuilder out = new StringBuilder();
        while (true) {
            if (i >= s.length()) {
                throw new JsonParseException("unterminated string literal");
            }
            char c = s.charAt(i++);
            if (c == '"') {
                return out.toString();
            }
            if (c < 0x20) {
                throw new JsonParseException("unescaped control character in string at offset " + (i - 1));
            }
            if (c == '\\') {
                if (i >= s.length()) {
                    throw new JsonParseException("unterminated escape sequence");
                }
                char esc = s.charAt(i++);
                switch (esc) {
                    case '"', '\\', '/' -> out.append(esc);
                    case 'n' -> out.append('\n');
                    case 'r' -> out.append('\r');
                    case 't' -> out.append('\t');
                    case 'b' -> out.append('\b');
                    case 'f' -> out.append('\f');
                    case 'u' -> {
                        if (i + 4 > s.length()) {
                            throw new JsonParseException("incomplete \\u escape at offset " + i);
                        }
                        out.append(readHexEscape(i));
                        i += 4;
                    }
                    default -> throw new JsonParseException("invalid escape '\\" + esc + "'");
                }
            } else {
                out.append(c);
            }
        }
    }

    private char readHexEscape(int offset) {
        int code = 0;
        for (int k = 0; k < 4; k++) {
            char h = s.charAt(offset + k);
            int d = hexDigit(h);
            if (d < 0) {
                throw new JsonParseException("invalid \\u escape at offset " + offset);
            }
            code = (code << 4) | d;
        }
        return (char) code;
    }

    private static int hexDigit(char c) {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    }

    private static boolean isAsciiDigit(char c) {
        return c >= '0' && c <= '9';
    }

    private Number readNumber() {
        int start = i;
        if (s.charAt(i) == '-') {
            i++;
        }
        if (i >= s.length() || !isAsciiDigit(s.charAt(i))) {
            throw new JsonParseException("invalid number at offset " + start);
        }
        if (s.charAt(i) == '0') {
            i++;
        } else {
            while (i < s.length() && isAsciiDigit(s.charAt(i))) {
                i++;
            }
        }
        boolean decimal = false;
        if (i < s.length() && s.charAt(i) == '.') {
            decimal = true;
            i++;
            if (i >= s.length() || !isAsciiDigit(s.charAt(i))) {
                throw new JsonParseException("invalid fractional number at offset " + start);
            }
            while (i < s.length() && isAsciiDigit(s.charAt(i))) {
                i++;
            }
        }
        if (i < s.length() && (s.charAt(i) == 'e' || s.charAt(i) == 'E')) {
            decimal = true;
            i++;
            if (i < s.length() && (s.charAt(i) == '+' || s.charAt(i) == '-')) {
                i++;
            }
            if (i >= s.length() || !isAsciiDigit(s.charAt(i))) {
                throw new JsonParseException("invalid exponent at offset " + start);
            }
            while (i < s.length() && isAsciiDigit(s.charAt(i))) {
                i++;
            }
        }
        String raw = s.substring(start, i);
        try {
            if (!decimal) {
                return Long.parseLong(raw);
            }
            double d = Double.parseDouble(raw);
            if (!Double.isFinite(d)) {
                throw new JsonParseException("non-finite number: " + raw);
            }
            return d;
        } catch (NumberFormatException e) {
            throw new JsonParseException("number out of range: " + raw);
        }
    }
}
