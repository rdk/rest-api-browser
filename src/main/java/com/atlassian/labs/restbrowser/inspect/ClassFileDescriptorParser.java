package com.atlassian.labs.restbrowser.inspect;

import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * Pure-JDK parsers and formatters for JVMS classfile descriptors, generic signatures, and internal class names.
 */
final class ClassFileDescriptorParser {

    private ClassFileDescriptorParser() {
    }

    static boolean looksLikeStrictJvmDescriptor(String s) {
        if (s.indexOf(' ') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\t') >= 0) {
            return false;
        }
        if (s.startsWith("(") && s.indexOf(')') > 0) {
            return true;
        }
        if (s.startsWith("[")) {
            return s.endsWith(";") || (s.length() == 2 && "ZBCSIJFD".indexOf(s.charAt(1)) >= 0);
        }
        return s.startsWith("L") && s.endsWith(";") && s.contains("/");
    }

    static void addTypedFromDescriptor(String descriptor, String kind, Map<String, Set<String>> out) {
        Set<String> classes = new LinkedHashSet<>();
        extractSignatureOrDescriptorClasses(descriptor, classes);
        for (String cls : classes) {
            out.computeIfAbsent(cls, k -> new LinkedHashSet<>()).add(kind);
        }
    }

    static String formatMethodSignature(String name, String descriptor, String ownerFqcn) {
        int open = descriptor.indexOf('(');
        int close = descriptor.indexOf(')');
        if (open < 0 || close < open) {
            return name + descriptor;
        }
        String display = "<init>".equals(name) && ownerFqcn != null
                ? ownerFqcn.substring(ownerFqcn.lastIndexOf('.') + 1)
                : name;
        StringBuilder sb = new StringBuilder(display).append('(');
        int[] idx = {open + 1};
        boolean first = true;
        while (idx[0] < close) {
            if (!first) {
                sb.append(", ");
            }
            first = false;
            sb.append(parseDescriptorType(descriptor, idx));
        }
        sb.append(')');
        if (!"<init>".equals(name)) {
            int[] rIdx = {close + 1};
            sb.append(": ").append(parseDescriptorType(descriptor, rIdx));
        }
        return sb.toString();
    }

    private static String parseDescriptorType(String desc, int[] idx) {
        int dims = 0;
        while (idx[0] < desc.length() && desc.charAt(idx[0]) == '[') {
            dims++;
            idx[0]++;
        }
        if (idx[0] >= desc.length()) {
            return "?";
        }
        char c = desc.charAt(idx[0]++);
        String base = switch (c) {
            case 'V' -> "void";
            case 'Z' -> "boolean";
            case 'B' -> "byte";
            case 'S' -> "short";
            case 'C' -> "char";
            case 'I' -> "int";
            case 'J' -> "long";
            case 'F' -> "float";
            case 'D' -> "double";
            case 'L' -> {
                int semi = desc.indexOf(';', idx[0]);
                if (semi < 0) {
                    idx[0] = desc.length();
                    yield "?";
                }
                String internal = desc.substring(idx[0], semi);
                idx[0] = semi + 1;
                int slash = internal.lastIndexOf('/');
                yield (slash >= 0 ? internal.substring(slash + 1) : internal).replace('$', '.');
            }
            default -> String.valueOf(c);
        };
        return dims == 0 ? base : base + "[]".repeat(dims);
    }

    static String internalToFqcn(String internal) {
        if (internal == null || internal.isEmpty() || internal.startsWith("[")) {
            return null;
        }
        String fqcn = internal.replace('/', '.');
        return ClassFileInspector.SAFE_CLASS_NAME.matcher(fqcn).matches() ? fqcn : null;
    }

    /** Rejects arbitrary prose / SQL / JSON Utf8 strings that happen to contain L.../...; fragments. */
    static boolean looksLikeJvmTypeOrSignature(String s) {
        if (s.indexOf(' ') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\t') >= 0) {
            return false;
        }
        return s.startsWith("L") || s.startsWith("(") || s.startsWith("[") || s.startsWith("<");
    }

    static void addInternalClassName(String internal, Set<String> out) {
        String s = internal;
        while (s.startsWith("[")) {
            s = s.substring(1);
        }
        if (s.startsWith("L") && s.endsWith(";")) {
            s = s.substring(1, s.length() - 1);
        }
        if (s.contains("/")) {
            String fqcn = s.replace('/', '.');
            if (ClassFileInspector.SAFE_CLASS_NAME.matcher(fqcn).matches()) {
                out.add(fqcn);
            }
        }
    }

    /**
     * Parses JVM field/method descriptors AND generic {@code Signature} strings, including parameterized types
     * ({@code Ljava/util/List<Lcom/example/Foo;>;}) and parameterized member types ({@code LOuter<TT;>.Inner;}).
     */
    static void extractSignatureOrDescriptorClasses(String descriptor, Set<String> out) {
        int len = descriptor.length();
        for (int i = 0; i < len; i++) {
            if (descriptor.charAt(i) != 'L') {
                continue;
            }
            int cur = i + 1;
            StringBuilder binary = new StringBuilder();
            boolean hasSlash = false;
            boolean valid = true;
            while (cur < len) {
                char c = descriptor.charAt(cur);
                if (c == ';') {
                    break;
                }
                if (c == '<') {
                    // Emit enclosing parameterized class (e.g. java.util.List) cleanly before inner type args
                    if (hasSlash && binary.length() > 0) {
                        addBinaryIfSafe(binary.toString(), out);
                    }
                    int depth = 1;
                    int argStart = cur + 1;
                    cur++;
                    while (cur < len && depth > 0) {
                        char ac = descriptor.charAt(cur);
                        if (ac == '<') {
                            depth++;
                        } else if (ac == '>') {
                            depth--;
                        }
                        cur++;
                    }
                    if (depth != 0) {
                        valid = false;
                        break;
                    }
                    if (cur - 1 > argStart) {
                        extractSignatureOrDescriptorClasses(descriptor.substring(argStart, cur - 1), out);
                    }
                    // Continue after '>'; next char may be ';' or '.MemberClass'
                    if (cur < len && descriptor.charAt(cur) == '.') {
                        binary.append('$');
                        cur++;
                    }
                    continue;
                }
                if (c == '/') {
                    hasSlash = true;
                    binary.append('.');
                } else if (c == '.') {
                    binary.append('$');
                } else if (Character.isJavaIdentifierPart(c) || c == '$') {
                    binary.append(c);
                } else {
                    valid = false;
                    break;
                }
                cur++;
            }
            if (valid && hasSlash && cur < len && descriptor.charAt(cur) == ';' && binary.length() > 0) {
                addBinaryIfSafe(binary.toString(), out);
                i = cur;
            }
        }
    }

    private static void addBinaryIfSafe(String fqcn, Set<String> out) {
        if (ClassFileInspector.SAFE_CLASS_NAME.matcher(fqcn).matches()) {
            out.add(fqcn);
        }
    }
}
