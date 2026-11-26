package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.JerseyModelSource.Handler;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.labs.restbrowser.catalog.OperationDetails.Result;
import com.atlassian.labs.restbrowser.catalog.SpecSource.SpecException;
import com.atlassian.labs.restbrowser.decompile.CfrEngine;
import com.atlassian.labs.restbrowser.decompile.DecompilerEngine;
import com.atlassian.labs.restbrowser.decompile.DecompilerEngine.BytecodeInput;
import com.atlassian.labs.restbrowser.decompile.DecompilerEngine.DecompileOptions;
import com.atlassian.labs.restbrowser.decompile.LineSlicer;
import com.atlassian.labs.restbrowser.decompile.LineSlicer.Slice;
import com.atlassian.labs.restbrowser.decompile.SourceMethodExtractor;
import com.atlassian.labs.restbrowser.decompile.VineflowerEngine;
import com.atlassian.labs.restbrowser.inspect.ClassFileInspector;
import com.atlassian.labs.restbrowser.inspect.ClassFileInspector.BytecodeVersion;
import com.atlassian.labs.restbrowser.inspect.ClassGraphTraverser;
import com.atlassian.labs.restbrowser.inspect.ClassGraphTraverser.GraphResult;
import com.atlassian.labs.restbrowser.inspect.ClassGraphTraverser.ResolvedClassInfo;
import com.atlassian.labs.restbrowser.inspect.SingleFlightLruCache;
import com.atlassian.labs.restbrowser.inspect.TypeProxyUnwrapper;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiBundleInspector;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiClassResolver;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiClassSearcher;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiClassSearcher.SearchHit;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiClassSearcher.SearchResult;
import com.atlassian.labs.restbrowser.jaxrs.AnnotationFormatter;
import com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge;
import com.atlassian.labs.restbrowser.jaxrs.TypeFormatter;
import com.atlassian.labs.restbrowser.json.Json;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import org.osgi.framework.Bundle;

import java.lang.reflect.Constructor;
import java.util.LinkedHashMap;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Type;
import java.security.CodeSource;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

import static java.util.Objects.requireNonNull;

/**
 * Facade for on-demand Java bytecode decompilation, class/OSGi/plugin metadata inspection, and code graph traversal.
 * <p>
 * Delegates bytecode inspection and decompilation to the standalone {@code inspect/} and {@code decompile/} libraries,
 * uses single-flight concurrency-bounded LRU caches, hoists operation resolution outside graph/batch loops, and
 * honors {@code -Drest.api.browser.decompile=false}.
 */
public class OperationSource {

    public static final String ENABLED_PROPERTY = "rest.api.browser.decompile";
    public static final String DECOMPILER_CFR = CfrEngine.DISPLAY_NAME;
    public static final String DECOMPILER_VINEFLOWER = VineflowerEngine.DISPLAY_NAME;
    public static final String DECOMPILER = DECOMPILER_VINEFLOWER;

    static final int MAX_CACHE = 96;
    static final int MAX_INSPECT_CACHE = 128;
    static final int MAX_SOURCE = DecompilerEngine.DEFAULT_MAX_SOURCE;
    private static final int MAX_CONCURRENT_DECOMPILES = 4;
    private static final long DECOMPILE_PERMIT_TIMEOUT_MS = 25_000L;
    private static final long GRAPH_TIME_BUDGET_MS = 15_000L;
    private static final int MAX_GRAPH_NODES_WITH_SOURCES = 10;
    private static final int MAX_GRAPH_SOURCE_LINES = 500;
    private static final int MAX_METHOD_SUMMARIES = 80;
    private static final int MAX_INNER_CLASSES = 40;

    public enum Engine {
        VINEFLOWER(VineflowerEngine.ID, DECOMPILER_VINEFLOWER, new VineflowerEngine()),
        CFR(CfrEngine.ID, DECOMPILER_CFR, new CfrEngine());

        final String id;
        final String label;
        final DecompilerEngine impl;

        Engine(String id, String label, DecompilerEngine impl) {
            this.id = id;
            this.label = label;
            this.impl = impl;
        }

        public static Engine parse(String raw) {
            if (raw != null && CfrEngine.ID.equalsIgnoreCase(raw.trim())) {
                return CFR;
            }
            return VINEFLOWER;
        }
    }

    private record CacheKey(String className, long bundleId, long bundleModified,
                            String scope, String methodName, int overloadParamCount, Engine engine) {
    }

    private record CachedOutput(String source, List<String> refs, int totalLines) {
    }

    private record InspectKey(String className, long bundleId, long bundleModified) {
    }

