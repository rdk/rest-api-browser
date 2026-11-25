package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.JerseyModelSource.Handler;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.labs.restbrowser.catalog.OperationDetails.Result;
import com.atlassian.labs.restbrowser.catalog.SpecSource.SpecException;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.plugin.PluginInformation;
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
import org.osgi.framework.wiring.BundleCapability;
import org.osgi.framework.wiring.BundleRevision;
import org.osgi.framework.wiring.BundleWire;
import org.osgi.framework.wiring.BundleWiring;

import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Type;
import java.net.URL;
import java.security.CodeSource;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.Dictionary;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Queue;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import java.util.regex.Pattern;

import static java.util.Objects.requireNonNull;

/**
 * Decompiles the handler method or class of an operation, or any referenced Java class, on demand for system
 * administrators, and provides rich class/OSGi/plugin inspection and reference-graph traversal.
 * <p>
 * Supports two embedded decompilers (CFR 0.152 and Vineflower 1.11.1), extracts referenced class names from the
 * bytecode constant pool, caches only plain strings/records in small LRUs (never retaining Class, Method, Bundle or
 * Plugin references), and can be switched off with {@code -Drest.api.browser.decompile=false}.
 */
public class OperationSource {

    public static final String ENABLED_PROPERTY = "rest.api.browser.decompile";
    public static final String DECOMPILER_CFR = "CFR 0.152";
    public static final String DECOMPILER_VINEFLOWER = "Vineflower 1.11.1";
    /** Kept for compatibility with existing callers/tests. */
    public static final String DECOMPILER = DECOMPILER_CFR;
    static final int MAX_CACHE = 96;
    static final int MAX_INSPECT_CACHE = 128;
    static final int MAX_SOURCE = 200_000;
    private static final int MAX_CANDIDATES = 12;
    private static final int MAX_METHOD_SUMMARIES = 80;
    private static final int MAX_INNER_CLASSES = 40;
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

    private record CachedOutput(String source, List<String> refs, int totalLines, int methodLine) {
    }

    private record InspectKey(String className, long bundleId, long bundleModified) {
    }

    private record ResolvedClass(String name, Class<?> loaded, ClassLoader loader, long bundleId, long bundleModified,
                                 byte[] bytes) {
    }

    private final ModuleDiscovery discovery;
    private final Supplier<JerseyModelSource> jersey;
    private final BooleanSupplier enabled;
    private final PluginAccessor pluginAccessor;
    private final ProductAdapter product;

