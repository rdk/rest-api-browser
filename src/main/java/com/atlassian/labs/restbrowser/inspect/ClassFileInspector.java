package com.atlassian.labs.restbrowser.inspect;

import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;

/**
 * Pure-JDK classfile metadata and constant-pool reference analyzer.
 * <p>
 * Reads JVMS classfile headers, inspects referenced classes, type hierarchies, string/UTF-8 constants, and
 * method call references strictly from compiled bytecode constant pools without loading target classes.
 */
public final class ClassFileInspector {

    public static final Pattern SAFE_CLASS_NAME = Pattern.compile("^[A-Za-z0-9_.$]{1,300}$");
    private static final int MAX_RECURSIVE_INNERS = 64;
    private static final int ACC_INTERFACE = 0x0200;
    private static final int ACC_ABSTRACT = 0x0400;
    private static final int ACC_ANNOTATION = 0x2000;
    private static final int ACC_ENUM = 0x4000;
    private static final Set<String> JVMS_ATTRIBUTES = Set.of(
            "Code", "ConstantValue", "Deprecated", "Exceptions", "InnerClasses", "EnclosingMethod",
            "Synthetic", "Signature", "SourceFile", "SourceDebugExtension", "LineNumberTable",
            "LocalVariableTable", "LocalVariableTypeTable", "RuntimeVisibleAnnotations",
            "RuntimeInvisibleAnnotations", "RuntimeVisibleParameterAnnotations",
            "RuntimeInvisibleParameterAnnotations", "RuntimeVisibleTypeAnnotations",
            "RuntimeInvisibleTypeAnnotations", "AnnotationDefault", "BootstrapMethods",
            "MethodParameters", "Module", "ModulePackages", "ModuleMainClass", "NestHost",
            "NestMembers", "Record", "PermittedSubclasses", "StackMapTable", "<init>", "<clinit>");

    public record BytecodeVersion(int major, int minor, String label) {
    }

    public record ClassHierarchy(String name, String superName, List<String> interfaces, int accessFlags) {
        public boolean isInterface() {
            return (accessFlags & ACC_INTERFACE) != 0;
        }

        public boolean isAbstract() {
            return (accessFlags & ACC_ABSTRACT) != 0;
        }

        public boolean isEnum() {
            return (accessFlags & ACC_ENUM) != 0;
        }

        public boolean isAnnotation() {
            return (accessFlags & ACC_ANNOTATION) != 0;
        }
    }

    public record StringConstant(String value, String kind) {
    }

    public record MethodRef(String owner, String name, String descriptor, boolean interfaceMethod) {
    }

    public record MethodOutline(String name, String descriptor, String signature, int accessFlags,
                                int startLine, int endLine) {
    }

    private ClassFileInspector() {
    }

