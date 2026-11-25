package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.JerseyModelSource.Handler;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.labs.restbrowser.catalog.OperationDetails.Result;
import com.atlassian.labs.restbrowser.catalog.SpecSource.SpecException;
import org.benf.cfr.reader.api.CfrDriver;
import org.benf.cfr.reader.api.ClassFileSource;
import org.benf.cfr.reader.api.OutputSinkFactory;
import org.benf.cfr.reader.bytecode.analysis.parse.utils.Pair;
import org.jetbrains.java.decompiler.api.Decompiler;
import org.jetbrains.java.decompiler.main.extern.IContextSource;
import org.jetbrains.java.decompiler.main.extern.IFernflowerLogger;
import org.jetbrains.java.decompiler.main.extern.IFernflowerPreferences;
import org.jetbrains.java.decompiler.main.extern.IResultSaver;
import org.osgi.framework.Bundle;
import org.osgi.framework.BundleContext;
import org.osgi.framework.FrameworkUtil;
import org.osgi.framework.wiring.BundleWiring;

import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import java.util.regex.Pattern;

import static java.util.Objects.requireNonNull;

/**
 * Decompiles the handler method or class of an operation, or any referenced Java class, on demand for system
 * administrators. Supports two embedded decompilers (CFR 0.152 and Vineflower 1.11.1), extracts referenced class
 * names from the bytecode constant pool so the UI can make every class reference clickable, caches only plain
 * strings in a small LRU (never keeping Class, Method or Bundle references), and can be switched off with
 * {@code -Drest.api.browser.decompile=false}.
 */
public class OperationSource {

    public static final String ENABLED_PROPERTY = "rest.api.browser.decompile";
    public static final String DECOMPILER_CFR = "CFR 0.152";
    public static final String DECOMPILER_VINEFLOWER = "Vineflower 1.11.1";
    /** Kept for compatibility with existing callers/tests. */
    public static final String DECOMPILER = DECOMPILER_CFR;
    static final int MAX_CACHE = 96;
    static final int MAX_SOURCE = 200_000;
    private static final int MAX_CANDIDATES = 12;
    private static final Pattern SAFE_CLASS_NAME = Pattern.compile("^[A-Za-z0-9_.$]{1,300}$");

    public enum Engine {
        CFR("cfr", DECOMPILER_CFR),
        VINEFLOWER("vineflower", DECOMPILER_VINEFLOWER);

        final String id;
        final String label;

        Engine(String id, String label) {
            this.id = id;
            this.label = label;
        }

        public static Engine parse(String raw) {
            if (raw != null && ("vineflower".equalsIgnoreCase(raw.trim()) || "vf".equalsIgnoreCase(raw.trim()))) {
                return VINEFLOWER;
            }
            return CFR;
        }
    }

    private record CacheKey(String className, long bundleId, long bundleModified, String scope, String methodName,
                            String signature, Engine engine) {
    }

    private record CachedOutput(String source, List<String> refs) {
    }

    private record ResolvedClass(String name, ClassLoader loader, long bundleId, long bundleModified, byte[] bytes) {
    }