    private final Map<CacheKey, CachedOutput> cache = Collections.synchronizedMap(
            new LinkedHashMap<>(MAX_CACHE, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<CacheKey, CachedOutput> eldest) {
                    return size() > MAX_CACHE;
                }
            });

    private final Map<InspectKey, String> inspectCache = Collections.synchronizedMap(
            new LinkedHashMap<>(MAX_INSPECT_CACHE, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<InspectKey, String> eldest) {
                    return size() > MAX_INSPECT_CACHE;
                }
            });

    public OperationSource(ModuleDiscovery discovery, Supplier<JerseyModelSource> jersey) {
        this(discovery, jersey, null, null, () -> !"false".equalsIgnoreCase(System.getProperty(ENABLED_PROPERTY, "true")));
    }

    public OperationSource(ModuleDiscovery discovery, Supplier<JerseyModelSource> jersey,
                           PluginAccessor pluginAccessor, ProductAdapter product) {
        this(discovery, jersey, pluginAccessor, product,
                () -> !"false".equalsIgnoreCase(System.getProperty(ENABLED_PROPERTY, "true")));
    }

    OperationSource(ModuleDiscovery discovery, Supplier<JerseyModelSource> jersey, BooleanSupplier enabled) {
        this(discovery, jersey, null, null, enabled);
    }

    OperationSource(ModuleDiscovery discovery, Supplier<JerseyModelSource> jersey,
                    PluginAccessor pluginAccessor, ProductAdapter product, BooleanSupplier enabled) {
        this.discovery = requireNonNull(discovery);
        this.jersey = requireNonNull(jersey);
        this.pluginAccessor = pluginAccessor;
        this.product = product;
        this.enabled = requireNonNull(enabled);
    }

    public boolean isEnabled() {
        return enabled.getAsBoolean();
    }

    public Result decompile(String key) {
        return decompile(key, null, -1, "method", "cfr");
    }

    public Result decompile(String opKey, String classCandidates, long fromBundleId, String scope, String decompiler) {
        return decompile(opKey, classCandidates, fromBundleId, scope, decompiler, null, null, null, false);
    }

    public Result decompile(String opKey, String classCandidates, long fromBundleId, String scope, String decompiler,
                            String methodFilter, Integer startLine, Integer maxLines, boolean includeMeta) {
        if (!enabled.getAsBoolean()) {
            return error(403, "decompile-disabled");
        }
        Engine engine = Engine.parse(decompiler);
        if (classCandidates != null && !classCandidates.isBlank()) {
            return decompileReferencedClass(opKey, classCandidates, fromBundleId, scope, methodFilter, engine,
                    startLine, maxLines, includeMeta);
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
        Method handling = handler.get().handling();
        boolean wholeClass = "class".equalsIgnoreCase(scope);
        String targetMethod = methodFilter != null && !methodFilter.isBlank() ? methodFilter.trim() : handling.getName();
        Class<?> target = targetClass(handling.getDeclaringClass());
        ResolvedClass resolved = resolveLoaded(target);
        if (resolved == null) {
            return error(404, "class-not-found");
        }
        return runAndFormat(opKey, resolved, wholeClass ? "class" : "method", targetMethod,
                wholeClass ? null : handling.toGenericString(), engine, startLine, maxLines, includeMeta);
    }

    /** Returns plain text decompiled source (for agents requesting {@code format=text} or {@code Accept: text/plain}). */
    public Result decompileText(String opKey, String classCandidates, long fromBundleId, String scope,
                                String decompiler, String methodFilter, Integer startLine, Integer maxLines) {
        if (!enabled.getAsBoolean()) {
            return error(403, "decompile-disabled");
        }
        Engine engine = Engine.parse(decompiler);
        ResolvedClass resolved;
        String targetMethod = methodFilter != null && !methodFilter.isBlank() ? methodFilter.trim() : null;
        String resolvedScope;
        if (classCandidates != null && !classCandidates.isBlank()) {
            List<String> candidates = parseCandidates(classCandidates);
            if (candidates.isEmpty()) {
                return error(400, "invalid-class");
            }
            resolved = resolveFromCandidates(candidates, contextLoaders(opKey, fromBundleId));
            if (resolved == null) {
                return error(404, "class-not-found");
            }
            resolvedScope = ("method".equalsIgnoreCase(scope) && targetMethod != null) ? "method" : "class";
        } else {
            if (opKey == null || opKey.isBlank()) {
                return error(400, "missing-op");
            }
            Handler h = findHandler(opKey);
            if (h == null || h.handling() == null) {
                return error(404, "unknown-operation");
            }
            resolved = resolveLoaded(targetClass(h.handling().getDeclaringClass()));
            if (resolved == null) {
                return error(404, "class-not-found");
            }
            if (targetMethod == null) {
                targetMethod = h.handling().getName();
            }
            resolvedScope = "class".equalsIgnoreCase(scope) ? "class" : "method";
        }
        CachedOutput out = decompileCached(resolved, resolvedScope, targetMethod, null, engine, new long[1], new boolean[1]);
        if (out == null) {
            return error(404, "class-not-found");
        }
        Slice slice = sliceLines(out.source(), startLine, maxLines);
        return new Result(200, slice.text());
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
        return runAndFormat(key, resolved, "method", method.getName(), method.toGenericString(), engine,
                null, null, false);
    }

    Result decompileClass(String key, Class<?> cls, Engine engine) {
        Class<?> target = targetClass(cls);
        ResolvedClass resolved = resolveLoaded(target);
        if (resolved == null) {
            return error(404, "class-not-found");
        }
        return runAndFormat(key, resolved, "class", null, null, engine, null, null, false);
    }

    private Result decompileReferencedClass(String opKey, String rawCandidates, long fromBundleId, String scope,
                                            String methodFilter, Engine engine, Integer startLine, Integer maxLines,
                                            boolean includeMeta) {
        List<String> candidates = parseCandidates(rawCandidates);
        if (candidates.isEmpty()) {
            return error(400, "invalid-class");
        }
        List<ClassLoader> loaders = contextLoaders(opKey, fromBundleId);
        ResolvedClass resolved = resolveFromCandidates(candidates, loaders);
        if (resolved == null) {
            return error(404, "class-not-found");
        }
        String targetMethod = methodFilter != null && !methodFilter.isBlank() ? methodFilter.trim() : null;
        String resolvedScope = ("method".equalsIgnoreCase(scope) && targetMethod != null) ? "method" : "class";
        return runAndFormat(opKey, resolved, resolvedScope, targetMethod, null, engine, startLine, maxLines, includeMeta);
    }

    private Result runAndFormat(String key, ResolvedClass resolved, String scope, String methodName,
                                String signature, Engine engine, Integer startLine, Integer maxLines,
                                boolean includeMeta) {
        long[] elapsed = new long[1];
        boolean[] fromCache = new boolean[1];
        CachedOutput cached;
        try {
            cached = decompileCached(resolved, scope, methodName, signature, engine, elapsed, fromCache);
        } catch (RuntimeException | LinkageError e) {
            return error(500, "decompile-failed");
        }
        if (cached == null) {
            return error(404, "class-not-found");
        }
        Slice slice = sliceLines(cached.source(), startLine, maxLines);
        int methodLine = cached.methodLine();
        if (methodLine <= 0 && methodName != null && !methodName.isBlank()) {
            methodLine = findMethodLine(cached.source(), methodName);
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
                .field("totalLines", cached.totalLines())
                .field("startLine", slice.startLine())
                .field("endLine", slice.endLine())
                .field("truncated", slice.truncated());
        if (methodLine > 0) {
            j.field("methodLine", methodLine);
        }
        j.field("decompileMs", elapsed[0])
                .field("cached", fromCache[0])
                .field("source", slice.text())
                .strings("refs", cached.refs());
        if (includeMeta) {
            j.name("meta").raw(buildClassInfoJson(resolved, new long[1], new boolean[1]));
        }
        j.endObject();
        return new Result(200, j.toString());
    }

    private CachedOutput decompileCached(ResolvedClass resolved, String scope, String methodName, String signature,
                                         Engine engine, long[] elapsedMs, boolean[] fromCache) {
        String internalPath = resolved.name().replace('.', '/') + ".class";
        CacheKey cacheKey = new CacheKey(resolved.name(), resolved.bundleId(), resolved.bundleModified(),
                scope, "method".equals(scope) ? methodName : null, "method".equals(scope) ? signature : null, engine);
        CachedOutput cached = cache.get(cacheKey);
        if (cached != null) {
            fromCache[0] = true;
            elapsedMs[0] = 0;
            return cached;
        }
        long t0 = System.nanoTime();
        String text = engine == Engine.VINEFLOWER
                ? runVineflower(resolved.loader(), resolved.name(), resolved.bytes(),
                        "method".equals(scope) ? methodName : null)
                : runCfr(resolved.loader(), internalPath,
                        "method".equals(scope) ? methodName : null);
        elapsedMs[0] = Math.max(1, (System.nanoTime() - t0) / 1_000_000L);
        if (text == null || text.isBlank()) {
            return null;
        }
        List<String> refs = collectReferencedClasses(resolved.loader(), resolved.name(), resolved.bytes());
        int totalLines = countLines(text);
        int methodLine = methodName != null && !methodName.isBlank() ? findMethodLine(text, methodName) : 0;
        cached = new CachedOutput(text, refs, totalLines, methodLine);
        cache.put(cacheKey, cached);
        return cached;
    }

    // ---- rich class inspection (for tooltips and agent API)

    public Result inspectClass(String opKey, String classCandidates, long fromBundleId) {
        if (!enabled.getAsBoolean()) {
            return error(403, "decompile-disabled");
        }
        ResolvedClass resolved;
        if (classCandidates != null && !classCandidates.isBlank()) {
            List<String> candidates = parseCandidates(classCandidates);
            if (candidates.isEmpty()) {
                return error(400, "invalid-class");
            }
            resolved = resolveFromCandidates(candidates, contextLoaders(opKey, fromBundleId));
        } else if (opKey != null && !opKey.isBlank()) {
            Handler h = findHandler(opKey);
            resolved = h != null && h.handling() != null
                    ? resolveLoaded(targetClass(h.handling().getDeclaringClass()))
                    : null;
        } else {
            return error(400, "missing-class");
        }
        if (resolved == null) {
            return error(404, "class-not-found");
        }
        long[] elapsed = new long[1];
        boolean[] fromCache = new boolean[1];
        String body = buildClassInfoJson(resolved, elapsed, fromCache);
        // inject live inspectMs / cached wrapper cleanly without mutating cached string
        String enriched = body.substring(0, body.length() - 1)
                + ",\"inspectMs\":" + elapsed[0] + ",\"cached\":" + fromCache[0] + "}";
        return new Result(200, enriched);
    }

    /** Rich plugin & OSGi bundle metadata for the App lozenge hover card and agent tooling. */
    public Result inspectPlugin(String pluginKey) {
        if (pluginKey == null || pluginKey.isBlank()) {
            return error(400, "missing-plugin");
        }
        if (pluginAccessor == null) {
            return error(404, "plugin-not-found");
        }
        long t0 = System.nanoTime();
        Plugin p = pluginAccessor.getPlugin(pluginKey.trim());
        if (p == null) {
            return error(404, "plugin-not-found");
        }
        PluginInformation info = p.getPluginInformation();
        Json j = new Json().beginObject()
                .field("format", 1)
                .field("key", p.getKey())
                .field("name", p.getName())
                .optional("version", info == null ? null : info.getVersion())
                .optional("vendor", info == null ? null : info.getVendorName())
                .optional("vendorUrl", info == null ? null : info.getVendorUrl())
                .optional("description", info == null ? null : OperationDetails.clip(info.getDescription()))
                .optional("origin", product == null ? null : product.origin(p))
                .field("state", String.valueOf(p.getPluginState()))
                .field("pluginsVersion", p.getPluginsVersion())
                .optional("artifact", p.getPluginArtifact() == null ? null : p.getPluginArtifact().getName())
                .optional("installed", iso(p.getDateInstalled()))
                .optional("loaded", iso(p.getDateLoaded()))
                .optional("enabled", iso(p.getDateEnabled()));
        Set<String> mandatory = new TreeSet<>();
        Set<String> optional = new TreeSet<>();
        try {
            com.atlassian.plugin.PluginDependencies deps = p.getDependencies();
            if (deps != null) {
                mandatory.addAll(deps.getMandatory());
                optional.addAll(deps.getOptional());
                optional.addAll(deps.getDynamic());
            }
        } catch (RuntimeException | LinkageError ignored) {
            // older plugin types
        }
        optional.removeAll(mandatory);
        j.strings("dependsOn", mandatory).strings("optionallyDependsOn", optional);
        Collection<com.atlassian.plugin.ModuleDescriptor<?>> mods = p.getModuleDescriptors();
        int totalMods = mods == null ? 0 : mods.size();
        int enabledMods = 0;
        if (mods != null) {
            for (com.atlassian.plugin.ModuleDescriptor<?> md : mods) {
                if (md.isEnabled()) {
                    enabledMods++;
                }
            }
        }
        j.field("moduleCount", totalMods).field("enabledModuleCount", enabledMods);
        Bundle b = bundleForPluginKey(p.getKey());
        if (b != null) {
            j.name("bundle");
            writeBundleSummary(j, b, null);
        }
        long elapsedMs = Math.max(1, (System.nanoTime() - t0) / 1_000_000L);
        j.field("inspectMs", elapsedMs).endObject();
        return new Result(200, j.toString());
    }

    private static Bundle bundleForPluginKey(String pluginKey) {
        try {
            Bundle self = FrameworkUtil.getBundle(OperationSource.class);
            BundleContext ctx = self == null ? null : self.getBundleContext();
            if (ctx == null) {
                return null;
            }
            for (Bundle b : ctx.getBundles()) {
                Dictionary<String, String> headers = b.getHeaders();
                String key = headers == null ? null : headers.get("Atlassian-Plugin-Key");
                if (pluginKey.equals(key == null ? null : key.trim()) || pluginKey.equals(b.getSymbolicName())) {
                    return b;
                }
            }
        } catch (RuntimeException | LinkageError ignored) {
            // outside OSGi
        }
        return null;
    }

    private String buildClassInfoJson(ResolvedClass resolved, long[] elapsedMs, boolean[] fromCache) {
        InspectKey key = new InspectKey(resolved.name(), resolved.bundleId(), resolved.bundleModified());
        String hit = inspectCache.get(key);
        if (hit != null) {
            fromCache[0] = true;
            elapsedMs[0] = 0;
            return hit;
        }
        long t0 = System.nanoTime();
        Class<?> c = resolved.loaded();
        if (c == null) {
            try {
                c = Class.forName(resolved.name(), false, resolved.loader());
            } catch (ClassNotFoundException | LinkageError | RuntimeException ignored) {
                // bytecode-only fallback
            }
        }
        List<String> refs = collectReferencedClasses(resolved.loader(), resolved.name(), resolved.bytes());
        String pkg = packageOf(resolved.name());
        String simple = simpleNameOf(resolved.name());
        BytecodeVersion bv = readBytecodeVersion(resolved.bytes());

        Json j = new Json().beginObject()
                .field("format", 1)
                .field("name", resolved.name())
                .field("simpleName", simple)
                .field("package", pkg);

        if (c != null) {
            String kind = c.isAnnotation() ? "annotation" : c.isInterface() ? "interface"
                    : c.isEnum() ? "enum" : c.isRecord() ? "record" : "class";
            int modBits = c.getModifiers() & (c.isInterface() ? Modifier.interfaceModifiers() : Modifier.classModifiers());
            List<String> supers = new ArrayList<>();
            Set<String> interfaces = new LinkedHashSet<>();
            for (Class<?> k = c; k != null && k != Object.class; k = k.getSuperclass()) {
                if (k != c) {
                    supers.add(k.getName());
                }
                try {
                    for (Type t : k.getGenericInterfaces()) {
                        interfaces.add(t.getTypeName());
                    }
                } catch (LinkageError | RuntimeException e) {
                    for (Class<?> iface : k.getInterfaces()) {
                        interfaces.add(iface.getName());
                    }
                }
            }
            j.field("kind", kind)
                    .field("modifiers", Modifier.toString(modBits))
                    .field("deprecated", safeDeprecated(c))
                    .optional("superclass", supers.isEmpty() ? null : supers.get(0))
                    .strings("superclasses", supers)
                    .strings("interfaces", interfaces)
                    .strings("annotations", OperationDetails.annotations(c));
            Class<?> enclosing = safeEnclosing(c);
            j.optional("enclosingClass", enclosing == null ? null : enclosing.getName());
            j.strings("innerClasses", safeInnerClasses(c));
            j.field("fieldCount", safeFieldCount(c));
            j.field("constructorCount", safeConstructorCount(c));
            List<String> methodSigs = safeMethodSummaries(c);
            j.field("methodCount", safeMethodCount(c))
                    .strings("methods", methodSigs);
            j.field("codeSource", codeSource(c))
                    .field("classLoader", OperationDetails.clip(String.valueOf(c.getClassLoader())))
                    .field("origin", OperationDetails.origin(c));
        } else {
            j.field("kind", "class")
                    .field("modifiers", "")
                    .field("deprecated", false)
                    .strings("superclasses", List.of())
                    .strings("interfaces", List.of())
                    .strings("annotations", List.of())
                    .strings("innerClasses", List.of())
                    .field("fieldCount", 0)
                    .field("constructorCount", 0)
                    .field("methodCount", 0)
                    .strings("methods", List.of())
                    .field("codeSource", (String) null)
                    .field("classLoader", OperationDetails.clip(String.valueOf(resolved.loader())))
                    .field("origin", resolved.loader() == null ? "JDK" : resolved.loader().getClass().getSimpleName());
        }

        if (bv != null) {
            j.field("bytecodeVersion", bv.label());
            j.field("bytecodeMajor", bv.major());
        }
        j.field("bytecodeBytes", resolved.bytes() == null ? 0 : resolved.bytes().length);
        j.field("bundleId", resolved.bundleId());

        Bundle bundle = bundleByIdOrClass(resolved.bundleId(), c);
        if (bundle != null) {
            j.name("bundle");
            writeBundleSummary(j, bundle, pkg);
            Plugin owner = pluginForBundle(bundle);
            if (owner != null) {
                j.name("plugin");
                writePluginSummary(j, owner);
            }
        }
        j.field("refCount", refs.size())
                .strings("refs", refs)
                .endObject();

        String json = j.toString();
        elapsedMs[0] = Math.max(1, (System.nanoTime() - t0) / 1_000_000L);
        fromCache[0] = false;
        inspectCache.put(key, json);
        return json;
    }

    private void writeBundleSummary(Json j, Bundle b, String pkg) {
        Map<String, String> headers = new LinkedHashMap<>();
        Dictionary<String, String> all = b.getHeaders();
        for (String name : OperationDetails.HEADERS) {
            String v = all == null ? null : all.get(name);
            if (v != null) {
                headers.put(name, OperationDetails.clip(v));
            }
        }
        boolean fragment = all != null && all.get("Fragment-Host") != null;
        long modified = b.getLastModified();
        j.beginObject()
                .field("id", b.getBundleId())
                .field("symbolicName", b.getSymbolicName())
                .field("version", String.valueOf(b.getVersion()))
                .field("state", OperationDetails.state(b.getState()))
                .field("location", OperationDetails.clip(b.getLocation()))
                .field("lastModified", modified)
                .optional("lastModifiedIso", modified > 0 ? DateTimeFormatter.ISO_INSTANT.format(Instant.ofEpochMilli(modified)) : null)
                .field("fragment", fragment)
                .stringMap("headers", headers);
        BundleWiring wiring = b.adapt(BundleWiring.class);
        if (wiring != null && wiring.isInUse()) {
            List<BundleWire> reqs = wiring.getRequiredWires(BundleRevision.PACKAGE_NAMESPACE);
            List<BundleCapability> caps = wiring.getCapabilities(BundleRevision.PACKAGE_NAMESPACE);
            List<BundleWire> provs = wiring.getProvidedWires(BundleRevision.PACKAGE_NAMESPACE);
            j.field("importCount", reqs == null ? 0 : reqs.size());
            j.field("exportCount", caps == null ? 0 : caps.size());
            boolean pkgExported = false;
            int pkgUsers = 0;
            if (caps != null && pkg != null && !pkg.isEmpty()) {
                for (BundleCapability cap : caps) {
                    if (pkg.equals(cap.getAttributes().get(BundleRevision.PACKAGE_NAMESPACE))) {
                        pkgExported = true;
                        if (provs != null) {
                            for (BundleWire w : provs) {
                                if (cap.equals(w.getCapability())) {
                                    pkgUsers++;
                                }
                            }
                        }
                        break;
                    }
                }
            }
            j.field("packageExported", pkgExported);
            j.field("packageExportUsers", pkgUsers);
        }
        j.endObject();
    }

    private void writePluginSummary(Json j, Plugin p) {
        PluginInformation info = p.getPluginInformation();
        j.beginObject()
                .field("key", p.getKey())
                .field("name", p.getName())
                .optional("version", info == null ? null : info.getVersion())
                .optional("vendor", info == null ? null : info.getVendorName())
                .optional("vendorUrl", info == null ? null : info.getVendorUrl())
                .optional("origin", product == null ? null : product.origin(p))
                .field("state", String.valueOf(p.getPluginState()))
                .field("pluginsVersion", p.getPluginsVersion())
                .optional("artifact", p.getPluginArtifact() == null ? null : p.getPluginArtifact().getName())
                .optional("installed", iso(p.getDateInstalled()))
                .optional("loaded", iso(p.getDateLoaded()))
                .optional("enabled", iso(p.getDateEnabled()))
                .field("moduleCount", p.getModuleDescriptors() == null ? 0 : p.getModuleDescriptors().size())
                .endObject();
    }

    private Plugin pluginForBundle(Bundle b) {
        if (pluginAccessor == null || b == null) {
            return null;
        }
        try {
            Dictionary<String, String> headers = b.getHeaders();
            String key = headers == null ? null : headers.get("Atlassian-Plugin-Key");
            if (key != null && !key.isBlank()) {
                Plugin p = pluginAccessor.getPlugin(key.trim());
                if (p != null) {
                    return p;
                }
            }
            String sym = b.getSymbolicName();
            if (sym != null && !sym.isBlank()) {
                Plugin p = pluginAccessor.getPlugin(sym);
                if (p != null) {
                    return p;
                }
            }
        } catch (RuntimeException | LinkageError ignored) {
            // best effort
        }
        return null;
    }

    private static Bundle bundleByIdOrClass(long bundleId, Class<?> c) {
        try {
            if (c != null) {
                Bundle b = FrameworkUtil.getBundle(c);
                if (b != null) {
                    return b;
                }
            }
            if (bundleId >= 0) {
                Bundle self = FrameworkUtil.getBundle(OperationSource.class);
                BundleContext ctx = self == null ? null : self.getBundleContext();
                if (ctx != null) {
                    return ctx.getBundle(bundleId);
                }
            }
        } catch (RuntimeException | LinkageError ignored) {
            // outside OSGi
        }
        return null;
    }

    // ---- agent-friendly graph traversal, search, batch, operation bundle

    public Result traverseGraph(String opKey, String classCandidates, long fromBundleId,
                                int rawDepth, int rawMaxNodes, boolean includeJdk, String packagePrefix,
                                boolean includeSources, String decompiler) {
        if (!enabled.getAsBoolean()) {
            return error(403, "decompile-disabled");
        }
        int depth = Math.max(1, Math.min(3, rawDepth <= 0 ? 1 : rawDepth));
        int maxNodes = Math.max(1, Math.min(100, rawMaxNodes <= 0 ? 30 : rawMaxNodes));
        String prefix = packagePrefix == null ? "" : packagePrefix.trim();
        Engine engine = Engine.parse(decompiler);
        long t0 = System.nanoTime();

        ResolvedClass root;
        if (classCandidates != null && !classCandidates.isBlank()) {
            List<String> cands = parseCandidates(classCandidates);
            if (cands.isEmpty()) {
                return error(400, "invalid-class");
            }
            root = resolveFromCandidates(cands, contextLoaders(opKey, fromBundleId));
        } else if (opKey != null && !opKey.isBlank()) {
            Handler h = findHandler(opKey);
            root = h != null && h.handling() != null
                    ? resolveLoaded(targetClass(h.handling().getDeclaringClass()))
                    : null;
        } else {
            return error(400, "missing-class");
        }
        if (root == null) {
            return error(404, "class-not-found");
        }

        record QueueItem(ResolvedClass resolved, int level) {
        }
        Map<String, ResolvedClass> visited = new LinkedHashMap<>();
        Map<String, List<String>> adjacency = new LinkedHashMap<>();
        Queue<QueueItem> queue = new ArrayDeque<>();
        visited.put(root.name(), root);
        queue.add(new QueueItem(root, 0));
        boolean truncated = false;

        while (!queue.isEmpty()) {
            QueueItem cur = queue.poll();
            List<String> rawRefs = collectReferencedClasses(cur.resolved().loader(), cur.resolved().name(), cur.resolved().bytes());
            List<String> filtered = new ArrayList<>();
            for (String ref : rawRefs) {
                if (ref.equals(cur.resolved().name())) {
                    continue;
                }
                if (!includeJdk && isStandardJdk(ref)) {
                    continue;
                }
                if (!prefix.isEmpty() && !ref.startsWith(prefix)) {
                    continue;
                }
                filtered.add(ref);
            }
            adjacency.put(cur.resolved().name(), filtered);
            if (cur.level() >= depth) {
                continue;
            }
            List<ClassLoader> loaders = contextLoaders(opKey, cur.resolved().bundleId());
            if (cur.resolved().loader() != null && !loaders.contains(cur.resolved().loader())) {
                List<ClassLoader> withOwn = new ArrayList<>();
                withOwn.add(cur.resolved().loader());
                withOwn.addAll(loaders);
                loaders = withOwn;
            }
            for (String ref : filtered) {
                if (visited.containsKey(ref)) {
                    continue;
                }
                if (visited.size() >= maxNodes) {
                    truncated = true;
                    break;
                }
                ResolvedClass next = resolveFromCandidates(List.of(ref), loaders);
                if (next != null && !visited.containsKey(next.name())) {
                    visited.put(next.name(), next);
                    queue.add(new QueueItem(next, cur.level() + 1));
                }
            }
        }

        long elapsedMs = Math.max(1, (System.nanoTime() - t0) / 1_000_000L);
        Json j = new Json().beginObject()
                .field("format", 1)
                .field("root", root.name())
                .field("depth", depth)
                .field("maxNodes", maxNodes)
                .field("nodeCount", visited.size())
                .field("truncated", truncated)
                .field("traverseMs", elapsedMs)
                .name("nodes").beginArray();

        List<String[]> edges = new ArrayList<>();
        for (Map.Entry<String, ResolvedClass> entry : visited.entrySet()) {
            ResolvedClass r = entry.getValue();
            List<String> outs = adjacency.getOrDefault(r.name(), List.of());
            for (String target : outs) {
                if (visited.containsKey(target)) {
                    edges.add(new String[]{r.name(), target});
                }
            }
            Class<?> c = r.loaded();
            Bundle b = bundleByIdOrClass(r.bundleId(), c);
            Plugin owner = pluginForBundle(b);
            j.beginObject()
                    .field("class", r.name())
                    .field("simpleName", simpleNameOf(r.name()))
                    .field("kind", c == null ? "class" : (c.isAnnotation() ? "annotation" : c.isInterface() ? "interface"
                            : c.isEnum() ? "enum" : c.isRecord() ? "record" : "class"))
                    .field("bundleId", r.bundleId())
                    .optional("bundle", b == null ? null : b.getSymbolicName() + " " + b.getVersion())
                    .optional("plugin", owner == null ? null : owner.getKey())
                    .optional("pluginName", owner == null ? null : owner.getName())
                    .field("methodCount", c == null ? 0 : safeMethodCount(c))
                    .strings("refs", outs);
            if (includeSources) {
                CachedOutput src = decompileCached(r, "class", null, null, engine, new long[1], new boolean[1]);
                if (src != null) {
                    j.field("decompiler", engine.label)
                            .field("totalLines", src.totalLines())
                            .field("source", src.source());
                }
            }
            j.endObject();
        }
        j.endArray().name("edges").beginArray();
        for (String[] edge : edges) {
            j.beginObject().field("from", edge[0]).field("to", edge[1]).endObject();
        }
        j.endArray().endObject();
        return new Result(200, j.toString());
    }

    public Result searchClasses(String rawQuery, int rawLimit, Long bundleIdFilter) {
        if (!enabled.getAsBoolean()) {
            return error(403, "decompile-disabled");
        }
        String query = rawQuery == null ? "" : rawQuery.trim();
        if (query.length() < 2) {
            return error(400, "query-too-short");
        }
        int limit = Math.max(1, Math.min(100, rawLimit <= 0 ? 30 : rawLimit));
        String needle = query.toLowerCase();
        boolean includeAnonymous = needle.contains("$");
        record Hit(String fqcn, long bundleId, String bundle, String plugin) {
        }
        Map<String, Hit> hits = new LinkedHashMap<>();
        boolean truncated = false;

        try {
            Bundle self = FrameworkUtil.getBundle(OperationSource.class);
            BundleContext ctx = self == null ? null : self.getBundleContext();
            if (ctx != null) {
                Bundle[] bundles = bundleIdFilter != null && bundleIdFilter >= 0
                        ? (ctx.getBundle(bundleIdFilter) == null ? new Bundle[0] : new Bundle[]{ctx.getBundle(bundleIdFilter)})
                        : ctx.getBundles();
                outer:
                for (Bundle b : bundles) {
                    if (b.getState() != Bundle.ACTIVE && b.getState() != Bundle.RESOLVED) {
                        continue;
                    }
                    Enumeration<URL> entries = b.findEntries("/", "*.class", true);
                    if (entries == null) {
                        continue;
                    }
                    String bundleLabel = b.getSymbolicName() + " " + b.getVersion();
                    Plugin owner = null;
                    boolean ownerChecked = false;
                    while (entries.hasMoreElements()) {
                        String path = entries.nextElement().getPath();
                        if (path == null || !path.endsWith(".class")) {
                            continue;
                        }
                        if (path.startsWith("/")) {
                            path = path.substring(1);
                        }
                        if (path.startsWith("WEB-INF/classes/")) {
                            path = path.substring("WEB-INF/classes/".length());
                        }
                        String fqcn = path.substring(0, path.length() - ".class".length()).replace('/', '.');
                        if (!includeAnonymous && fqcn.matches(".*\\$\\d+.*")) {
                            continue;
                        }
                        if (fqcn.toLowerCase().contains(needle)) {
                            if (!hits.containsKey(fqcn)) {
                                if (hits.size() >= limit) {
                                    truncated = true;
                                    break outer;
                                }
                                if (!ownerChecked) {
                                    owner = pluginForBundle(b);
                                    ownerChecked = true;
                                }
                                hits.put(fqcn, new Hit(fqcn, b.getBundleId(), bundleLabel, owner == null ? null : owner.getKey()));
                            }
                        }
                    }
                }
            }
        } catch (RuntimeException | LinkageError ignored) {
            // outside OSGi
        }

        // Also allow exact class lookup via context classloaders (useful in tests or JDK classes)
        if (hits.size() < limit && SAFE_CLASS_NAME.matcher(query).matches() && !hits.containsKey(query)) {
            ResolvedClass r = resolveFromCandidates(List.of(query), contextLoaders(null, bundleIdFilter == null ? -1 : bundleIdFilter));
            if (r != null) {
                hits.put(r.name(), new Hit(r.name(), r.bundleId(), null, null));
            }
        }

        Json j = new Json().beginObject()
                .field("format", 1)
                .field("query", query)
                .field("limit", limit)
                .field("count", hits.size())
                .field("truncated", truncated)
                .name("results").beginArray();
        for (Hit h : hits.values()) {
            j.beginObject()
                    .field("class", h.fqcn())
                    .field("simpleName", simpleNameOf(h.fqcn()))
                    .field("bundleId", h.bundleId())
                    .optional("bundle", h.bundle())
                    .optional("plugin", h.plugin())
                    .endObject();
        }
        j.endArray().endObject();
        return new Result(200, j.toString());
    }

    public Result operationBundle(String opKey, String scope, String decompiler, OperationDetails details) {
        if (!enabled.getAsBoolean()) {
            return error(403, "decompile-disabled");
        }
        Result detailRes = details.describe(opKey);
        if (detailRes.status() != 200) {
            return detailRes;
        }
        Result srcRes = decompile(opKey, null, -1, scope, decompiler, null, null, null, false);
        Json j = new Json().beginObject()
                .field("format", 1)
                .field("key", opKey)
                .name("details").raw(detailRes.json())
                .name("source").raw(srcRes.json())
                .endObject();
        return new Result(200, j.toString());
    }

    public Result batch(List<String> classes, long fromBundleId, String opKey, String decompiler,
                        boolean includeSource, boolean includeMeta, Integer maxLines) {
        if (!enabled.getAsBoolean()) {
            return error(403, "decompile-disabled");
        }
        if (classes == null || classes.isEmpty()) {
            return error(400, "missing-classes");
        }
        int cap = Math.min(classes.size(), 10);
        Json j = new Json().beginObject()
                .field("format", 1)
                .field("count", cap)
                .field("truncated", classes.size() > 10)
                .name("results").beginArray();
        for (int i = 0; i < cap; i++) {
            String cls = classes.get(i);
            Result item = includeSource
                    ? decompile(opKey, cls, fromBundleId, "class", decompiler, null, 1, maxLines, includeMeta)
                    : inspectClass(opKey, cls, fromBundleId);
            j.beginObject()
                    .field("requested", cls)
                    .field("status", item.status())
                    .name("result").raw(item.json())
                    .endObject();
        }
        j.endArray().endObject();
        return new Result(200, j.toString());
    }

    // ---- class & loader resolution

    private Handler findHandler(String opKey) {
        RestModule module = OperationDetails.moduleOf(discovery.discover(), opKey);
        JerseyModelSource src = jersey.get();
        if (module == null || src == null || !module.restV2()) {
            return null;
        }
        try {
            return src.handler(module, opKey).orElse(null);
        } catch (SpecException | RuntimeException | LinkageError e) {
            return null;
        }
    }

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
            Handler h = findHandler(opKey);
            if (h != null && h.handling() != null) {
                ClassLoader l = targetClass(h.handling().getDeclaringClass()).getClassLoader();
                if (l != null) {
                    loaders.add(l);
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
                        return new ResolvedClass(variant, null, loader, -1, 0, bytes);
                    }
                }
                byte[] sys = readResource(null, path);
                if (sys != null) {
                    return new ResolvedClass(variant, tryLoadClass(null, variant), null, -1, 0, sys);
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
                                Class<?> loaded = tryLoadClass(cl, variant);
                                return new ResolvedClass(variant, loaded, cl, b.getBundleId(), b.getLastModified(), bytes);
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

    private static Class<?> tryLoadClass(ClassLoader loader, String name) {
        try {
            return Class.forName(name, false, loader);
        } catch (ClassNotFoundException | LinkageError | RuntimeException e) {
            return null;
        }
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
        return new ResolvedClass(target.getName(), target, loader, bundleId, modified, bytes);
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
                    @Override public void begin() {}
                    @Override public void acceptClass(String qualifiedName, String fileName, String content, int[] mapping) {
                        if (content != null && (internalBase.equals(qualifiedName) || out.isEmpty())) {
                            out.setLength(0);
                            out.append(content);
                        }
                    }
                    @Override public void acceptDirectory(String directory) {}
                    @Override public void acceptOther(String path) {}
                    @Override public void close() {}
                };
            }
        };
        IContextSource libs = new IContextSource() {
            @Override public String getName() { return "classpath"; }
            @Override public Entries getEntries() { return Entries.EMPTY; }
            @Override public boolean isLazy() { return true; }
            @Override public boolean hasClass(String path) {
                return resourceExists(loader, path.endsWith(CLASS_SUFFIX) ? path : path + CLASS_SUFFIX);
            }
            @Override public InputStream getInputStream(String resource) throws IOException {
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

    /** 1-based line number of the first declaration header line for {@code methodName} in {@code source}, or 0 if not found. */
    static int findMethodLine(String source, String methodName) {
        if (source == null || methodName == null || methodName.isBlank()) {
            return 0;
        }
        String[] lines = source.split("\n", -1);
        Pattern sig = methodHeaderPattern(methodName);
        boolean inBlockComment = false;
        for (int i = 0; i < lines.length; i++) {
            String trimmed = lines[i].trim();
            if (inBlockComment) {
                if (trimmed.contains("*/")) {
                    inBlockComment = false;
                }
                continue;
            }
            if (trimmed.startsWith("/*") && !trimmed.contains("*/")) {
                inBlockComment = true;
                continue;
            }
            if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
                continue;
            }
            if (sig.matcher(lines[i]).find()) {
                return i + 1;
            }
        }
        return 0;
    }

    private static Pattern methodHeaderPattern(String methodName) {
        return Pattern.compile("^\\s{0,12}(?:(?:public|protected|private|static|final|abstract|synchronized|native|default)\\s+)*"
                + "(?:<[^>]+>\\s+)?[\\w$.<>?, \\[\\]]+\\s+" + Pattern.quote(methodName) + "\\s*\\(");
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

    // ---- line slicing & reflection helpers

    private record Slice(String text, int startLine, int endLine, boolean truncated) {
    }

    static Slice sliceLines(String source, Integer rawStart, Integer rawMax) {
        String[] lines = source.split("\n", -1);
        int total = lines.length;
        if (rawStart == null && rawMax == null) {
            return new Slice(source, 1, total, false);
        }
        int start = rawStart == null ? 1 : Math.max(1, Math.min(total, rawStart));
        int max = rawMax == null ? total : Math.max(1, rawMax);
        int end = Math.min(total, start + max - 1);
        StringBuilder sb = new StringBuilder();
        for (int i = start - 1; i < end; i++) {
            if (i > start - 1) {
                sb.append('\n');
            }
            sb.append(lines[i]);
        }
        return new Slice(sb.toString(), start, end, end < total || start > 1);
    }

    private static int countLines(String s) {
        int n = 1;
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) == '\n') {
                n++;
            }
        }
        return n;
    }

    private record BytecodeVersion(int major, int minor, String label) {
    }

    static BytecodeVersion readBytecodeVersion(byte[] classBytes) {
        if (classBytes == null || classBytes.length < 8) {
            return null;
        }
        try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(classBytes))) {
            if (in.readInt() != 0xCAFEBABE) {
                return null;
            }
            int minor = in.readUnsignedShort();
            int major = in.readUnsignedShort();
            String javaVer = major >= 45 ? "Java " + (major == 45 ? "1.1" : major <= 52 ? "1." + (major - 44) : String.valueOf(major - 44)) : "v" + major;
            return new BytecodeVersion(major, minor, major + "." + minor + " (" + javaVer + ")");
        } catch (IOException e) {
            return null;
        }
    }

    private static boolean isStandardJdk(String fqcn) {
        return fqcn.startsWith("java.") || fqcn.startsWith("javax.") || fqcn.startsWith("jakarta.")
                || fqcn.startsWith("jdk.") || fqcn.startsWith("sun.") || fqcn.startsWith("com.sun.")
                || fqcn.startsWith("org.w3c.") || fqcn.startsWith("org.xml.");
    }

    private static String packageOf(String fqcn) {
        int dot = fqcn.lastIndexOf('.');
        return dot > 0 ? fqcn.substring(0, dot) : "";
    }

    private static String simpleNameOf(String fqcn) {
        int dot = fqcn.lastIndexOf('.');
        String tail = dot >= 0 ? fqcn.substring(dot + 1) : fqcn;
        return tail.replace('$', '.');
    }

    private static boolean safeDeprecated(Class<?> c) {
        try {
            return c.isAnnotationPresent(Deprecated.class);
        } catch (LinkageError | RuntimeException e) {
            return false;
        }
    }

    private static Class<?> safeEnclosing(Class<?> c) {
        try {
            return c.getEnclosingClass();
        } catch (LinkageError | RuntimeException e) {
            return null;
        }
    }

    private static List<String> safeInnerClasses(Class<?> c) {
        try {
            Class<?>[] declared = c.getDeclaredClasses();
            List<String> out = new ArrayList<>(Math.min(declared.length, MAX_INNER_CLASSES));
            for (int i = 0; i < declared.length && out.size() < MAX_INNER_CLASSES; i++) {
                out.add(declared[i].getName());
            }
            return out;
        } catch (LinkageError | RuntimeException e) {
            return List.of();
        }
    }

    private static int safeFieldCount(Class<?> c) {
        try {
            return c.getDeclaredFields().length;
        } catch (LinkageError | RuntimeException e) {
            return 0;
        }
    }

    private static int safeConstructorCount(Class<?> c) {
        try {
            Constructor<?>[] cs = c.getDeclaredConstructors();
            return cs.length;
        } catch (LinkageError | RuntimeException e) {
            return 0;
        }
    }

    private static int safeMethodCount(Class<?> c) {
        try {
            int count = 0;
            for (Method m : c.getDeclaredMethods()) {
                if (!m.isSynthetic() && !m.isBridge()) {
                    count++;
                }
            }
            return count;
        } catch (LinkageError | RuntimeException e) {
            return 0;
        }
    }

    private static List<String> safeMethodSummaries(Class<?> c) {
        try {
            Method[] methods = c.getDeclaredMethods();
            Arrays.sort(methods, Comparator.comparing(Method::getName).thenComparingInt(Method::getParameterCount));
            List<String> out = new ArrayList<>();
            for (Method m : methods) {
                if (m.isSynthetic() || m.isBridge()) {
                    continue;
                }
                if (out.size() >= MAX_METHOD_SUMMARIES) {
                    break;
                }
                StringBuilder sb = new StringBuilder();
                String mods = Modifier.toString(m.getModifiers() & Modifier.methodModifiers());
                if (!mods.isEmpty()) {
                    sb.append(mods).append(' ');
                }
                sb.append(JerseyModelSource.shortTypeName(m.getGenericReturnType())).append(' ')
                        .append(m.getName()).append('(');
                Type[] pts = m.getGenericParameterTypes();
                for (int i = 0; i < pts.length; i++) {
                    if (i > 0) {
                        sb.append(", ");
                    }
                    sb.append(JerseyModelSource.shortTypeName(pts[i]));
                }
                sb.append(')');
                out.add(sb.toString());
            }
            return out;
        } catch (LinkageError | RuntimeException e) {
            return List.of();
        }
    }

    private static String codeSource(Class<?> c) {
        try {
            CodeSource cs = c.getProtectionDomain().getCodeSource();
            return cs == null || cs.getLocation() == null ? null : OperationDetails.clip(cs.getLocation().toString());
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String iso(Date d) {
        return d == null ? null : DateTimeFormatter.ISO_INSTANT.format(d.toInstant());
    }

    // ---- bytecode constant pool class reference extractor

    private static List<String> collectReferencedClasses(ClassLoader loader, String className, byte[] classBytes) {
        Set<String> all = new TreeSet<>(constantPoolClasses(classBytes));
        List<String> inners = all.stream().filter(n -> n.startsWith(className + "$")).toList();
        for (String inner : inners) {
            byte[] innerBytes = readResource(loader, inner.replace('.', '/') + ".class");
            if (innerBytes != null) {
                all.addAll(constantPoolClasses(innerBytes));
            }
        }
        return List.copyOf(all);
    }

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
                        i++;
                    }
                    case 7 -> classIndices.add(in.readUnsignedShort());
                    case 8, 16, 19, 20 -> skipFully(in, 2);
                    case 15 -> skipFully(in, 3);
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
            for (int i = 1; i < count; i++) {
                String s = utf8[i];
                if (s != null && s.indexOf('L') >= 0 && s.indexOf(';') >= 0 && s.indexOf('/') >= 0) {
                    extractDescriptorClasses(s, out);
                }
            }
        } catch (IOException | RuntimeException e) {
            // malformed or partial class file
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
