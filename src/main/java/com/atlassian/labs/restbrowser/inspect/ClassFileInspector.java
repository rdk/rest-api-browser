package com.atlassian.labs.restbrowser.inspect;

import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;

/**
 * Pure-JDK classfile metadata and constant-pool reference analyzer.
 * <p>
 * Reads JVMS classfile headers, inspects referenced classes strictly from class constants, field/method/method-type
 * descriptors, and generic {@code Signature} strings (never scanning arbitrary {@code CONSTANT_String} literals), and
 * walks multi-level nested/anonymous inner classes recursively up to a bounded depth.
 */
public final class ClassFileInspector {

    public static final Pattern SAFE_CLASS_NAME = Pattern.compile("^[A-Za-z0-9_.$]{1,300}$");
    private static final int MAX_RECURSIVE_INNERS = 64;

    public record BytecodeVersion(int major, int minor, String label) {
    }

    private ClassFileInspector() {
    }

    public static BytecodeVersion readBytecodeVersion(byte[] classBytes) {
        if (classBytes == null || classBytes.length < 8) {
            return null;
        }
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(classBytes))) {
            if (in.readInt() != 0xCAFEBABE) {
                return null;
            }
            int minor = in.readUnsignedShort();
            int major = in.readUnsignedShort();
            String javaVer = major >= 45
                    ? "Java " + (major == 45 ? "1.1" : major <= 52 ? "1." + (major - 44) : String.valueOf(major - 44))
                    : "v" + major;
            return new BytecodeVersion(major, minor, major + "." + minor + " (" + javaVer + ")");
        } catch (IOException e) {
            return null;
        }
    }

    /**
     * Collects referenced class names across {@code className} and recursively across its nested classes
     * ({@code Outer$Inner}, {@code Outer$Inner$Deep}, {@code Outer$Inner$1}, ...).
     */
    public static List<String> collectReferencedClasses(ClassLoader loader, String className, byte[] classBytes) {
        Set<String> all = new TreeSet<>(constantPoolClasses(classBytes));
        Set<String> scannedInners = new HashSet<>();
        Queue<String> innerQueue = new ArrayDeque<>();
        String outerPrefix = className + "$";
        for (String ref : all) {
            if (ref.startsWith(outerPrefix) && scannedInners.size() < MAX_RECURSIVE_INNERS && scannedInners.add(ref)) {
                innerQueue.add(ref);
            }
        }
        int scanned = 0;
        while (!innerQueue.isEmpty() && scanned < MAX_RECURSIVE_INNERS) {
            String inner = innerQueue.poll();
            scanned++;
            byte[] innerBytes = BytecodeReader.readWithFallback(loader, inner.replace('.', '/') + ".class");
            if (innerBytes == null) {
                continue;
            }
            Set<String> innerRefs = constantPoolClasses(innerBytes);
            all.addAll(innerRefs);
            for (String ref : innerRefs) {
                if (ref.startsWith(outerPrefix) && scannedInners.size() < MAX_RECURSIVE_INNERS && scannedInners.add(ref)) {
                    innerQueue.add(ref);
                }
            }
        }
        return List.copyOf(all);
    }

    /** Collects transitive nested inner-class bytecode entries keyed by internal JVM name (with bytes). */
    public static Map<String, byte[]> collectNestedClassBytes(ClassLoader loader, String className, byte[] classBytes) {
        Map<String, byte[]> nested = new LinkedHashMap<>();
        Queue<byte[]> toScan = new ArrayDeque<>();
        if (classBytes != null) {
            toScan.add(classBytes);
        }
        String prefix = className + "$";
        while (!toScan.isEmpty() && nested.size() < MAX_RECURSIVE_INNERS) {
            byte[] bytes = toScan.poll();
            for (String ref : constantPoolClasses(bytes)) {
                if (ref.startsWith(prefix)) {
                    String internal = ref.replace('.', '/');
                    if (!nested.containsKey(internal)) {
                        byte[] innerBytes = BytecodeReader.readWithFallback(loader, internal + ".class");
                        if (innerBytes != null) {
                            nested.put(internal, innerBytes);
                            toScan.add(innerBytes);
                        }
                        if (nested.size() >= MAX_RECURSIVE_INNERS) {
                            break;
                        }
                    }
                }
            }
        }
        return nested;
    }

    /** Collects transitive nested inner-class FQCNs (delegating to {@link #collectNestedClassBytes}). */
    public static Set<String> collectNestedClassNames(ClassLoader loader, String className, byte[] classBytes) {
        Set<String> names = new TreeSet<>();
        for (String internal : collectNestedClassBytes(loader, className, classBytes).keySet()) {
            names.add(internal.replace('/', '.'));
        }
        return names;
    }

    /**
     * Parses a class file's constant pool and extracts class names referenced by {@code CONSTANT_Class},
     * {@code CONSTANT_NameAndType} descriptors, {@code CONSTANT_MethodType} descriptors, and {@code Signature}
     * / annotation {@code CONSTANT_Utf8} slots — while ignoring plain {@code CONSTANT_String} text literals.
     */
    public static Set<String> constantPoolClasses(byte[] classBytes) {
        Set<String> out = new TreeSet<>();
        if (classBytes == null || classBytes.length < 10) {
            return out;
        }
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(classBytes))) {
            if (in.readInt() != 0xCAFEBABE) {
                return out;
            }
            in.readUnsignedShort(); // minor
            in.readUnsignedShort(); // major
            int count = in.readUnsignedShort();
            String[] utf8 = new String[count];
            boolean[] isStringLiteral = new boolean[count];
            List<Integer> classIndices = new ArrayList<>();
            List<Integer> descriptorOrSigIndices = new ArrayList<>();
            for (int i = 1; i < count; i++) {
                int tag = in.readUnsignedByte();
                switch (tag) {
                    case 1 -> utf8[i] = in.readUTF(); // CONSTANT_Utf8
                    case 3, 4, 9, 10, 11, 17, 18 -> skipFully(in, 4); // Integer, Float, Field/Method/InterfaceMethodref, Dynamic, InvokeDynamic
                    case 5, 6 -> { // Long, Double take 2 slots
                        skipFully(in, 8);
                        i++;
                    }
                    case 7 -> classIndices.add(in.readUnsignedShort()); // CONSTANT_Class
                    case 8 -> { // CONSTANT_String
                        int strUtf8Idx = in.readUnsignedShort();
                        if (strUtf8Idx > 0 && strUtf8Idx < count) {
                            isStringLiteral[strUtf8Idx] = true;
                        }
                    }
                    case 12 -> { // CONSTANT_NameAndType (name_index, descriptor_index)
                        in.readUnsignedShort();
                        descriptorOrSigIndices.add(in.readUnsignedShort());
                    }
                    case 15 -> skipFully(in, 3); // CONSTANT_MethodHandle
                    case 16 -> descriptorOrSigIndices.add(in.readUnsignedShort()); // CONSTANT_MethodType
                    case 19, 20 -> skipFully(in, 2); // Module, Package
                    default -> {
                        return out;
                    }
                }
            }
            for (int idx : classIndices) {
                if (idx > 0 && idx < count && utf8[idx] != null) {
                    addInternalClassName(utf8[idx], out);
                }
            }
            for (int idx : descriptorOrSigIndices) {
                if (idx > 0 && idx < count && utf8[idx] != null) {
                    extractSignatureOrDescriptorClasses(utf8[idx], out);
                }
            }
            // Scan remaining non-String Utf8 entries that look like field/class descriptors or generic Signatures
            // (covers Signature attributes, LocalVariableTypeTable, RuntimeVisibleAnnotations, Record components).
            for (int i = 1; i < count; i++) {
                if (isStringLiteral[i]) {
                    continue;
                }
                String s = utf8[i];
                if (s != null && s.indexOf('L') >= 0 && s.indexOf(';') >= 0 && s.indexOf('/') >= 0
                        && looksLikeJvmTypeOrSignature(s)) {
                    extractSignatureOrDescriptorClasses(s, out);
                }
            }
        } catch (IOException | RuntimeException e) {
            // malformed or partial class file
        }
        return out;
    }

    /** Rejects arbitrary prose / SQL / JSON Utf8 strings that happen to contain L.../...; fragments. */
    private static boolean looksLikeJvmTypeOrSignature(String s) {
        if (s.indexOf(' ') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\t') >= 0) {
            return false;
        }
        return s.startsWith("L") || s.startsWith("(") || s.startsWith("[") || s.startsWith("<");
    }

    private static void addInternalClassName(String internal, Set<String> out) {
        String s = internal;
        while (s.startsWith("[")) {
            s = s.substring(1);
        }
        if (s.startsWith("L") && s.endsWith(";")) {
            s = s.substring(1, s.length() - 1);
        }
        if (s.contains("/")) {
            String fqcn = s.replace('/', '.');
            if (SAFE_CLASS_NAME.matcher(fqcn).matches()) {
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
                    // Skip balanced <...> type arguments cleanly; nested L...; inside args will be visited by outer loop?
                    // Note: we recurse on the inner slice so L...; args AND subsequent .Inner suffixes are both captured!
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
        if (SAFE_CLASS_NAME.matcher(fqcn).matches()) {
            out.add(fqcn);
        }
    }

    private static void skipFully(DataInputStream in, int n) throws IOException {
        int remaining = n;
        while (remaining > 0) {
            int skipped = in.skipBytes(remaining);
            if (skipped <= 0) {
                throw new IOException("Unexpected EOF");
            }
            remaining -= skipped;
        }
    }
}
