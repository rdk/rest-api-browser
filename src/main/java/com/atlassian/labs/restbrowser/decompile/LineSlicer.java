package com.atlassian.labs.restbrowser.decompile;

/**
 * Overflow-safe 1-based line slicer with a zero-allocation fast path when no range is specified.
 */
public final class LineSlicer {

    public record Slice(String text, int startLine, int endLine, boolean truncated) {
    }

    private LineSlicer() {
    }

    public static Slice slice(String source, int totalLines, Integer rawStart, Integer rawMax) {
        if (rawStart == null && rawMax == null) {
            int total = totalLines > 0 ? totalLines : countLines(source);
            return new Slice(source, 1, total, false);
        }
        String[] lines = source.split("\n", -1);
        int total = lines.length;
        int start = rawStart == null ? 1 : Math.max(1, Math.min(total, rawStart));
        int max = rawMax == null ? total : Math.max(1, rawMax);
        int end = (int) Math.min(total, (long) start + max - 1L);
        StringBuilder sb = new StringBuilder();
        for (int i = start - 1; i < end; i++) {
            if (i > start - 1) {
                sb.append('\n');
            }
            sb.append(lines[i]);
        }
        return new Slice(sb.toString(), start, end, end < total || start > 1);
    }

    /** Formats text with 1-based right-aligned line numbers starting at {@code startLine}. */
    public static String formatWithLineNumbers(String text, int startLine) {
        if (text == null) {
            return "";
        }
        int base = Math.max(1, startLine);
        String[] lines = text.split("\n", -1);
        int width = String.valueOf(base + lines.length - 1).length();
        String fmt = "%" + width + "d | %s";
        StringBuilder sb = new StringBuilder(text.length() + lines.length * (width + 4));
        for (int i = 0; i < lines.length; i++) {
            if (i > 0) {
                sb.append('\n');
            }
            sb.append(String.format(fmt, base + i, lines[i]));
        }
        return sb.toString();
    }

    public static int countLines(String s) {
        if (s == null || s.isEmpty()) {
            return 1;
        }
        int n = 1;
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) == '\n') {
                n++;
            }
        }
        return n;
    }
}