    /** Normalizes a bundle archive class entry path to a dotted FQCN, or returns {@code null} if non-class/unsafe. */
    public static String bundlePathToClassName(String rawPath) {
        if (rawPath == null || !rawPath.endsWith(".class")) {
            return null;
        }
        String path = rawPath.startsWith("/") ? rawPath.substring(1) : rawPath;
        if (path.startsWith("WEB-INF/classes/")) {
            path = path.substring("WEB-INF/classes/".length());
        }
        if (path.startsWith("META-INF/")
                || path.contains("..")
                || path.endsWith("module-info.class")
                || path.endsWith("package-info.class")) {
            return null;
        }
        String fqcn = path.substring(0, path.length() - ".class".length()).replace('/', '.');
        return !fqcn.contains("..") && !fqcn.startsWith(".") && !fqcn.endsWith(".")
                && SAFE_CLASS_NAME.matcher(fqcn).matches() ? fqcn : null;
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

    private record RawMethodRef(boolean iface, int classIdx, int ntIdx) {
    }

    private record ConstantPool(int count, String[] utf8, boolean[] isStringLiteral, int[] classNameIdx,
                                int[] ntNameIdx, int[] ntDescIdx, List<Integer> classNameIndices,
                                List<Integer> descriptorOrSigIndices, List<RawMethodRef> methodRefs) {
        String utf8At(int idx) {
            return idx > 0 && idx < count ? utf8[idx] : null;
        }

        String classInternalAt(int cpClassIdx) {
            if (cpClassIdx <= 0 || cpClassIdx >= count) {
                return null;
            }
            return utf8At(classNameIdx[cpClassIdx]);
        }
    }

    private static ConstantPool readConstantPool(DataInputStream in) throws IOException {
        if (in.readInt() != 0xCAFEBABE) {
            return null;
        }
        in.readUnsignedShort(); // minor
        in.readUnsignedShort(); // major
        int count = in.readUnsignedShort();
        if (count < 1 || count > 65535) {
            return null;
        }
        String[] utf8 = new String[count];
        boolean[] isStringLiteral = new boolean[count];
        int[] classNameIdx = new int[count];
        int[] ntNameIdx = new int[count];
        int[] ntDescIdx = new int[count];
        List<Integer> classNameIndices = new ArrayList<>();
        List<Integer> descriptorOrSigIndices = new ArrayList<>();
        List<RawMethodRef> methodRefs = new ArrayList<>();
        for (int i = 1; i < count; i++) {
            int tag = in.readUnsignedByte();
            switch (tag) {
                case 1 -> utf8[i] = in.readUTF(); // CONSTANT_Utf8
                case 3, 4, 9, 17, 18 -> skipFully(in, 4); // Integer, Float, Fieldref, Dynamic, InvokeDynamic
                case 5, 6 -> { // Long, Double take 2 slots
                    skipFully(in, 8);
                    i++;
                }
                case 7 -> { // CONSTANT_Class
                    int idx = in.readUnsignedShort();
                    classNameIdx[i] = idx;
                    classNameIndices.add(idx);
                }
                case 8 -> { // CONSTANT_String
                    int strUtf8Idx = in.readUnsignedShort();
                    if (strUtf8Idx > 0 && strUtf8Idx < count) {
                        isStringLiteral[strUtf8Idx] = true;
                    }
                }
                case 10, 11 -> methodRefs.add(new RawMethodRef(tag == 11, in.readUnsignedShort(), in.readUnsignedShort()));
                case 12 -> { // CONSTANT_NameAndType
                    ntNameIdx[i] = in.readUnsignedShort();
                    ntDescIdx[i] = in.readUnsignedShort();
                    descriptorOrSigIndices.add(ntDescIdx[i]);
                }
                case 15 -> skipFully(in, 3); // CONSTANT_MethodHandle
                case 16 -> descriptorOrSigIndices.add(in.readUnsignedShort()); // CONSTANT_MethodType
                case 19, 20 -> skipFully(in, 2); // Module, Package
                default -> {
                    return null;
                }
            }
        }
        return new ConstantPool(count, utf8, isStringLiteral, classNameIdx, ntNameIdx, ntDescIdx,
                classNameIndices, descriptorOrSigIndices, methodRefs);
    }

    /**
     * Reads class access flags, superclass, and implemented interfaces from JVMS classfile headers without loading.
     */
    public static ClassHierarchy readHierarchy(byte[] classBytes) {
        if (classBytes == null || classBytes.length < 24) {
            return null;
        }
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(classBytes))) {
            ConstantPool cp = readConstantPool(in);
            if (cp == null) {
                return null;
            }
            int accessFlags = in.readUnsignedShort();
            String name = ClassFileDescriptorParser.internalToFqcn(cp.classInternalAt(in.readUnsignedShort()));
            if (name == null) {
                return null;
            }
            int superIdx = in.readUnsignedShort();
            String superName = superIdx == 0 ? null : ClassFileDescriptorParser.internalToFqcn(cp.classInternalAt(superIdx));
            int ifaceCount = in.readUnsignedShort();
            List<String> ifaces = new ArrayList<>(Math.min(ifaceCount, 64));
            for (int i = 0; i < ifaceCount; i++) {
                String iface = ClassFileDescriptorParser.internalToFqcn(cp.classInternalAt(in.readUnsignedShort()));
                if (iface != null) {
                    ifaces.add(iface);
                }
            }
            return new ClassHierarchy(name, superName, List.copyOf(ifaces), accessFlags);
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    /**
     * Extracts {@code CONSTANT_String} literals and, optionally, non-descriptor {@code CONSTANT_Utf8} entries from
     * bytecode (capturing annotations such as {@code @Path} and compile-time constants without decompiling).
     */
    public static List<StringConstant> extractStringConstants(byte[] classBytes, boolean includeUtf8) {
        if (classBytes == null || classBytes.length < 10) {
            return List.of();
        }
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(classBytes))) {
            ConstantPool cp = readConstantPool(in);
            if (cp == null) {
                return List.of();
            }
            Map<String, String> found = new LinkedHashMap<>();
            for (int i = 1; i < cp.count(); i++) {
                if (cp.isStringLiteral()[i]) {
                    String s = cp.utf8()[i];
                    if (s != null && !s.isEmpty()) {
                        found.putIfAbsent(s, "string");
                    }
                }
            }
            if (includeUtf8) {
                for (int i = 1; i < cp.count(); i++) {
                    if (cp.isStringLiteral()[i]) {
                        continue;
                    }
                    String s = cp.utf8()[i];
                    if (s == null || s.length() < 2 || s.isBlank() || s.indexOf('\u0000') >= 0
                            || JVMS_ATTRIBUTES.contains(s)
                            || ClassFileDescriptorParser.looksLikeStrictJvmDescriptor(s)) {
                        continue;
                    }
                    found.putIfAbsent(s, "utf8");
                }
            }
            List<StringConstant> list = new ArrayList<>(found.size());
            found.forEach((v, k) -> list.add(new StringConstant(v, k)));
            return List.copyOf(list);
        } catch (IOException | RuntimeException e) {
            return List.of();
        }
    }

    /** Extracts deduplicated {@code Methodref} and {@code InterfaceMethodref} constant-pool entries. */
    public static List<MethodRef> extractMethodRefs(byte[] classBytes) {
        if (classBytes == null || classBytes.length < 10) {
            return List.of();
        }
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(classBytes))) {
            ConstantPool cp = readConstantPool(in);
            if (cp == null) {
                return List.of();
            }
            Set<MethodRef> refs = new LinkedHashSet<>();
            for (RawMethodRef raw : cp.methodRefs()) {
                String owner = ClassFileDescriptorParser.internalToFqcn(cp.classInternalAt(raw.classIdx()));
                if (owner == null || raw.ntIdx() <= 0 || raw.ntIdx() >= cp.count()) {
                    continue;
                }
                String name = cp.utf8At(cp.ntNameIdx()[raw.ntIdx()]);
                String desc = cp.utf8At(cp.ntDescIdx()[raw.ntIdx()]);
                if (name != null && !name.isEmpty() && desc != null) {
                    refs.add(new MethodRef(owner, name, desc, raw.iface()));
                }
            }
        return List.copyOf(refs);
        } catch (IOException | RuntimeException e) {
            return List.of();
        }
    }

    /**
     * Parses declared non-synthetic methods and bytecode {@code LineNumberTable} ranges without loading classes.
     */
    public static List<MethodOutline> readMethodOutlines(byte[] classBytes) {
        ParsedMembers parsed = parseMembers(classBytes, false);
        if (parsed == null) {
            return List.of();
        }
        List<MethodOutline> list = new ArrayList<>(parsed.outlines);
        list.sort((a, b) -> {
            int la = a.startLine() > 0 ? a.startLine() : Integer.MAX_VALUE;
            int lb = b.startLine() > 0 ? b.startLine() : Integer.MAX_VALUE;
            int cmp = Integer.compare(la, lb);
            if (cmp != 0) {
                return cmp;
            }
            cmp = a.name().compareTo(b.name());
            return cmp != 0 ? cmp : a.descriptor().compareTo(b.descriptor());
        });
        return List.copyOf(list);
    }

    /**
     * Classifies direct classfile references into {@code extends}, {@code implements}, {@code field}, and
     * {@code signature} roles from JVMS class, field, and method sections.
     */
    public static Map<String, Set<String>> readTypedReferences(byte[] classBytes) {
        ParsedMembers parsed = parseMembers(classBytes, true);
        if (parsed == null) {
            return Map.of();
        }
        return parsed.typedRefs;
    }

    /**
     * Returns each referenced class (including nested inner classes) mapped to its edge kinds
     * ({@code extends}, {@code implements}, {@code field}, {@code signature}, {@code body}).
     */
    public static Map<String, List<String>> collectTypedReferences(ClassLoader loader, String className, byte[] classBytes) {
        Map<String, Set<String>> structural = readTypedReferences(classBytes);
        List<String> allRefs = collectReferencedClasses(loader, className, classBytes);
        Map<String, List<String>> merged = new LinkedHashMap<>();
        for (String ref : allRefs) {
            Set<String> kinds = structural.get(ref);
            merged.put(ref, kinds != null && !kinds.isEmpty() ? List.copyOf(kinds) : List.of("body"));
        }
        return merged;
    }

    private record ParsedMembers(List<MethodOutline> outlines, Map<String, Set<String>> typedRefs) {
    }

    private static ParsedMembers parseMembers(byte[] classBytes, boolean collectTyped) {
        if (classBytes == null || classBytes.length < 24) {
            return null;
        }
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(classBytes))) {
            ConstantPool cp = readConstantPool(in);
            if (cp == null) {
                return null;
            }
            Map<String, Set<String>> typed = collectTyped ? new LinkedHashMap<>() : Map.of();
            in.readUnsignedShort(); // access_flags
            String selfFqcn = ClassFileDescriptorParser.internalToFqcn(cp.classInternalAt(in.readUnsignedShort()));
            int superIdx = in.readUnsignedShort();
            if (collectTyped && superIdx > 0) {
                String sup = ClassFileDescriptorParser.internalToFqcn(cp.classInternalAt(superIdx));
                if (sup != null && !"java.lang.Object".equals(sup)) {
                    typed.computeIfAbsent(sup, k -> new LinkedHashSet<>()).add("extends");
                }
            }
            int ifaceCount = in.readUnsignedShort();
            for (int i = 0; i < ifaceCount; i++) {
                String iface = ClassFileDescriptorParser.internalToFqcn(cp.classInternalAt(in.readUnsignedShort()));
                if (collectTyped && iface != null) {
                    typed.computeIfAbsent(iface, k -> new LinkedHashSet<>()).add("implements");
                }
            }

            // fields[]
            int fieldCount = in.readUnsignedShort();
            for (int i = 0; i < fieldCount; i++) {
                in.readUnsignedShort(); // access_flags
                in.readUnsignedShort(); // name_index
                String fDesc = cp.utf8At(in.readUnsignedShort());
                if (collectTyped && fDesc != null) {
                    ClassFileDescriptorParser.addTypedFromDescriptor(fDesc, "field", typed);
                }
                int fAttrCount = in.readUnsignedShort();
                for (int a = 0; a < fAttrCount; a++) {
                    String attrName = cp.utf8At(in.readUnsignedShort());
                    int attrLen = in.readInt();
                    if (attrLen < 0) {
                        return null;
                    }
                    if (collectTyped && "Signature".equals(attrName) && attrLen == 2) {
                        String sig = cp.utf8At(in.readUnsignedShort());
                        if (sig != null) {
                            ClassFileDescriptorParser.addTypedFromDescriptor(sig, "field", typed);
                        }
                    } else {
                        skipFully(in, attrLen);
                    }
                }
            }

            // methods[]
            int methodCount = in.readUnsignedShort();
            List<MethodOutline> outlines = new ArrayList<>(Math.min(methodCount, 128));
            for (int i = 0; i < methodCount; i++) {
                int mAccess = in.readUnsignedShort();
                String mName = cp.utf8At(in.readUnsignedShort());
                String mDesc = cp.utf8At(in.readUnsignedShort());
                if (collectTyped && mDesc != null) {
                    ClassFileDescriptorParser.addTypedFromDescriptor(mDesc, "signature", typed);
                }
                int minLine = Integer.MAX_VALUE;
                int maxLine = 0;
                int mAttrCount = in.readUnsignedShort();
                for (int a = 0; a < mAttrCount; a++) {
                    String attrName = cp.utf8At(in.readUnsignedShort());
                    int attrLen = in.readInt();
                    if (attrLen < 0) {
                        return null;
                    }
                    if ("Code".equals(attrName) && attrLen >= 10) {
                        in.readUnsignedShort(); // max_stack
                        in.readUnsignedShort(); // max_locals
                        int codeLen = in.readInt();
                        if (codeLen < 0 || codeLen > attrLen - 8) {
                            return null;
                        }
                        skipFully(in, codeLen);
                        int exCount = in.readUnsignedShort();
                        skipFully(in, exCount * 8);
                        int subCount = in.readUnsignedShort();
                        for (int s = 0; s < subCount; s++) {
                            String subName = cp.utf8At(in.readUnsignedShort());
                            int subLen = in.readInt();
                            if (subLen < 0) {
                                return null;
                            }
                            if ("LineNumberTable".equals(subName) && subLen >= 2) {
                                int lineEntries = in.readUnsignedShort();
                                for (int le = 0; le < lineEntries; le++) {
                                    in.readUnsignedShort(); // start_pc
                                    int lineNo = in.readUnsignedShort();
                                    if (lineNo > 0) {
                                        minLine = Math.min(minLine, lineNo);
                                        maxLine = Math.max(maxLine, lineNo);
                                    }
                                }
                            } else {
                                skipFully(in, subLen);
                            }
                        }
                    } else if (collectTyped && "Signature".equals(attrName) && attrLen == 2) {
                        String sig = cp.utf8At(in.readUnsignedShort());
                        if (sig != null) {
                            ClassFileDescriptorParser.addTypedFromDescriptor(sig, "signature", typed);
                        }
                    } else if (collectTyped && "Exceptions".equals(attrName) && attrLen >= 2) {
                        int exCount = in.readUnsignedShort();
                        for (int e = 0; e < exCount; e++) {
                            String ex = ClassFileDescriptorParser.internalToFqcn(cp.classInternalAt(in.readUnsignedShort()));
                            if (ex != null) {
                                typed.computeIfAbsent(ex, k -> new LinkedHashSet<>()).add("signature");
                            }
                        }
                    } else {
                        skipFully(in, attrLen);
                    }
                }
                boolean synthetic = (mAccess & 0x1000) != 0 || (mAccess & 0x0040) != 0;
                if (!synthetic && mName != null && !"<clinit>".equals(mName) && mDesc != null) {
                    int start = minLine == Integer.MAX_VALUE ? 0 : minLine;
                    outlines.add(new MethodOutline(mName, mDesc, formatMethodSignature(mName, mDesc, selfFqcn),
                            mAccess, start, start == 0 ? 0 : maxLine));
                }
            }
            return new ParsedMembers(outlines, typed);
        } catch (IOException | RuntimeException e) {
            return null;
        }
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
            ConstantPool cp = readConstantPool(in);
            if (cp == null) {
                return out;
            }
            for (int idx : cp.classNameIndices()) {
                String internal = cp.utf8At(idx);
                if (internal != null) {
                    ClassFileDescriptorParser.addInternalClassName(internal, out);
                }
            }
            for (int idx : cp.descriptorOrSigIndices()) {
                String desc = cp.utf8At(idx);
                if (desc != null) {
                    extractSignatureOrDescriptorClasses(desc, out);
                }
            }
            // Scan remaining non-String Utf8 entries that look like field/class descriptors or generic Signatures
            // (covers Signature attributes, LocalVariableTypeTable, RuntimeVisibleAnnotations, Record components).
            for (int i = 1; i < cp.count(); i++) {
                if (cp.isStringLiteral()[i]) {
                    continue;
                }
                String s = cp.utf8()[i];
                if (s != null && s.indexOf('L') >= 0 && s.indexOf(';') >= 0 && s.indexOf('/') >= 0
                        && ClassFileDescriptorParser.looksLikeJvmTypeOrSignature(s)) {
                    extractSignatureOrDescriptorClasses(s, out);
                }
            }
        } catch (IOException | RuntimeException e) {
            // malformed or partial class file
        }
        return out;
    }

    static String formatMethodSignature(String name, String descriptor, String ownerFqcn) {
        return ClassFileDescriptorParser.formatMethodSignature(name, descriptor, ownerFqcn);
    }

    static void extractSignatureOrDescriptorClasses(String descriptor, Set<String> out) {
        ClassFileDescriptorParser.extractSignatureOrDescriptorClasses(descriptor, out);
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