    private final ModuleDiscovery discovery;
    private final Supplier<JerseyModelSource> jersey;
    private final BooleanSupplier enabled;
    private final Map<CacheKey, CachedOutput> cache = Collections.synchronizedMap(
            new LinkedHashMap<>(MAX_CACHE, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<CacheKey, CachedOutput> eldest) {
                    return size() > MAX_CACHE;
                }
            });

    public OperationSource(ModuleDiscovery discovery, Supplier<JerseyModelSource> jersey) {
        this(discovery, jersey, () -> !"false".equalsIgnoreCase(System.getProperty(ENABLED_PROPERTY, "true")));
    }

    OperationSource(ModuleDiscovery discovery, Supplier<JerseyModelSource> jersey, BooleanSupplier enabled) {
        this.discovery = requireNonNull(discovery);
        this.jersey = requireNonNull(jersey);
        this.enabled = requireNonNull(enabled);
    }

    public Result decompile(String key) {
        return decompile(key, null, -1, "method", "cfr");
    }

    public Result decompile(String opKey, String classCandidates, long fromBundleId, String scope, String decompiler) {
        if (!enabled.getAsBoolean()) {
            return error(403, "decompile-disabled");
        }
        Engine engine = Engine.parse(decompiler);
        if (classCandidates != null && !classCandidates.isBlank()) {
            return decompileReferencedClass(opKey, classCandidates, fromBundleId, engine);
        }
        if (opKey == null || opKey.isBlank()) {
            return error(400, "missing-op");
        }
        RestModule module = OperationDetails.moduleOf(discovery.discover(), opKey);
        if (module == null) {
            return error(404, "unknown-module");
        }
        JerseyModelSource source = jersey.get();
        if (source == null || !module.restV2()) {
            return error(404, "not-described");
        }
        Optional<Handler> handler;
        try {
            handler = source.handler(module, opKey);
        } catch (SpecException e) {
            return error(503, e.reason());
        }
        if (handler.isEmpty() || handler.get().handling() == null) {
            return error(404, "unknown-operation");
        }
        boolean wholeClass = "class".equalsIgnoreCase(scope);
        return wholeClass
                ? decompileClass(opKey, handler.get().handling().getDeclaringClass(), engine)
                : decompileMethod(opKey, handler.get().handling(), engine);
    }

    Result decompileMethod(String key, Method method) {
        return decompileMethod(key, method, Engine.CFR);
    }

    Result decompileMethod(String key, Method method, Engine engine) {
        Class<?> target = targetClass(method.getDeclaringClass());
        ResolvedClass resolved = resolveLoaded(target);
        if (resolved == null) {
            return error(404, "class-not-found");
        }
        return runAndFormat(key, resolved, "method", method.getName(), method.toGenericString(), engine);
    }

    Result decompileClass(String key, Class<?> cls, Engine engine) {
        Class<?> target = targetClass(cls);
        ResolvedClass resolved = resolveLoaded(target);
        if (resolved == null) {
            return error(404, "class-not-found");
        }
        return runAndFormat(key, resolved, "class", null, null, engine);
    }

    private Result decompileReferencedClass(String opKey, String rawCandidates, long fromBundleId, Engine engine) {
        List<String> candidates = parseCandidates(rawCandidates);
        if (candidates.isEmpty()) {
            return error(400, "invalid-class");
        }
        List<ClassLoader> loaders = contextLoaders(opKey, fromBundleId);
        ResolvedClass resolved = resolveFromCandidates(candidates, loaders);
        if (resolved == null) {
            return error(404, "class-not-found");
        }
        return runAndFormat(opKey, resolved, "class", null, null, engine);
    }

    private Result runAndFormat(String key, ResolvedClass resolved, String scope, String methodName,
                                String signature, Engine engine) {
        String internalPath = resolved.name().replace('.', '/') + ".class";
        CacheKey cacheKey = new CacheKey(resolved.name(), resolved.bundleId(), resolved.bundleModified(),
                scope, methodName, signature, engine);
        CachedOutput cached = cache.get(cacheKey);
        if (cached == null) {
            String text;
            try {
                text = engine == Engine.VINEFLOWER
                        ? runVineflower(resolved.loader(), resolved.name(), resolved.bytes(),
                                "method".equals(scope) ? methodName : null)
                        : runCfr(resolved.loader(), internalPath,
                                "method".equals(scope) ? methodName : null);
            } catch (RuntimeException | LinkageError e) {
                return error(500, "decompile-failed");
            }
            if (text == null || text.isBlank()) {
                return error(404, "class-not-found");
            }
            List<String> refs = collectReferencedClasses(resolved.loader(), resolved.name(), resolved.bytes());
            cached = new CachedOutput(text, refs);
            cache.put(cacheKey, cached);
        }
        Json j = new Json().beginObject()
                .field("format", 1)
                .optional("key", key)
                .field("class", resolved.name())
                .optional("method", methodName)
                .field("scope", scope)
                .field("decompilerId", engine.id)
                .field("decompiler", engine.label)
                .field("bundleId", resolved.bundleId())
                .field("source", cached.source())
                .strings("refs", cached.refs())
                .endObject();
        return new Result(200, j.toString());
    }

    // ---- class & loader resolution

    static List<String> parseCandidates(String raw) {
        if (raw == null) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (String part : raw.split(",")) {
            String name = part.trim();
            if (name.isEmpty() || name.contains("..") || !SAFE_CLASS_NAME.matcher(name).matches()) {
                continue;
            }
            out.add(name);
            if (out.size() >= MAX_CANDIDATES) {
                break;
            }
        }
        return out;
    }

    private List<ClassLoader> contextLoaders(String opKey, long fromBundleId) {
        Set<ClassLoader> loaders = new LinkedHashSet<>();
        if (fromBundleId >= 0) {
            ClassLoader bLoader = bundleClassLoader(fromBundleId);
            if (bLoader != null) {
                loaders.add(bLoader);
            }
        }
        if (opKey != null && !opKey.isBlank()) {
            RestModule module = OperationDetails.moduleOf(discovery.discover(), opKey);
            JerseyModelSource src = jersey.get();
            if (module != null && src != null && module.restV2()) {
                try {
                    Optional<Handler> h = src.handler(module, opKey);
                    if (h.isPresent() && h.get().handling() != null) {
                        ClassLoader l = targetClass(h.get().handling().getDeclaringClass()).getClassLoader();
                        if (l != null) {
                            loaders.add(l);
                        }
                    }
                } catch (SpecException | RuntimeException | LinkageError e) {
                    // best effort
                }
            }
        }
        ClassLoader tccl = Thread.currentThread().getContextClassLoader();
        if (tccl != null) {
            loaders.add(tccl);
        }
        ClassLoader own = OperationSource.class.getClassLoader();
        if (own != null) {
            loaders.add(own);
        }
        return new ArrayList<>(loaders);
    }

    private static ClassLoader bundleClassLoader(long bundleId) {
        try {
            Bundle self = FrameworkUtil.getBundle(OperationSource.class);
            BundleContext ctx = self == null ? null : self.getBundleContext();
            Bundle b = ctx == null ? null : ctx.getBundle(bundleId);
            BundleWiring wiring = b == null ? null : b.adapt(BundleWiring.class);
            return wiring == null ? null : wiring.getClassLoader();
        } catch (RuntimeException | LinkageError e) {
            return null;
        }
    }

    private ResolvedClass resolveFromCandidates(List<String> candidates, List<ClassLoader> loaders) {
        // 1. Try loading through context classloaders (follows OSGi package wires cleanly)
        for (String cand : candidates) {
            for (String variant : nestedVariants(cand)) {
                for (ClassLoader loader : loaders) {
                    ResolvedClass r = tryLoad(loader, variant);
                    if (r != null) {
                        return r;
                    }
                }
            }
        }
        // 2. Try direct resource lookup (including JDK / system classes)
        for (String cand : candidates) {
            for (String variant : nestedVariants(cand)) {
                String path = variant.replace('.', '/') + ".class";
                for (ClassLoader loader : loaders) {
                    byte[] bytes = readResource(loader, path);
                    if (bytes != null) {
                        return new ResolvedClass(variant, loader, -1, 0, bytes);
                    }
                }
                byte[] sys = readResource(null, path);
                if (sys != null) {
                    return new ResolvedClass(variant, null, -1, 0, sys);
                }
            }
        }
        // 3. Fallback: scan active OSGi bundles for classes not wired to the starting bundle
        try {
            Bundle self = FrameworkUtil.getBundle(OperationSource.class);
            BundleContext ctx = self == null ? null : self.getBundleContext();
            if (ctx != null) {
                for (String cand : candidates) {
                    for (String variant : nestedVariants(cand)) {
                        String path = variant.replace('.', '/') + ".class";
                        for (Bundle b : ctx.getBundles()) {
                            if (b.getState() != Bundle.ACTIVE && b.getState() != Bundle.RESOLVED) {
                                continue;
                            }
                            if (b.getEntry(path) == null) {
                                continue;
                            }
                            BundleWiring w = b.adapt(BundleWiring.class);
                            ClassLoader cl = w == null ? null : w.getClassLoader();
                            byte[] bytes = readResource(cl, path);
                            if (bytes != null) {
                                return new ResolvedClass(variant, cl, b.getBundleId(), b.getLastModified(), bytes);
                            }
                        }
                    }
                }
            }
        } catch (RuntimeException | LinkageError e) {
            // outside OSGi
        }
        return null;
    }

    /** Generates nested-class variants: "a.b.Outer.Inner" -> ["a.b.Outer.Inner", "a.b.Outer$Inner"]. */
    static List<String> nestedVariants(String name) {
        List<String> out = new ArrayList<>();
        out.add(name);
        String cur = name;
        for (int i = 0; i < 3; i++) {
            int dot = cur.lastIndexOf('.');
            if (dot <= 0) {
                break;
            }
            cur = cur.substring(0, dot) + '$' + cur.substring(dot + 1);
            out.add(cur);
        }
        return out;
    }

    private static ResolvedClass tryLoad(ClassLoader loader, String name) {
        try {
            Class<?> c = Class.forName(name, false, loader);
            return resolveLoaded(targetClass(c));
        } catch (ClassNotFoundException | LinkageError | RuntimeException e) {
            return null;
        }
    }

    private static ResolvedClass resolveLoaded(Class<?> target) {
        String path = target.getName().replace('.', '/') + ".class";
        ClassLoader loader = target.getClassLoader();
        byte[] bytes = readResource(loader, path);
        if (bytes == null) {
            return null;
        }
        long bundleId = -1;
        long modified = 0;
        try {
            Bundle b = FrameworkUtil.getBundle(target);
            if (b != null) {
                bundleId = b.getBundleId();
                modified = b.getLastModified();
            }
        } catch (RuntimeException | LinkageError e) {
            // outside OSGi
        }
        return new ResolvedClass(target.getName(), loader, bundleId, modified, bytes);
    }

    /** Unwraps generated subclasses such as Spring CGLIB proxies to the real declaring class. */
    static Class<?> targetClass(Class<?> cls) {
        Class<?> c = cls;
        while (c != null && c.getName().contains("$$") && c.getSuperclass() != null
                && c.getSuperclass() != Object.class) {
            c = c.getSuperclass();
        }
        return c == null ? cls : c;
    }

    private static boolean resourceExists(ClassLoader loader, String path) {
        try (InputStream in = openResource(loader, path)) {
            return in != null;
        } catch (IOException e) {
            return false;
        }
    }

    private static byte[] readResource(ClassLoader loader, String path) {
        try (InputStream in = openResource(loader, path)) {
            return in == null ? null : in.readAllBytes();
        } catch (IOException e) {
            return null;
        }
    }

    private static InputStream openResource(ClassLoader loader, String path) {
        InputStream in = loader == null ? null : loader.getResourceAsStream(path);
        if (in != null) {
            return in;
        }
        in = ClassLoader.getSystemResourceAsStream(path);
        if (in != null) {
            return in;
        }
        return Object.class.getResourceAsStream("/" + path);
    }

    // ---- CFR decompiler

    static String runCfr(ClassLoader loader, String internalClassPath, String methodName) {
        String out = invokeCfr(loader, internalClassPath, methodName);
        if (out == null || out.isBlank()) {
            out = invokeCfr(loader, internalClassPath, null);
        }
        return cleanSource(out);
    }

    private static String invokeCfr(ClassLoader loader, String internalClassPath, String methodName) {
        StringBuilder out = new StringBuilder();
        ClassFileSource source = new ClassFileSource() {
            @Override
            public void informAnalysisRelativePathDetail(String usePath, String classFilePath) {
            }

            @Override
            public Collection<String> addJar(String jarPath) {
                return Collections.emptyList();
            }

            @Override
            public String getPossiblyRenamedPath(String path) {
                return path;
            }

            @Override
            public Pair<byte[], String> getClassFileContent(String path) throws IOException {
                byte[] bytes = readResource(loader, path);
                if (bytes == null) {
                    throw new FileNotFoundException(path);
                }
                return Pair.make(bytes, path);
            }
        };
        OutputSinkFactory sink = new OutputSinkFactory() {
            @Override
            public List<SinkClass> getSupportedSinks(SinkType sinkType, Collection<SinkClass> available) {
                return sinkType == SinkType.JAVA ? List.of(SinkClass.STRING) : Collections.emptyList();
            }

            @Override
            public <T> Sink<T> getSink(SinkType sinkType, SinkClass sinkClass) {
                if (sinkType == SinkType.JAVA && sinkClass == SinkClass.STRING) {
                    return s -> out.append(s);
                }
                return ignored -> { };
            }
        };
        Map<String, String> options = new LinkedHashMap<>();
        options.put("showversion", "false");
        options.put("hideutf", "false");
        options.put("silent", "true");
        if (methodName != null && !methodName.isBlank()) {
            options.put("methodname", methodName);
        }
        CfrDriver driver = new CfrDriver.Builder()
                .withClassFileSource(source)
                .withOutputSink(sink)
                .withOptions(options)
                .build();
        driver.analyse(List.of(internalClassPath));
        return out.toString();
    }

    // ---- Vineflower decompiler

    static String runVineflower(ClassLoader loader, String className, byte[] classBytes, String methodName) {
        String internalBase = className.replace('.', '/');
        Map<String, byte[]> inputClasses = new LinkedHashMap<>();
        inputClasses.put(internalBase, classBytes);
        // include inner/anonymous classes so Vineflower decompiles them inline
        for (String ref : constantPoolClasses(classBytes)) {
            if (ref.startsWith(className + "$")) {
                String innerBase = ref.replace('.', '/');
                if (!inputClasses.containsKey(innerBase)) {
                    byte[] innerBytes = readResource(loader, innerBase + ".class");
                    if (innerBytes != null) {
                        inputClasses.put(innerBase, innerBytes);
                    }
                }
            }
        }
        StringBuilder out = new StringBuilder();
        IContextSource input = new IContextSource() {
            @Override
            public String getName() {
                return "memory";
            }

            @Override
            public Entries getEntries() {
                List<Entry> list = new ArrayList<>(inputClasses.size());
                for (String base : inputClasses.keySet()) {
                    list.add(Entry.atBase(base));
                }
                return new Entries(list, List.of(), List.of());
            }

            @Override
            public InputStream getInputStream(String resource) throws IOException {
                String base = resource.endsWith(CLASS_SUFFIX)
                        ? resource.substring(0, resource.length() - CLASS_SUFFIX.length())
                        : resource;
                byte[] b = inputClasses.get(base);
                if (b != null) {
                    return new ByteArrayInputStream(b);
                }
                InputStream in = openResource(loader, resource);
                if (in == null) {
                    throw new FileNotFoundException(resource);
                }
                return in;
            }

            @Override
            public IOutputSink createOutputSink(IResultSaver saver) {
                return new IOutputSink() {
                    @Override
                    public void begin() {
                    }

                    @Override
                    public void acceptClass(String qualifiedName, String fileName, String content, int[] mapping) {
                        if (content != null && (internalBase.equals(qualifiedName) || out.isEmpty())) {
                            out.setLength(0);
                            out.append(content);
                        }
                    }

                    @Override
                    public void acceptDirectory(String directory) {
                    }

                    @Override
                    public void acceptOther(String path) {
                    }

                    @Override
                    public void close() {
                    }
                };
            }
        };
        IContextSource libs = new IContextSource() {
            @Override
            public String getName() {
                return "classpath";
            }

            @Override
            public Entries getEntries() {
                return Entries.EMPTY;
            }

            @Override
            public boolean isLazy() {
                return true;
            }

            @Override
            public boolean hasClass(String path) {
                return resourceExists(loader, path.endsWith(CLASS_SUFFIX) ? path : path + CLASS_SUFFIX);
            }

            @Override
            public InputStream getInputStream(String resource) throws IOException {
                InputStream in = openResource(loader, resource);
                if (in == null) {
                    throw new FileNotFoundException(resource);
                }
                return in;
            }
        };
        IResultSaver noOpSaver = new IResultSaver() {
            @Override public void saveFolder(String path) {}
            @Override public void copyFile(String source, String path, String entryName) {}
            @Override public void saveClassFile(String path, String qualifiedName, String entryName, String content, int[] mapping) {
                if (content != null && (internalBase.equals(qualifiedName) || out.isEmpty())) {
                    out.setLength(0);
                    out.append(content);
                }
            }
            @Override public void createArchive(String path, String archiveName, java.util.jar.Manifest manifest) {}
            @Override public void saveDirEntry(String path, String archiveName, String entryName) {}
            @Override public void copyEntry(String source, String path, String archiveName, String entryName) {}
            @Override public void saveClassEntry(String path, String archiveName, String qualifiedName, String entryName, String content) {
                saveClassFile(path, qualifiedName, entryName, content, null);
            }
            @Override public void closeArchive(String path, String archiveName) {}
        };
        Decompiler.builder()
                .inputs(input)
                .libraries(libs)
                .output(noOpSaver)
                .logger(IFernflowerLogger.NO_OP)
                .option(IFernflowerPreferences.DECOMPILE_GENERIC_SIGNATURES, "1")
                .option(IFernflowerPreferences.INDENT_STRING, "    ")
                .option(IFernflowerPreferences.INCLUDE_JAVA_RUNTIME, "0")
                .option("thr", "1")
                .build()
                .decompile();
        String full = cleanSource(out.toString());
        if (full == null) {
            return null;
        }
        if (methodName != null && !methodName.isBlank()) {
            String extracted = extractMethod(full, methodName);
            if (extracted != null) {
                return extracted;
            }
        }
        return full;
    }

    /**
     * Extracts method declaration(s) with the given name (including preceding annotations and balanced body) from a
     * decompiled class. Falls back to null when no clean match is found so the caller shows the whole class.
     */
    static String extractMethod(String classSource, String methodName) {
        String[] lines = classSource.split("\n", -1);
        Pattern sig = Pattern.compile("^\\s{2,8}(?:(?:public|protected|private|static|final|abstract|synchronized|native|default)\\s+)*"
                + "(?:<[^>]+>\\s+)?[\\w$.<>?, \\[\\]]+\\s+" + Pattern.quote(methodName) + "\\s*\\(");
        List<String> blocks = new ArrayList<>();
        int i = 0;
        while (i < lines.length) {
            if (!sig.matcher(lines[i]).find()) {
                i++;
                continue;
            }
            int start = i;
            // walk back to include annotations directly above the method
            while (start > 0 && lines[start - 1].trim().startsWith("@")) {
                start--;
            }
            int end = findMethodEnd(lines, i);
            if (end < i) {
                i++;
                continue;
            }
            StringBuilder block = new StringBuilder();
            int commonIndent = leadingSpaces(lines[i]);
            for (int k = start; k <= end; k++) {
                String line = lines[k];
                if (line.length() >= commonIndent && line.substring(0, commonIndent).isBlank()) {
                    line = line.substring(commonIndent);
                }
                if (block.length() > 0) {
                    block.append('\n');
                }
                block.append(line);
            }
            blocks.add(block.toString());
            i = end + 1;
        }
        return blocks.isEmpty() ? null : String.join("\n\n", blocks);
    }

    private static int findMethodEnd(String[] lines, int startLine) {
        int depth = 0;
        boolean seenBrace = false;
        boolean inBlockComment = false;
        for (int i = startLine; i < lines.length; i++) {
            String line = lines[i];
            boolean inStr = false;
            boolean inChr = false;
            for (int c = 0; c < line.length(); c++) {
                char ch = line.charAt(c);
                char next = c + 1 < line.length() ? line.charAt(c + 1) : 0;
                if (inBlockComment) {
                    if (ch == '*' && next == '/') {
                        inBlockComment = false;
                        c++;
                    }
                    continue;
                }
                if (inStr) {
                    if (ch == '\\') {
                        c++;
                    } else if (ch == '"') {
                        inStr = false;
                    }
                    continue;
                }
                if (inChr) {
                    if (ch == '\\') {
                        c++;
                    } else if (ch == '\'') {
                        inChr = false;
                    }
                    continue;
                }
                if (ch == '/' && next == '/') {
                    break;
                }
                if (ch == '/' && next == '*') {
                    inBlockComment = true;
                    c++;
                    continue;
                }
                if (ch == '"') {
                    inStr = true;
                } else if (ch == '\'') {
                    inChr = true;
                } else if (ch == '{') {
                    depth++;
                    seenBrace = true;
                } else if (ch == '}') {
                    depth--;
                    if (seenBrace && depth == 0) {
                        return i;
                    }
                } else if (ch == ';' && !seenBrace && depth == 0) {
                    // abstract or interface method
                    return i;
                }
            }
        }
        return -1;
    }

    private static int leadingSpaces(String s) {
        int n = 0;
        while (n < s.length() && s.charAt(n) == ' ') {
            n++;
        }
        return n;
    }

    // ---- bytecode constant pool class reference extractor

    private static List<String> collectReferencedClasses(ClassLoader loader, String className, byte[] classBytes) {
        Set<String> all = new TreeSet<>(constantPoolClasses(classBytes));
        // include references from direct inner classes too so clicking a class inside a lambda/anonymous class works
        List<String> inners = all.stream().filter(n -> n.startsWith(className + "$")).toList();
        for (String inner : inners) {
            byte[] innerBytes = readResource(loader, inner.replace('.', '/') + ".class");
            if (innerBytes != null) {
                all.addAll(constantPoolClasses(innerBytes));
            }
        }
        return List.copyOf(all);
    }

    /**
     * Reads every CONSTANT_Class entry (and class names inside field/method descriptors and annotations) from a JVM
     * class file's constant pool so the UI knows the exact FQCN of every type referenced in the decompiled source.
     */
    static Set<String> constantPoolClasses(byte[] classBytes) {
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
            List<Integer> classIndices = new ArrayList<>();
            for (int i = 1; i < count; i++) {
                int tag = in.readUnsignedByte();
                switch (tag) {
                    case 1 -> utf8[i] = in.readUTF();
                    case 3, 4, 9, 10, 11, 12, 17, 18 -> skipFully(in, 4);
                    case 5, 6 -> {
                        skipFully(in, 8);
                        i++; // 8-byte constants occupy two slots
                    }
                    case 7 -> classIndices.add(in.readUnsignedShort());
                    case 8, 16, 19, 20 -> skipFully(in, 2);
                    case 15 -> skipFully(in, 3);
                    default -> {
                        return out; // unknown future tag: stop safely with what we have
                    }
                }
            }
            for (int idx : classIndices) {
                if (idx > 0 && idx < count && utf8[idx] != null) {
                    addInternalClassName(utf8[idx], out);
                }
            }
            // descriptors & annotation type strings (e.g. "Lcom/example/Foo;") also carry annotation & generic types
            for (int i = 1; i < count; i++) {
                String s = utf8[i];
                if (s != null && s.indexOf('L') >= 0 && s.indexOf(';') >= 0 && s.indexOf('/') >= 0) {
                    extractDescriptorClasses(s, out);
                }
            }
        } catch (IOException | RuntimeException e) {
            // malformed or partial class file: return whatever we collected
        }
        return out;
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

    private static void extractDescriptorClasses(String descriptor, Set<String> out) {
        int len = descriptor.length();
        for (int i = 0; i < len; i++) {
            if (descriptor.charAt(i) != 'L') {
                continue;
            }
            int end = i + 1;
            boolean hasSlash = false;
            boolean valid = true;
            while (end < len) {
                char c = descriptor.charAt(end);
                if (c == ';') {
                    break;
                }
                if (c == '/') {
                    hasSlash = true;
                } else if (!Character.isJavaIdentifierPart(c) && c != '$') {
                    valid = false;
                    break;
                }
                end++;
            }
            if (valid && hasSlash && end < len && descriptor.charAt(end) == ';') {
                String fqcn = descriptor.substring(i + 1, end).replace('/', '.');
                if (SAFE_CLASS_NAME.matcher(fqcn).matches()) {
                    out.add(fqcn);
                }
                i = end;
            }
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

    static String cleanSource(String raw) {
        if (raw == null) {
            return null;
        }
        String s = raw.replace("\r\n", "\n").replace('\r', '\n');
        if (s.startsWith("/*\n * Decompiled with CFR")) {
            int end = s.indexOf("*/");
            if (end > 0) {
                s = s.substring(end + 2);
            }
        }
        s = s.strip();
        if (s.isEmpty()) {
            return null;
        }
        if (s.length() > MAX_SOURCE) {
            return OperationDetails.cut(s, MAX_SOURCE);
        }
        return s;
    }

    private static Result error(int status, String reason) {
        return new Result(status, new Json().beginObject().field("error", reason).endObject().toString());
    }
}