    private final ModuleDiscovery discovery;
    private final Supplier<JerseyModelSource> jersey;
    private final BooleanSupplier enabled;
    private final PluginAccessor pluginAccessor;
    private final ProductAdapter product;

    private final SingleFlightLruCache<CacheKey, CachedOutput> cache =
            new SingleFlightLruCache<>(MAX_CACHE, MAX_CONCURRENT_DECOMPILES, DECOMPILE_PERMIT_TIMEOUT_MS);
    private final SingleFlightLruCache<InspectKey, String> inspectCache =
            new SingleFlightLruCache<>(MAX_INSPECT_CACHE, 8, DECOMPILE_PERMIT_TIMEOUT_MS);

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
        return decompile(key, null, -1, "method", VineflowerEngine.ID);
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
            List<String> candidates = OsgiClassResolver.parseCandidates(classCandidates);
            if (candidates.isEmpty()) {
                return error(400, "invalid-class");
            }
            List<ClassLoader> loaders = loadersFor(opKey, fromBundleId);
            ResolvedClassInfo resolved = OsgiClassResolver.resolveFromCandidates(candidates, loaders);
            if (resolved == null) {
                return error(404, "class-not-found");
            }
            String targetMethod = cleanMethodFilter(methodFilter);
            String resolvedScope = ("method".equalsIgnoreCase(scope) && targetMethod != null) ? "method" : "class";
            return runAndFormat(opKey, resolved, resolvedScope, targetMethod, -1, engine, startLine, maxLines, includeMeta);
        }
        return decompileOp(opKey, scope, engine, methodFilter, startLine, maxLines, includeMeta, false);
    }

    public Result decompileText(String opKey, String classCandidates, long fromBundleId, String scope,
                                String decompiler, String methodFilter, Integer startLine, Integer maxLines) {
        if (!enabled.getAsBoolean()) {
            return error(403, "decompile-disabled");
        }
        Engine engine = Engine.parse(decompiler);
        if (classCandidates != null && !classCandidates.isBlank()) {
            List<String> candidates = OsgiClassResolver.parseCandidates(classCandidates);
            if (candidates.isEmpty()) {
                return error(400, "invalid-class");
            }
            List<ClassLoader> loaders = loadersFor(opKey, fromBundleId);
            ResolvedClassInfo resolved = OsgiClassResolver.resolveFromCandidates(candidates, loaders);
            if (resolved == null) {
                return error(404, "class-not-found");
            }
            String targetMethod = cleanMethodFilter(methodFilter);
            String resolvedScope = ("method".equalsIgnoreCase(scope) && targetMethod != null) ? "method" : "class";
            return runAndFormatText(resolved, resolvedScope, targetMethod, -1, engine, startLine, maxLines);
        }
        return decompileOp(opKey, scope, engine, methodFilter, startLine, maxLines, false, true);
    }

    private Result decompileOp(String opKey, String scope, Engine engine, String methodFilter,
                               Integer startLine, Integer maxLines, boolean includeMeta, boolean plainText) {
        if (opKey == null || opKey.isBlank()) {
            return error(400, "missing-op");
        }
        ResolvedOp op;
        try {
            op = resolveOperation(opKey);
        } catch (SpecException e) {
            return error(503, e.reason());
        }
        if (op.error != null) {
            return op.error;
        }
        Method handling = op.handler.handling();
        boolean wholeClass = "class".equalsIgnoreCase(scope);
        String explicitMethod = cleanMethodFilter(methodFilter);
        String targetMethod = explicitMethod != null ? explicitMethod : handling.getName();
        int paramCount = explicitMethod != null && !explicitMethod.equals(handling.getName()) ? -1 : handling.getParameterCount();
        ResolvedClassInfo resolved = OsgiClassResolver.resolveLoaded(TypeProxyUnwrapper.targetClass(handling.getDeclaringClass()));
        if (resolved == null) {
            return error(404, "class-not-found");
        }
        String resolvedScope = wholeClass ? "class" : "method";
        return plainText
                ? runAndFormatText(resolved, resolvedScope, targetMethod, paramCount, engine, startLine, maxLines)
                : runAndFormat(opKey, resolved, resolvedScope, targetMethod, paramCount, engine, startLine, maxLines, includeMeta);
    }

    Result decompileMethod(String key, Method method) {
        return decompileMethod(key, method, Engine.VINEFLOWER);
    }

    Result decompileMethod(String key, Method method, Engine engine) {
        ResolvedClassInfo resolved = OsgiClassResolver.resolveLoaded(TypeProxyUnwrapper.targetClass(method.getDeclaringClass()));
        if (resolved == null) {
            return error(404, "class-not-found");
        }
        return runAndFormat(key, resolved, "method", method.getName(), method.getParameterCount(), engine, null, null, false);
    }

    Result decompileClass(String key, Class<?> cls, Engine engine) {
        ResolvedClassInfo resolved = OsgiClassResolver.resolveLoaded(TypeProxyUnwrapper.targetClass(cls));
        if (resolved == null) {
            return error(404, "class-not-found");
        }
        return runAndFormat(key, resolved, "class", null, -1, engine, null, null, false);
    }

    private Result runAndFormatText(ResolvedClassInfo resolved, String scope, String methodName, int overloadParams,
                                    Engine engine, Integer startLine, Integer maxLines) {
        CachedOutput cached;
        try {
            cached = decompileCached(resolved, scope, methodName, overloadParams, engine, new long[1], new boolean[1], null);
        } catch (SingleFlightLruCache.CacheBusyException e) {
            return error(503, "decompile-busy");
        } catch (RuntimeException | LinkageError e) {
            return error(500, "decompile-failed");
        }
        if (cached == null) {
            return error(404, "class-not-found");
        }
        Slice slice = LineSlicer.slice(cached.source(), cached.totalLines(), startLine, maxLines);
        return new Result(200, slice.text());
    }

    private Result runAndFormat(String key, ResolvedClassInfo resolved, String scope, String methodName,
                                int overloadParams, Engine engine, Integer startLine, Integer maxLines,
                                boolean includeMeta) {
        long[] elapsed = new long[1];
        boolean[] fromCache = new boolean[1];
        CachedOutput cached;
        try {
            cached = decompileCached(resolved, scope, methodName, overloadParams, engine, elapsed, fromCache, null);
        } catch (SingleFlightLruCache.CacheBusyException e) {
            return error(503, "decompile-busy");
        } catch (RuntimeException | LinkageError e) {
            return error(500, "decompile-failed");
        }
        if (cached == null) {
            return error(404, "class-not-found");
        }
        Slice slice = LineSlicer.slice(cached.source(), cached.totalLines(), startLine, maxLines);
        // Compute methodLine dynamically for the requested method (never cached across sibling operations on scope=class)
        int methodLine = methodName != null && !methodName.isBlank()
                ? SourceMethodExtractor.findMethodLine(cached.source(), methodName, overloadParams)
                : 0;
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
            String metaJson;
            try {
                metaJson = buildClassInfoJson(resolved, new long[1], new boolean[1], cached.refs());
            } catch (SingleFlightLruCache.CacheBusyException e) {
                metaJson = error(503, "inspect-busy").json();
            } catch (RuntimeException | LinkageError e) {
                metaJson = error(500, "inspect-failed").json();
            }
            j.name("meta").raw(metaJson);
        }
        j.endObject();
        return new Result(200, j.toString());
    }

    private CachedOutput decompileCached(ResolvedClassInfo resolved, String scope, String methodName,
                                         int overloadParams, Engine engine, long[] elapsedMs, boolean[] fromCache,
                                         List<String> precomputedRefs) {
        boolean methodScope = "method".equals(scope);
        CacheKey cacheKey = new CacheKey(
                resolved.name(),
                resolved.bundleId(),
                resolved.bundleModified(),
                scope,
                methodScope ? methodName : null,
                methodScope ? overloadParams : -1,
                engine);
        long t0 = System.nanoTime();
        CachedOutput out = cache.getOrCompute(cacheKey, () -> {
            DecompileOptions opts = new DecompileOptions(methodScope ? methodName : null, overloadParams);
            String text = engine.impl.decompile(new BytecodeInput(resolved.name(), resolved.loader(), resolved.bytes()), opts);
            if (text == null || text.isBlank()) {
                return null;
            }
            List<String> refs = precomputedRefs != null
                    ? precomputedRefs
                    : ClassFileInspector.collectReferencedClasses(resolved.loader(), resolved.name(), resolved.bytes());
            return new CachedOutput(text, refs, LineSlicer.countLines(text));
        }, fromCache);
        elapsedMs[0] = fromCache[0] ? 0L : Math.max(1L, (System.nanoTime() - t0) / 1_000_000L);
        return out;
    }

    // ---- class & plugin inspection

    public Result inspectClass(String opKey, String classCandidates, long fromBundleId) {
        if (!enabled.getAsBoolean()) {
            return error(403, "decompile-disabled");
        }
        TargetResolution target;
        try {
            target = resolveTargetAndLoaders(opKey, classCandidates, fromBundleId);
        } catch (IllegalArgumentException e) {
            return error(400, e.getMessage());
        } catch (SpecException e) {
            return error(503, e.reason());
        }
        ResolvedClassInfo resolved = target.resolved();
        if (resolved == null) {
            return error(404, "class-not-found");
        }
        long[] elapsed = new long[1];
        boolean[] fromCache = new boolean[1];
        String body;
        try {
            body = buildClassInfoJson(resolved, elapsed, fromCache, null);
        } catch (SingleFlightLruCache.CacheBusyException e) {
            return error(503, "inspect-busy");
        } catch (RuntimeException | LinkageError e) {
            return error(500, "inspect-failed");
        }
        String enriched = body.substring(0, body.length() - 1)
                + ",\"inspectMs\":" + elapsed[0] + ",\"cached\":" + fromCache[0] + "}";
        return new Result(200, enriched);
    }

    public Result inspectPlugin(String pluginKey) {
        if (!enabled.getAsBoolean()) {
            return error(403, "decompile-disabled");
        }
        if (pluginKey == null || pluginKey.isBlank()) {
            return error(400, "missing-plugin");
        }
        if (pluginAccessor == null) {
            return error(404, "plugin-not-found");
        }
        long t0 = System.nanoTime();
        try {
            Plugin p = pluginAccessor.getPlugin(pluginKey.trim());
            if (p == null) {
                return error(404, "plugin-not-found");
            }
            Json j = new Json();
            AtlassianPluginInspector.writeStandalonePluginInspection(j, p, product, t0);
            return new Result(200, j.toString());
        } catch (RuntimeException | LinkageError e) {
            return error(500, "inspect-failed");
        }
    }

    private String buildClassInfoJson(ResolvedClassInfo resolved, long[] elapsedMs, boolean[] fromCache,
                                      List<String> precomputedRefs) {
        InspectKey key = new InspectKey(resolved.name(), resolved.bundleId(), resolved.bundleModified());
        long t0 = System.nanoTime();
        String json = inspectCache.getOrCompute(key, () -> buildClassInfoUncached(resolved, precomputedRefs), fromCache);
        elapsedMs[0] = fromCache[0] ? 0L : Math.max(1L, (System.nanoTime() - t0) / 1_000_000L);
        return json;
    }

    private String buildClassInfoUncached(ResolvedClassInfo resolved, List<String> precomputedRefs) {
        Class<?> c = resolved.loaded();
        if (c == null) {
            c = OsgiClassResolver.tryLoadClass(resolved.loader(), resolved.name());
        }
        List<String> refs = precomputedRefs != null
                ? precomputedRefs
                : ClassFileInspector.collectReferencedClasses(resolved.loader(), resolved.name(), resolved.bytes());
        String pkg = packageOf(resolved.name());
        String simple = simpleNameOf(resolved.name());
        BytecodeVersion bv = ClassFileInspector.readBytecodeVersion(resolved.bytes());

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
            MethodStats stats = inspectDeclaredMethods(c);
            j.field("kind", kind)
                    .field("modifiers", Modifier.toString(modBits))
                    .field("deprecated", ReflectiveBridge.safeHasAnnotation(c, Deprecated.class))
                    .optional("superclass", supers.isEmpty() ? null : supers.get(0))
                    .strings("superclasses", supers)
                    .strings("interfaces", interfaces)
                    .strings("annotations", AnnotationFormatter.annotations(c));
            Class<?> enclosing = safeEnclosing(c);
            j.optional("enclosingClass", enclosing == null ? null : enclosing.getName());
            j.strings("innerClasses", safeInnerClasses(c));
            j.field("fieldCount", safeFieldCount(c));
            j.field("constructorCount", safeConstructorCount(c));
            j.field("methodCount", stats.count)
                    .strings("methods", stats.summaries);
            j.field("codeSource", codeSource(c))
                    .field("classLoader", OsgiBundleInspector.clip(String.valueOf(c.getClassLoader())))
                    .field("origin", OsgiBundleInspector.origin(c));
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
                    .field("classLoader", OsgiBundleInspector.clip(String.valueOf(resolved.loader())))
                    .field("origin", resolved.loader() == null ? "JDK" : resolved.loader().getClass().getSimpleName());
        }

        if (bv != null) {
            j.field("bytecodeVersion", bv.label());
            j.field("bytecodeMajor", bv.major());
        }
        j.field("bytecodeBytes", resolved.bytes() == null ? 0 : resolved.bytes().length);
        j.field("bundleId", resolved.bundleId());

        Bundle bundle = OsgiClassResolver.bundleByIdOrClass(resolved.bundleId(), c);
        if (bundle != null) {
            j.name("bundle");
            OsgiBundleInspector.writeBundleSummary(j, bundle, pkg);
            Plugin owner = AtlassianPluginInspector.pluginForBundle(pluginAccessor, bundle);
            if (owner != null) {
                j.name("plugin");
                AtlassianPluginInspector.writePluginSummary(j, owner, product);
            }
        }
        j.field("refCount", refs.size())
                .strings("refs", refs)
                .endObject();
        return j.toString();
    }

    // ---- agent-friendly graph traversal, search, batch, operation bundle

    public Result traverseGraph(String opKey, String classCandidates, long fromBundleId,
                                int rawDepth, int rawMaxNodes, boolean includeJdk, String packagePrefix,
                                boolean includeSources, String decompiler) {
        if (!enabled.getAsBoolean()) {
            return error(403, "decompile-disabled");
        }
        int depth = Math.max(1, Math.min(3, rawDepth <= 0 ? 1 : rawDepth));
        int capLimit = includeSources ? MAX_GRAPH_NODES_WITH_SOURCES : 100;
        int maxNodes = Math.max(1, Math.min(capLimit, rawMaxNodes <= 0 ? (includeSources ? 10 : 30) : rawMaxNodes));
        String prefix = packagePrefix == null ? "" : packagePrefix.trim();
        Engine engine = Engine.parse(decompiler);
        long t0 = System.nanoTime();

        // Hoist context loaders ONCE outside BFS loop (and never resolve opKey twice)
        List<ClassLoader> baseLoaders;
        ResolvedClassInfo root;
        try {
            TargetResolution target = resolveTargetAndLoaders(opKey, classCandidates, fromBundleId);
            baseLoaders = target.loaders();
            root = target.resolved();
        } catch (IllegalArgumentException e) {
            return error(400, e.getMessage());
        } catch (SpecException e) {
            return error(503, e.reason());
        }
        if (root == null) {
            return error(404, "class-not-found");
        }

        GraphResult graph = ClassGraphTraverser.traverse(
                root,
                baseLoaders,
                (fqcn, hintLoaders) -> OsgiClassResolver.resolveFromCandidates(List.of(fqcn), hintLoaders),
                depth,
                maxNodes,
                includeJdk,
                prefix,
                GRAPH_TIME_BUDGET_MS);

        long deadlineNanos = t0 + GRAPH_TIME_BUDGET_MS * 1_000_000L;
        boolean sourceDeadlineExceeded = false;
        Map<String, CachedOutput> nodeSources = new LinkedHashMap<>();
        Map<String, String> nodeSourceErrors = new LinkedHashMap<>();
        if (includeSources) {
            for (ResolvedClassInfo r : graph.visited().values()) {
                if (System.nanoTime() - deadlineNanos > 0) {
                    sourceDeadlineExceeded = true;
                    break;
                }
                try {
                    // Never pass graph-filtered outs as precomputedRefs (that would poison the global decompile cache)
                    CachedOutput src = decompileCached(r, "class", null, -1, engine, new long[1], new boolean[1], null);
                    if (src != null) {
                        nodeSources.put(r.name(), src);
                    }
                } catch (RuntimeException | LinkageError e) {
                    nodeSourceErrors.put(r.name(), OsgiBundleInspector.clip(String.valueOf(e)));
                }
            }
        }
        long elapsedMs = Math.max(1L, (System.nanoTime() - t0) / 1_000_000L);
        Json j = new Json().beginObject()
                .field("format", 1)
                .field("root", root.name())
                .field("depth", depth)
                .field("maxNodes", maxNodes)
                .field("nodeCount", graph.visited().size())
                .field("truncated", graph.truncated() || sourceDeadlineExceeded)
                .field("traverseMs", elapsedMs)
                .name("nodes").beginArray();

        for (ResolvedClassInfo r : graph.visited().values()) {
            List<String> outs = graph.adjacency().getOrDefault(r.name(), List.of());
            Class<?> c = r.loaded();
            Bundle b = OsgiClassResolver.bundleByIdOrClass(r.bundleId(), c);
            Plugin owner = AtlassianPluginInspector.pluginForBundle(pluginAccessor, b);
            j.beginObject()
                    .field("class", r.name())
                    .field("simpleName", simpleNameOf(r.name()))
                    .field("kind", c == null ? "class" : (c.isAnnotation() ? "annotation" : c.isInterface() ? "interface"
                            : c.isEnum() ? "enum" : c.isRecord() ? "record" : "class"))
                    .field("bundleId", r.bundleId())
                    .optional("bundle", b == null ? null : b.getSymbolicName() + " " + b.getVersion())
                    .optional("plugin", owner == null ? null : owner.getKey())
                    .optional("pluginName", owner == null ? null : owner.getName())
                    .field("methodCount", safeMethodCount(c))
                    .strings("refs", outs);
            if (includeSources) {
                CachedOutput src = nodeSources.get(r.name());
                if (src != null) {
                    Slice bounded = LineSlicer.slice(src.source(), src.totalLines(), 1, MAX_GRAPH_SOURCE_LINES);
                    j.field("decompiler", engine.label)
                            .field("totalLines", src.totalLines())
                            .field("source", bounded.text());
                    if (bounded.truncated()) {
                        j.field("sourceTruncated", true);
                    }
                } else {
                    String err = nodeSourceErrors.get(r.name());
                    if (err != null) {
                        j.field("sourceError", err);
                    }
                }
            }
            j.endObject();
        }
        j.endArray().name("edges").beginArray();
        for (String[] edge : graph.edges()) {
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
        if (query.contains("..")) {
            return error(400, "invalid-class");
        }
        int limit = Math.max(1, Math.min(100, rawLimit <= 0 ? 30 : rawLimit));
        List<ClassLoader> loaders = OsgiClassResolver.buildContextLoaders(
                bundleIdFilter == null ? -1L : bundleIdFilter, null, OperationSource.class);
        SearchResult sr = OsgiClassSearcher.search(query, limit, bundleIdFilter, loaders, bundle -> {
            Plugin owner = AtlassianPluginInspector.pluginForBundle(pluginAccessor, bundle);
            return owner == null ? null : owner.getKey();
        });

        Json j = new Json().beginObject()
                .field("format", 1)
                .field("query", query)
                .field("limit", limit)
                .field("count", sr.hits().size())
                .field("truncated", sr.truncated())
                .name("results").beginArray();
        for (SearchHit h : sr.hits()) {
            j.beginObject()
                    .field("class", h.fqcn())
                    .field("simpleName", simpleNameOf(h.fqcn()))
                    .field("bundleId", h.bundleId())
                    .optional("bundle", h.bundleLabel())
                    .optional("plugin", h.pluginKey())
                    .endObject();
        }
        j.endArray().endObject();
        return new Result(200, j.toString());
    }

    public Result operationBundle(String opKey, String scope, String decompiler, OperationDetails details) {
        if (!enabled.getAsBoolean()) {
            return error(403, "decompile-disabled");
        }
        if (opKey == null || opKey.isBlank()) {
            return error(400, "missing-op");
        }
        ResolvedOp op;
        try {
            op = resolveOperation(opKey);
        } catch (SpecException e) {
            return error(503, e.reason());
        }
        if (op.error != null) {
            return op.error;
        }
        // Reuse the single resolved module + handler for both details and source (avoids duplicate Jersey walk!)
        Result detailRes = details.describeHandler(opKey, op.module, op.handler);
        if (detailRes.status() != 200) {
            return detailRes;
        }
        Engine engine = Engine.parse(decompiler);
        Method handling = op.handler.handling();
        ResolvedClassInfo resolved = OsgiClassResolver.resolveLoaded(TypeProxyUnwrapper.targetClass(handling.getDeclaringClass()));
        Result srcRes;
        if (resolved == null) {
            srcRes = error(404, "class-not-found");
        } else {
            boolean wholeClass = "class".equalsIgnoreCase(scope);
            srcRes = runAndFormat(opKey, resolved, wholeClass ? "class" : "method",
                    handling.getName(), handling.getParameterCount(), engine, null, null, false);
        }
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
        Engine engine = Engine.parse(decompiler);
        List<ClassLoader> baseLoaders = loadersFor(opKey, fromBundleId);
        int cap = Math.min(classes.size(), 10);
        Json j = new Json().beginObject()
                .field("format", 1)
                .field("count", cap)
                .field("truncated", classes.size() > 10)
                .name("results").beginArray();
        for (int i = 0; i < cap; i++) {
            String cls = classes.get(i);
            List<String> candidates = OsgiClassResolver.parseCandidates(cls);
            Result item;
            if (candidates.isEmpty()) {
                item = error(400, "invalid-class");
            } else {
                ResolvedClassInfo resolved = OsgiClassResolver.resolveFromCandidates(candidates, baseLoaders);
                if (resolved == null) {
                    item = error(404, "class-not-found");
                } else if (includeSource) {
                    item = runAndFormat(opKey, resolved, "class", null, -1, engine, null, maxLines, includeMeta);
                } else {
                    long[] elapsed = new long[1];
                    boolean[] fromCache = new boolean[1];
                    try {
                        String body = buildClassInfoJson(resolved, elapsed, fromCache, null);
                        String enriched = body.substring(0, body.length() - 1)
                                + ",\"inspectMs\":" + elapsed[0] + ",\"cached\":" + fromCache[0] + "}";
                        item = new Result(200, enriched);
                    } catch (SingleFlightLruCache.CacheBusyException e) {
                        item = error(503, "inspect-busy");
                    } catch (RuntimeException | LinkageError e) {
                        item = error(500, "inspect-failed");
                    }
                }
            }
            j.beginObject()
                    .field("requested", cls)
                    .field("status", item.status())
                    .name("result").raw(item.json())
                    .endObject();
        }
        j.endArray().endObject();
        return new Result(200, j.toString());
    }

    // ---- helpers & delegating hooks for tests

    private record ResolvedOp(RestModule module, Handler handler, Result error) {
    }

    private ResolvedOp resolveOperation(String opKey) throws SpecException {
        RestModule module = OperationDetails.moduleOf(discovery.discover(), opKey);
        if (module == null) {
            return new ResolvedOp(null, null, error(404, "unknown-module"));
        }
        JerseyModelSource source = jersey.get();
        if (source == null || !module.restV2()) {
            return new ResolvedOp(module, null, error(404, "not-described"));
        }
        Optional<Handler> handler = source.handler(module, opKey);
        if (handler.isEmpty() || handler.get().handling() == null) {
            return new ResolvedOp(module, null, error(404, "unknown-operation"));
        }
        return new ResolvedOp(module, handler.get(), null);
    }

    private record TargetResolution(List<ClassLoader> loaders, ResolvedClassInfo resolved) {
    }

    /** Best-effort loader resolution when {@code opKey} is supplied as an auxiliary hint alongside class candidates. */
    private List<ClassLoader> loadersFor(String opKey, long fromBundleId) {
        Class<?> handlerCls = null;
        Class<?> declaringCls = null;
        if (opKey != null && !opKey.isBlank()) {
            try {
                RestModule module = OperationDetails.moduleOf(discovery.discover(), opKey);
                JerseyModelSource src = jersey.get();
                if (module != null && src != null && module.restV2()) {
                    Optional<Handler> h = src.handler(module, opKey);
                    if (h.isPresent()) {
                        if (h.get().handlerClass() != null) {
                            handlerCls = TypeProxyUnwrapper.targetClass(h.get().handlerClass());
                        }
                        if (h.get().handling() != null) {
                            declaringCls = TypeProxyUnwrapper.targetClass(h.get().handling().getDeclaringClass());
                        }
                    }
                }
            } catch (SpecException | RuntimeException | LinkageError ignored) {
                // best-effort classloader hint only
            }
        }
        return buildHandlerLoaders(fromBundleId, handlerCls, declaringCls);
    }

    private static List<ClassLoader> buildHandlerLoaders(long fromBundleId, Class<?> handlerCls, Class<?> declaringCls) {
        List<ClassLoader> base = OsgiClassResolver.buildContextLoaders(
                fromBundleId, handlerCls != null ? handlerCls : declaringCls, OperationSource.class);
        if (handlerCls != null && declaringCls != null && handlerCls != declaringCls) {
            ClassLoader declLoader = declaringCls.getClassLoader();
            if (declLoader != null && !base.contains(declLoader)) {
                List<ClassLoader> merged = new ArrayList<>(base.size() + 1);
                merged.addAll(base);
                merged.add(declLoader);
                return List.copyOf(merged);
            }
        }
        return base;
    }

    /** Resolves both context loaders and the target class in a single Jersey walk when {@code classCandidates} is omitted. */
    private TargetResolution resolveTargetAndLoaders(String opKey, String classCandidates, long fromBundleId)
            throws SpecException {
        if (classCandidates != null && !classCandidates.isBlank()) {
            List<String> cands = OsgiClassResolver.parseCandidates(classCandidates);
            if (cands.isEmpty()) {
                throw new IllegalArgumentException("invalid-class");
            }
            List<ClassLoader> loaders = loadersFor(opKey, fromBundleId);
            return new TargetResolution(loaders, OsgiClassResolver.resolveFromCandidates(cands, loaders));
        }
        if (opKey != null && !opKey.isBlank()) {
            RestModule module = OperationDetails.moduleOf(discovery.discover(), opKey);
            JerseyModelSource src = jersey.get();
            if (module == null || src == null || !module.restV2()) {
                return new TargetResolution(
                        OsgiClassResolver.buildContextLoaders(fromBundleId, null, OperationSource.class), null);
            }
            Optional<Handler> h = src.handler(module, opKey);
            if (h.isEmpty() || h.get().handling() == null) {
                return new TargetResolution(
                        OsgiClassResolver.buildContextLoaders(fromBundleId, null, OperationSource.class), null);
            }
            Class<?> resourceCls = h.get().handlerClass() == null ? null
                    : TypeProxyUnwrapper.targetClass(h.get().handlerClass());
            Class<?> handlerCls = TypeProxyUnwrapper.targetClass(h.get().handling().getDeclaringClass());
            List<ClassLoader> loaders = buildHandlerLoaders(fromBundleId, resourceCls, handlerCls);
            return new TargetResolution(loaders, OsgiClassResolver.resolveLoaded(handlerCls));
        }
        throw new IllegalArgumentException("missing-class");
    }

    private static int safeMethodCount(Class<?> c) {
        if (c == null) {
            return 0;
        }
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

    private static String cleanMethodFilter(String raw) {
        return raw != null && !raw.isBlank() ? raw.trim() : null;
    }

    private record MethodStats(int count, List<String> summaries) {
    }

    private static MethodStats inspectDeclaredMethods(Class<?> c) {
        try {
            Method[] methods = c.getDeclaredMethods();
            Arrays.sort(methods, Comparator.comparing(Method::getName).thenComparingInt(Method::getParameterCount));
            int count = 0;
            List<String> summaries = new ArrayList<>();
            for (Method m : methods) {
                if (m.isSynthetic() || m.isBridge()) {
                    continue;
                }
                count++;
                if (summaries.size() < MAX_METHOD_SUMMARIES) {
                    StringBuilder sb = new StringBuilder();
                    String mods = Modifier.toString(m.getModifiers() & Modifier.methodModifiers());
                    if (!mods.isEmpty()) {
                        sb.append(mods).append(' ');
                    }
                    sb.append(TypeFormatter.shortTypeName(safeGenericReturnType(m))).append(' ')
                            .append(m.getName()).append('(');
                    Type[] pts = safeGenericParameterTypes(m);
                    for (int i = 0; i < pts.length; i++) {
                        if (i > 0) {
                            sb.append(", ");
                        }
                        sb.append(TypeFormatter.shortTypeName(pts[i]));
                    }
                    sb.append(')');
                    summaries.add(sb.toString());
                }
            }
            return new MethodStats(count, summaries);
        } catch (LinkageError | RuntimeException e) {
            return new MethodStats(0, List.of());
        }
    }

    private static Type safeGenericReturnType(Method m) {
        try {
            return m.getGenericReturnType();
        } catch (RuntimeException | LinkageError e) {
            return m.getReturnType();
        }
    }

    private static Type[] safeGenericParameterTypes(Method m) {
        try {
            return m.getGenericParameterTypes();
        } catch (RuntimeException | LinkageError e) {
            return m.getParameterTypes();
        }
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

    private static String codeSource(Class<?> c) {
        try {
            CodeSource cs = c.getProtectionDomain().getCodeSource();
            return cs == null || cs.getLocation() == null ? null : OsgiBundleInspector.clip(cs.getLocation().toString());
        } catch (RuntimeException e) {
            return null;
        }
    }

    // Delegating package-private helpers for unit tests
    static Class<?> targetClass(Class<?> cls) {
        return TypeProxyUnwrapper.targetClass(cls);
    }

    static List<String> parseCandidates(String raw) {
        return OsgiClassResolver.parseCandidates(raw);
    }

    static List<String> nestedVariants(String name) {
        return OsgiClassResolver.nestedVariants(name);
    }

    static String cleanSource(String raw) {
        return DecompilerEngine.cleanSource(raw, MAX_SOURCE);
    }

    static String extractMethod(String classSource, String methodName) {
        return SourceMethodExtractor.extractMethod(classSource, methodName);
    }

    static int findMethodLine(String source, String methodName) {
        return SourceMethodExtractor.findMethodLine(source, methodName);
    }

    static Set<String> constantPoolClasses(byte[] classBytes) {
        return ClassFileInspector.constantPoolClasses(classBytes);
    }

    private static Result error(int status, String reason) {
        return new Result(status, new Json().beginObject().field("error", reason).endObject().toString());
    }
}
