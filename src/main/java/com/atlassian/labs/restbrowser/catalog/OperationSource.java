package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.CatalogQuery.TopResolution;
import com.atlassian.labs.restbrowser.catalog.JerseyModelSource.Handler;
import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.OperationSpec;
import com.atlassian.labs.restbrowser.catalog.Model.Param;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.labs.restbrowser.catalog.OperationDetails.Result;
import com.atlassian.labs.restbrowser.catalog.SpecSource.SpecException;
import com.atlassian.labs.restbrowser.decompile.CfrEngine;
import com.atlassian.labs.restbrowser.decompile.DecompilerEngine;
import com.atlassian.labs.restbrowser.decompile.DecompilerEngine.BytecodeInput;
import com.atlassian.labs.restbrowser.decompile.DecompilerEngine.DecompileOptions;
import com.atlassian.labs.restbrowser.decompile.DecompilerEngine.DecompileOutput;
import com.atlassian.labs.restbrowser.decompile.LineSlicer;
import com.atlassian.labs.restbrowser.decompile.LineSlicer.Slice;
import com.atlassian.labs.restbrowser.decompile.SourceMethodExtractor;
import com.atlassian.labs.restbrowser.decompile.VineflowerEngine;
import com.atlassian.labs.restbrowser.inspect.ClassFileInspector;
import com.atlassian.labs.restbrowser.inspect.ClassFileInspector.BytecodeVersion;
import com.atlassian.labs.restbrowser.inspect.ClassFileInspector.MethodOutline;
import com.atlassian.labs.restbrowser.inspect.ClassGraphTraverser;
import com.atlassian.labs.restbrowser.inspect.ClassGraphTraverser.GraphResult;
import com.atlassian.labs.restbrowser.inspect.ClassGraphTraverser.ResolvedClassInfo;
import com.atlassian.labs.restbrowser.inspect.DtoSchemaInspector;
import com.atlassian.labs.restbrowser.inspect.DtoSchemaInspector.SchemaResult;
import com.atlassian.labs.restbrowser.inspect.SingleFlightLruCache;
import com.atlassian.labs.restbrowser.inspect.TypeProxyUnwrapper;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiBundleInspector;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiBundleResourceReader;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiBundleResourceReader.ResourceContent;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiBundleResourceReader.ResourceEntry;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiBundleResourceReader.ResourceList;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiBytecodeScanner;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiBytecodeScanner.CallerHit;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiBytecodeScanner.CallersResult;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiBytecodeScanner.GrepHit;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiBytecodeScanner.GrepResult;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiClassResolver;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiClassSearcher;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiClassSearcher.SearchHit;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiClassSearcher.SearchResult;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiImplementationFinder;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiImplementationFinder.ImplHit;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiImplementationFinder.ImplementationResult;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiImplementationFinder.OsgiServiceHit;
import com.atlassian.labs.restbrowser.jaxrs.AnnotationFormatter;
import com.atlassian.labs.restbrowser.jaxrs.OpenApiAnnotationExtractor;
import com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge;
import com.atlassian.labs.restbrowser.jaxrs.TypeFormatter;
import com.atlassian.labs.restbrowser.json.Json;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import org.osgi.framework.Bundle;

import java.lang.annotation.Annotation;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Parameter;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.util.LinkedHashMap;
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
    private static final int MAX_FIELDS = 80;
    private static final int MAX_ENUM_CONSTANTS = 200;

    public record BatchItem(String cls, long fromBundle, String opKey, String scope, String method, String decompiler,
                            boolean includeSource, boolean includeMeta, boolean includeSchema,
                            Integer startLine, Integer maxLines, boolean lineNumbers) {
    }

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

    private record CachedOutput(String source, List<String> refs, int totalLines, List<String> warnings) {
    }

    private record InspectKey(String className, long bundleId, long bundleModified, boolean compact, boolean outline) {
    }

    public record OperationSchemas(String requestSchemaJson, String requestExampleJson,
                                   String responseSchemaJson, String responseExampleJson) {
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
        return decompile(opKey, classCandidates, fromBundleId, scope, decompiler, methodFilter, startLine, maxLines,
                includeMeta, false);
    }

    public Result decompile(String opKey, String classCandidates, long fromBundleId, String scope, String decompiler,
                            String methodFilter, Integer startLine, Integer maxLines, boolean includeMeta,
                            boolean lineNumbers) {
        if (!enabled.getAsBoolean()) {
            return disabledError();
        }
        Engine engine = Engine.parse(decompiler);
        if (classCandidates != null && !classCandidates.isBlank()) {
            List<String> candidates = OsgiClassResolver.parseCandidates(classCandidates);
            if (candidates.isEmpty()) {
                return error(400, "invalid-class", "Pass a valid binary Java class name without '..'.");
            }
            List<ClassLoader> loaders = loadersFor(opKey, fromBundleId);
            ResolvedClassInfo resolved = OsgiClassResolver.resolveFromCandidates(candidates, loaders);
            if (resolved == null) {
                return classNotFoundResult(candidates.get(0), fromBundleId, loaders);
            }
            String targetMethod = cleanMethodFilter(methodFilter);
            String resolvedScope = ("method".equalsIgnoreCase(scope) && targetMethod != null) ? "method" : "class";
            return runAndFormat(opKey, resolved, resolvedScope, targetMethod, -1, engine,
                    startLine, maxLines, includeMeta, lineNumbers, true);
        }
        return decompileOp(opKey, scope, engine, methodFilter, startLine, maxLines, includeMeta, lineNumbers, false);
    }

    public Result decompileText(String opKey, String classCandidates, long fromBundleId, String scope,
                                String decompiler, String methodFilter, Integer startLine, Integer maxLines) {
        return decompileText(opKey, classCandidates, fromBundleId, scope, decompiler, methodFilter,
                startLine, maxLines, false);
    }

    public Result decompileText(String opKey, String classCandidates, long fromBundleId, String scope,
                                String decompiler, String methodFilter, Integer startLine, Integer maxLines,
                                boolean lineNumbers) {
        if (!enabled.getAsBoolean()) {
            return disabledError();
        }
        Engine engine = Engine.parse(decompiler);
        if (classCandidates != null && !classCandidates.isBlank()) {
            List<String> candidates = OsgiClassResolver.parseCandidates(classCandidates);
            if (candidates.isEmpty()) {
                return error(400, "invalid-class", "Pass a valid binary Java class name without '..'.");
            }
            List<ClassLoader> loaders = loadersFor(opKey, fromBundleId);
            ResolvedClassInfo resolved = OsgiClassResolver.resolveFromCandidates(candidates, loaders);
            if (resolved == null) {
                return classNotFoundResult(candidates.get(0), fromBundleId, loaders);
            }
            String targetMethod = cleanMethodFilter(methodFilter);
            String resolvedScope = ("method".equalsIgnoreCase(scope) && targetMethod != null) ? "method" : "class";
            return runAndFormatText(resolved, resolvedScope, targetMethod, -1, engine, startLine, maxLines, lineNumbers);
        }
        return decompileOp(opKey, scope, engine, methodFilter, startLine, maxLines, false, lineNumbers, true);
    }

    private Result decompileOp(String opKey, String scope, Engine engine, String methodFilter,
                               Integer startLine, Integer maxLines, boolean includeMeta, boolean lineNumbers,
                               boolean plainText) {
        if (opKey == null || opKey.isBlank()) {
            return error(400, "missing-op", "Pass ?op={operationKey} from /catalog/operations.");
        }
        ResolvedOp op;
        try {
            op = resolveOperation(opKey);
        } catch (SpecException e) {
            return specExceptionResult(opKey, e);
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
                ? runAndFormatText(resolved, resolvedScope, targetMethod, paramCount, engine, startLine, maxLines, lineNumbers)
                : runAndFormat(opKey, resolved, resolvedScope, targetMethod, paramCount, engine,
                        startLine, maxLines, includeMeta, lineNumbers, true);
    }

    Result decompileMethod(String key, Method method) {
        return decompileMethod(key, method, Engine.VINEFLOWER);
    }

    Result decompileMethod(String key, Method method, Engine engine) {
        ResolvedClassInfo resolved = OsgiClassResolver.resolveLoaded(TypeProxyUnwrapper.targetClass(method.getDeclaringClass()));
        if (resolved == null) {
            return error(404, "class-not-found");
        }
        return runAndFormat(key, resolved, "method", method.getName(), method.getParameterCount(), engine,
                null, null, false, false, true);
    }

    Result decompileClass(String key, Class<?> cls, Engine engine) {
        ResolvedClassInfo resolved = OsgiClassResolver.resolveLoaded(TypeProxyUnwrapper.targetClass(cls));
        if (resolved == null) {
            return error(404, "class-not-found");
        }
        return runAndFormat(key, resolved, "class", null, -1, engine, null, null, false, false, true);
    }

    private Result runAndFormatText(ResolvedClassInfo resolved, String scope, String methodName, int overloadParams,
                                    Engine engine, Integer startLine, Integer maxLines, boolean lineNumbers) {
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
        String body = lineNumbers ? LineSlicer.formatWithLineNumbers(slice.text(), slice.startLine()) : slice.text();
        return new Result(200, body);
    }

    private Result runAndFormat(String key, ResolvedClassInfo resolved, String scope, String methodName,
                                int overloadParams, Engine engine, Integer startLine, Integer maxLines,
                                boolean includeMeta, boolean lineNumbers, boolean includeRefs) {
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
        String text = lineNumbers ? LineSlicer.formatWithLineNumbers(slice.text(), slice.startLine()) : slice.text();
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
        if (lineNumbers) {
            j.field("lineNumbers", true);
        }
        j.field("decompileMs", elapsed[0])
                .field("cached", fromCache[0])
                .field("source", text);
        if (!cached.warnings().isEmpty()) {
            j.strings("warnings", cached.warnings());
            j.field("decompilerFallback", engine == Engine.VINEFLOWER ? Engine.CFR.id : Engine.VINEFLOWER.id);
        }
        if (includeRefs) {
            j.strings("refs", cached.refs());
        } else {
            j.field("refCount", cached.refs().size());
        }
        if (includeMeta) {
            String metaJson;
            try {
                metaJson = buildClassInfoJson(resolved, new long[1], new boolean[1], cached.refs(), false, false);
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
            DecompileOutput diag = engine.impl.decompileWithDiagnostics(
                    new BytecodeInput(resolved.name(), resolved.loader(), resolved.bytes()), opts);
            String text = diag.source();
            if (text == null || text.isBlank()) {
                return null;
            }
            List<String> refs = precomputedRefs != null
                    ? precomputedRefs
                    : ClassFileInspector.collectReferencedClasses(resolved.loader(), resolved.name(), resolved.bytes());
            return new CachedOutput(text, refs, LineSlicer.countLines(text), diag.warnings());
        }, fromCache);
        elapsedMs[0] = fromCache[0] ? 0L : Math.max(1L, (System.nanoTime() - t0) / 1_000_000L);
        return out;
    }

    // ---- class & plugin inspection

    public Result inspectClass(String opKey, String classCandidates, long fromBundleId) {
        return inspectClass(opKey, classCandidates, fromBundleId, false, false, false);
    }

    public Result inspectClass(String opKey, String classCandidates, long fromBundleId, boolean compact) {
        return inspectClass(opKey, classCandidates, fromBundleId, compact, false, false);
    }

    public Result inspectClass(String opKey, String classCandidates, long fromBundleId,
                               boolean compact, boolean outline, boolean includeImplementations) {
        if (!enabled.getAsBoolean()) {
            return disabledError();
        }
        TargetResolution target;
        try {
            target = resolveTargetAndLoaders(opKey, classCandidates, fromBundleId);
        } catch (IllegalArgumentException e) {
            return invalidTargetError(e.getMessage());
        } catch (SpecException e) {
            return specExceptionResult(opKey, e);
        }
        ResolvedClassInfo resolved = target.resolved();
        if (resolved == null) {
            return classNotFoundResult(classCandidates, fromBundleId, target.loaders());
        }
        long[] elapsed = new long[1];
        boolean[] fromCache = new boolean[1];
        String body;
        try {
            body = buildClassInfoJson(resolved, elapsed, fromCache, null, compact, outline);
        } catch (SingleFlightLruCache.CacheBusyException e) {
            return error(503, "inspect-busy");
        } catch (RuntimeException | LinkageError e) {
            return error(500, "inspect-failed");
        }
        StringBuilder extra = new StringBuilder();
        Class<?> loaded = resolved.loaded();
        boolean abstractOrInterface = loaded != null
                && (loaded.isInterface() || Modifier.isAbstract(loaded.getModifiers()));
        if (abstractOrInterface || includeImplementations) {
            List<OsgiServiceHit> services = OsgiImplementationFinder.findServicesOnly(
                    resolved.name(), this::pluginKeyForBundle);
            if (!services.isEmpty()) {
                extra.append(",\"osgiServices\":").append(serializeServices(services));
            }
            if (includeImplementations) {
                ImplementationResult ir = OsgiImplementationFinder.find(
                        resolved.name(), resolved.bundleId(), null, null, false, 10, this::pluginKeyForBundle);
                extra.append(",\"implementations\":").append(serializeImplHits(ir.implementations()));
            }
            if (abstractOrInterface) {
                extra.append(",\"hint\":").append(Json.quote(
                        "Abstract/interface type; inspect implementations via GET /rest/restbrowser/1/code/implementations?class="
                                + resolved.name()));
            }
        }
        String enriched = body.substring(0, body.length() - 1)
                + extra
                + ",\"inspectMs\":" + elapsed[0] + ",\"cached\":" + fromCache[0] + "}";
        return new Result(200, enriched);
    }

    public Result inspectPlugin(String pluginKey) {
        return inspectPlugin(pluginKey, false);
    }

    public Result inspectPlugin(String pluginKey, boolean compact) {
        if (!enabled.getAsBoolean()) {
            return disabledError();
        }
        if (pluginKey == null || pluginKey.isBlank()) {
            return error(400, "missing-plugin", "Pass ?key={pluginKey}.");
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
            AtlassianPluginInspector.writeStandalonePluginInspection(j, p, product, t0, compact);
            return new Result(200, j.toString());
        } catch (RuntimeException | LinkageError e) {
            return error(500, "inspect-failed");
        }
    }

    private String buildClassInfoJson(ResolvedClassInfo resolved, long[] elapsedMs, boolean[] fromCache,
                                      List<String> precomputedRefs, boolean compact, boolean outline) {
        InspectKey key = new InspectKey(resolved.name(), resolved.bundleId(), resolved.bundleModified(), compact, outline);
        long t0 = System.nanoTime();
        String json = inspectCache.getOrCompute(key, () -> buildClassInfoUncached(resolved, precomputedRefs, compact, outline), fromCache);
        elapsedMs[0] = fromCache[0] ? 0L : Math.max(1L, (System.nanoTime() - t0) / 1_000_000L);
        return json;
    }

    private String buildClassInfoUncached(ResolvedClassInfo resolved, List<String> precomputedRefs,
                                          boolean compact, boolean outline) {
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
            List<FieldSummary> fields = inspectDeclaredFields(c);
            j.field("kind", kind)
                    .field("modifiers", Modifier.toString(modBits))
                    .field("deprecated", ReflectiveBridge.safeHasAnnotation(c, Deprecated.class))
                    .optional("superclass", supers.isEmpty() ? null : supers.get(0))
                    .strings("superclasses", supers)
                    .strings("interfaces", interfaces);
            if (!compact) {
                j.strings("annotations", AnnotationFormatter.annotations(c));
            }
            if (c.isEnum()) {
                j.strings("enumConstants", inspectEnumConstants(c));
            }
            Class<?> enclosing = safeEnclosing(c);
            j.optional("enclosingClass", enclosing == null ? null : enclosing.getName());
            if (!compact) {
                j.strings("innerClasses", safeInnerClasses(c));
            }
            j.field("fieldCount", fields.size());
            writeFieldSummaries(j, fields, !compact);
            j.field("constructorCount", safeConstructorCount(c))
                    .field("methodCount", stats.count)
                    .strings("methods", stats.summaries)
                    .field("codeSource", codeSource(c))
                    .field("classLoader", OsgiBundleInspector.clip(String.valueOf(c.getClassLoader())))
                    .field("origin", OsgiBundleInspector.origin(c));
        } else {
            j.field("kind", "class")
                    .field("modifiers", "")
                    .field("deprecated", false)
                    .strings("superclasses", List.of())
                    .strings("interfaces", List.of());
            if (!compact) {
                j.strings("annotations", List.of())
                        .strings("innerClasses", List.of());
            }
            j.field("fieldCount", 0)
                    .name("fields").beginArray().endArray()
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
            if (compact) {
                j.beginObject()
                        .field("id", bundle.getBundleId())
                        .field("symbolicName", bundle.getSymbolicName())
                        .field("version", String.valueOf(bundle.getVersion()))
                        .field("state", OsgiBundleInspector.state(bundle.getState()))
                        .endObject();
            } else {
                OsgiBundleInspector.writeBundleSummary(j, bundle, pkg);
            }
            Plugin owner = AtlassianPluginInspector.pluginForBundle(pluginAccessor, bundle);
            if (owner != null) {
                j.name("plugin");
                AtlassianPluginInspector.writePluginSummary(j, owner, product);
            }
        }
        j.field("refCount", refs.size());
        if (!compact) {
            j.strings("refs", refs);
        }
        if (outline) {
            List<MethodOutline> outlines = ClassFileInspector.readMethodOutlines(resolved.bytes());
            j.name("outline").beginArray();
            for (MethodOutline mo : outlines) {
                j.beginObject()
                        .field("name", mo.name())
                        .field("signature", mo.signature())
                        .field("startLine", mo.startLine())
                        .field("endLine", mo.endLine())
                        .endObject();
            }
            j.endArray();
        }
        j.endObject();
        return j.toString();
    }

    // ---- agent-friendly graph traversal, search, batch, operation bundle, schema, implementations, grep, callers

    public Result traverseGraph(String opKey, String classCandidates, long fromBundleId,
                                int rawDepth, int rawMaxNodes, boolean includeJdk, String packagePrefix,
                                boolean includeSources, String decompiler) {
        return traverseGraph(opKey, classCandidates, fromBundleId, rawDepth, rawMaxNodes, includeJdk, false,
                packagePrefix, includeSources, decompiler, null);
    }

    public Result traverseGraph(String opKey, String classCandidates, long fromBundleId,
                                int rawDepth, int rawMaxNodes, boolean includeJdk, boolean excludeLibraries,
                                String packagePrefix, boolean includeSources, String decompiler) {
        return traverseGraph(opKey, classCandidates, fromBundleId, rawDepth, rawMaxNodes, includeJdk, excludeLibraries,
                packagePrefix, includeSources, decompiler, null);
    }

    public Result traverseGraph(String opKey, String classCandidates, long fromBundleId,
                                int rawDepth, int rawMaxNodes, boolean includeJdk, boolean excludeLibraries,
                                String packagePrefix, boolean includeSources, String decompiler,
                                String edgeKindsFilter) {
        if (!enabled.getAsBoolean()) {
            return disabledError();
        }
        int depth = Math.max(1, Math.min(3, rawDepth <= 0 ? 1 : rawDepth));
        int capLimit = includeSources ? MAX_GRAPH_NODES_WITH_SOURCES : 100;
        int maxNodes = Math.max(1, Math.min(capLimit, rawMaxNodes <= 0 ? (includeSources ? 10 : 30) : rawMaxNodes));
        String prefix = packagePrefix == null ? "" : packagePrefix.trim();
        Engine engine = Engine.parse(decompiler);
        Set<String> allowedKinds = parseCsvSet(edgeKindsFilter);
        long t0 = System.nanoTime();

        // Hoist context loaders ONCE outside BFS loop (and never resolve opKey twice)
        List<ClassLoader> baseLoaders;
        ResolvedClassInfo root;
        try {
            TargetResolution target = resolveTargetAndLoaders(opKey, classCandidates, fromBundleId);
            baseLoaders = target.loaders();
            root = target.resolved();
        } catch (IllegalArgumentException e) {
            return invalidTargetError(e.getMessage());
        } catch (SpecException e) {
            return specExceptionResult(opKey, e);
        }
        if (root == null) {
            return classNotFoundResult(classCandidates, fromBundleId, baseLoaders);
        }

        GraphResult graph = ClassGraphTraverser.traverse(
                root,
                baseLoaders,
                (fqcn, hintLoaders) -> OsgiClassResolver.resolveFromCandidates(List.of(fqcn), hintLoaders),
                depth,
                maxNodes,
                includeJdk,
                excludeLibraries,
                prefix,
                allowedKinds,
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
                .field("excludeLibraries", excludeLibraries)
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
            List<String> kinds = graph.edgeKinds().get(ClassGraphTraverser.edgeKey(edge[0], edge[1]));
            j.beginObject().field("from", edge[0]).field("to", edge[1]);
            if (kinds != null && !kinds.isEmpty()) {
                j.strings("kinds", kinds);
            }
            j.endObject();
        }
        j.endArray().endObject();
        return new Result(200, j.toString());
    }

    public Result searchClasses(String rawQuery, int rawLimit, Long bundleIdFilter) {
        if (!enabled.getAsBoolean()) {
            return disabledError();
        }
        String query = rawQuery == null ? "" : rawQuery.trim();
        if (query.length() < 2) {
            return error(400, "query-too-short", "Pass ?q={text} with at least 2 characters.");
        }
        if (query.contains("..")) {
            return error(400, "invalid-class", "Pass a valid Java class name or prefix without '..'.");
        }
        int limit = Math.max(1, Math.min(100, rawLimit <= 0 ? 30 : rawLimit));
        List<ClassLoader> loaders = OsgiClassResolver.buildContextLoaders(
                bundleIdFilter == null ? -1L : bundleIdFilter, null, OperationSource.class);
        SearchResult sr = OsgiClassSearcher.search(query, limit, bundleIdFilter, loaders, this::pluginKeyForBundle);

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
        return operationBundle(opKey, scope, decompiler, details, false, null, null, false);
    }

    public Result operationBundle(String opKey, String scope, String decompiler, OperationDetails details,
                                  boolean compact, Integer startLine, Integer maxLines, boolean lineNumbers) {
        if (!enabled.getAsBoolean()) {
            return disabledError();
        }
        if (opKey == null || opKey.isBlank()) {
            return error(400, "missing-op", "Pass ?op={operationKey} from /catalog/operations.");
        }
        ResolvedOp op;
        try {
            op = resolveOperation(opKey);
        } catch (SpecException e) {
            return specExceptionResult(opKey, e);
        }
        if (op.error != null) {
            return op.error;
        }
        // Reuse the single resolved module + handler for both details and source (avoids duplicate Jersey walk!)
        Result detailRes = details.describeHandler(opKey, op.module, op.handler, compact);
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
                    handling.getName(), handling.getParameterCount(), engine,
                    startLine, maxLines, false, lineNumbers, !compact);
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
            return disabledError();
        }
        if (classes == null || classes.isEmpty()) {
            return error(400, "missing-classes", "Pass \"classes\":[...] or \"items\":[...] in the JSON request body.");
        }
        List<BatchItem> items = new ArrayList<>(classes.size());
        for (String cls : classes) {
            items.add(new BatchItem(cls, fromBundleId, opKey, "class", null, decompiler,
                    includeSource, includeMeta, false, null, maxLines, false));
        }
        return batchItems(items);
    }

    public Result batchItems(List<BatchItem> rawItems) {
        if (!enabled.getAsBoolean()) {
            return disabledError();
        }
        if (rawItems == null || rawItems.isEmpty()) {
            return error(400, "missing-classes", "Pass \"classes\":[...] or \"items\":[...] in the JSON request body.");
        }
        int cap = Math.min(rawItems.size(), 10);
        Map<String, List<ClassLoader>> loaderCache = new LinkedHashMap<>();
        Json j = new Json().beginObject()
                .field("format", 1)
                .field("count", cap)
                .field("truncated", rawItems.size() > 10)
                .name("results").beginArray();
        for (int i = 0; i < cap; i++) {
            BatchItem item = rawItems.get(i);
            Result itemRes = executeBatchItem(item, loaderCache);
            j.beginObject()
                    .field("requested", item.cls() != null ? item.cls() : (item.opKey() == null ? "" : item.opKey()))
                    .field("status", itemRes.status())
                    .name("result").raw(itemRes.json())
                    .endObject();
        }
        j.endArray().endObject();
        return new Result(200, j.toString());
    }

    private Result executeBatchItem(BatchItem item, Map<String, List<ClassLoader>> loaderCache) {
        List<ClassLoader> loaders;
        ResolvedClassInfo resolved;
        if (item.cls() != null && !item.cls().isBlank()) {
            String loaderKey = (item.opKey() == null ? "" : item.opKey()) + "#" + item.fromBundle();
            loaders = loaderCache.computeIfAbsent(loaderKey, k -> loadersFor(item.opKey(), item.fromBundle()));
            List<String> candidates = OsgiClassResolver.parseCandidates(item.cls());
            if (candidates.isEmpty()) {
                return error(400, "invalid-class", "Pass a valid binary Java class name without '..'.");
            }
            resolved = OsgiClassResolver.resolveFromCandidates(candidates, loaders);
            if (resolved == null) {
                return classNotFoundResult(candidates.get(0), item.fromBundle(), loaders);
            }
        } else {
            try {
                TargetResolution target = resolveTargetAndLoaders(item.opKey(), null, item.fromBundle());
                loaders = target.loaders();
                resolved = target.resolved();
            } catch (IllegalArgumentException e) {
                return invalidTargetError(e.getMessage());
            } catch (SpecException e) {
                return specExceptionResult(item.opKey(), e);
            }
            if (resolved == null) {
                return classNotFoundResult(item.opKey(), item.fromBundle(), loaders);
            }
        }
        Engine engine = Engine.parse(item.decompiler());
        String targetMethod = cleanMethodFilter(item.method());
        String resolvedScope = ("method".equalsIgnoreCase(item.scope()) && targetMethod != null) ? "method" : "class";
        Result base;
        if (item.includeSource()) {
            base = runAndFormat(item.opKey(), resolved, resolvedScope, targetMethod, -1, engine,
                    item.startLine(), item.maxLines(), item.includeMeta(), item.lineNumbers(), true);
        } else {
            long[] elapsed = new long[1];
            boolean[] fromCache = new boolean[1];
            try {
                String body = buildClassInfoJson(resolved, elapsed, fromCache, null, false, false);
                String enriched = body.substring(0, body.length() - 1)
                        + ",\"inspectMs\":" + elapsed[0] + ",\"cached\":" + fromCache[0] + "}";
                base = new Result(200, enriched);
            } catch (SingleFlightLruCache.CacheBusyException e) {
                return error(503, "inspect-busy");
            } catch (RuntimeException | LinkageError e) {
                return error(500, "inspect-failed");
            }
        }
        if (base.status() == 200 && item.includeSchema()) {
            Class<?> cls = ensureLoadedClass(resolved);
            if (cls != null) {
                SchemaResult sr = DtoSchemaInspector.inspect(cls, cls, 3, true);
                String baseJson = base.json();
                String withSchema = baseJson.substring(0, baseJson.length() - 1)
                        + ",\"schema\":" + sr.schemaJson()
                        + (sr.exampleJson() != null ? ",\"example\":" + sr.exampleJson() : "")
                        + "}";
                return new Result(200, withSchema);
            }
        }
        return base;
    }

    public Result inspectSchema(String opKey, String classCandidates, long fromBundleId, int depth, boolean includeExample) {
        if (!enabled.getAsBoolean()) {
            return disabledError();
        }
        if (classCandidates != null && !classCandidates.isBlank()) {
            TargetResolution target;
            try {
                target = resolveTargetAndLoaders(opKey, classCandidates, fromBundleId);
            } catch (IllegalArgumentException e) {
                return invalidTargetError(e.getMessage());
            } catch (SpecException e) {
                return error(503, e.reason());
            }
            ResolvedClassInfo resolved = target.resolved();
            if (resolved == null) {
                return classNotFoundResult(classCandidates, fromBundleId, target.loaders());
            }
            Class<?> cls = ensureLoadedClass(resolved);
            if (cls == null) {
                return error(422, "class-not-loaded",
                        "Class bytecode was found in bundle #" + resolved.bundleId() + ", but loading failed due to missing optional imports.");
            }
            SchemaResult sr = DtoSchemaInspector.inspect(cls, cls, depth, includeExample);
            Json j = new Json().beginObject()
                    .field("format", 1)
                    .field("class", resolved.name())
                    .field("javaType", sr.javaType())
                    .field("bundleId", resolved.bundleId())
                    .field("typesVisited", sr.typesVisited())
                    .field("truncated", sr.truncated())
                    .name("schema").raw(sr.schemaJson());
            if (sr.exampleJson() != null) {
                j.name("example").raw(sr.exampleJson());
            }
            return new Result(200, j.endObject().toString());
        }
        if (opKey == null || opKey.isBlank()) {
            return error(400, "missing-class", "Pass ?class={fqcn} or ?op={operationKey}.");
        }
        ResolvedOp op;
        try {
            op = resolveOperation(opKey);
        } catch (SpecException e) {
            return specExceptionResult(opKey, e);
        }
        if (op.error != null) {
            return op.error;
        }
        Method handling = op.handler.handling();
        Method def = op.handler.definition();
        List<ClassLoader> opLoaders = buildHandlerLoaders(fromBundleId, op.handler.handlerClass(),
                handling.getDeclaringClass());
        Json j = new Json().beginObject()
                .field("format", 1)
                .field("key", opKey);
        Type reqType = findEntityParameterType(handling, def);
        if (reqType != null) {
            j.name("requestBody");
            writeOperationSchemaPart(j, reqType, opLoaders, depth, includeExample);
        }
        Type respType = resolveOperationReturnType(handling, def, opLoaders);
        if (respType != null) {
            j.name("responseBody");
            writeOperationSchemaPart(j, respType, opLoaders, depth, includeExample);
        }
        return new Result(200, j.endObject().toString());
    }

    public Result findImplementations(String opKey, String classCandidates, long fromBundleId,
                                      Long bundleIdFilter, String pluginKeyFilter,
                                      boolean includeAbstract, int limit) {
        if (!enabled.getAsBoolean()) {
            return disabledError();
        }
        long t0 = System.nanoTime();
        TargetResolution target;
        try {
            target = resolveTargetAndLoaders(opKey, classCandidates, fromBundleId);
        } catch (IllegalArgumentException e) {
            return invalidTargetError(e.getMessage());
        } catch (SpecException e) {
            return specExceptionResult(opKey, e);
        }
        ResolvedClassInfo resolved = target.resolved();
        if (resolved == null) {
            return classNotFoundResult(classCandidates, fromBundleId, target.loaders());
        }
        ImplementationResult res = OsgiImplementationFinder.find(
                resolved.name(), resolved.bundleId(), bundleIdFilter, pluginKeyFilter,
                includeAbstract, limit, this::pluginKeyForBundle);
        long elapsedMs = Math.max(1L, (System.nanoTime() - t0) / 1_000_000L);
        Class<?> loaded = resolved.loaded();
        String kind = loaded == null ? "class" : (loaded.isInterface() ? "interface"
                : Modifier.isAbstract(loaded.getModifiers()) ? "abstract class" : "class");

        Json j = new Json().beginObject()
                .field("format", 1)
                .field("target", resolved.name())
                .field("kind", kind)
                .field("bundleId", resolved.bundleId())
                .field("scannedBundles", res.scannedBundles())
                .field("truncated", res.truncated())
                .field("elapsedMs", elapsedMs)
                .field("serviceCount", res.services().size())
                .name("osgiServices").beginArray();
        for (OsgiServiceHit s : res.services()) {
            j.beginObject()
                    .field("serviceId", s.serviceId())
                    .field("bundleId", s.bundleId())
                    .optional("bundle", s.bundleLabel())
                    .optional("plugin", s.pluginKey())
                    .optional("beanName", s.beanName())
                    .field("ranking", s.ranking())
                    .strings("objectClass", s.objectClass())
                    .endObject();
        }
        j.endArray()
                .field("implementationCount", res.implementations().size())
                .name("implementations").beginArray();
        for (ImplHit hit : res.implementations()) {
            j.beginObject()
                    .field("class", hit.fqcn())
                    .field("simpleName", hit.simpleName())
                    .field("kind", hit.kind())
                    .field("abstract", hit.isAbstract())
                    .field("bundleId", hit.bundleId())
                    .optional("bundle", hit.bundleLabel())
                    .optional("plugin", hit.pluginKey())
                    .field("via", hit.via())
                    .endObject();
        }
        j.endArray().endObject();
        return new Result(200, j.toString());
    }

    public Result grepBytecode(String rawQuery, boolean caseSensitive, boolean includeUtf8,
                               Long bundleIdFilter, String pluginKeyFilter, String packagePrefix, int limit) {
        if (!enabled.getAsBoolean()) {
            return disabledError();
        }
        String query = rawQuery == null ? "" : rawQuery;
        if (query.trim().length() < 2) {
            return error(400, "query-too-short", "Pass ?q={text} with at least 2 non-whitespace characters.");
        }
        long t0 = System.nanoTime();
        GrepResult sr = OsgiBytecodeScanner.grep(
                query, caseSensitive, includeUtf8, bundleIdFilter, pluginKeyFilter,
                packagePrefix, limit, this::pluginKeyForBundle);
        long elapsedMs = Math.max(1L, (System.nanoTime() - t0) / 1_000_000L);
        Json j = new Json().beginObject()
                .field("format", 1)
                .field("query", query)
                .field("caseSensitive", caseSensitive)
                .field("includeUtf8", includeUtf8)
                .field("count", sr.hits().size())
                .field("scannedClasses", sr.scannedClasses())
                .field("scannedBundles", sr.scannedBundles())
                .field("truncated", sr.truncated())
                .field("elapsedMs", elapsedMs);
        if (sr.truncated() && bundleIdFilter == null && (pluginKeyFilter == null || pluginKeyFilter.isBlank())) {
            j.field("hint", "Narrow scan scope with ?bundleId={id} or ?plugin={pluginKey}.");
        }
        j.name("results").beginArray();
        for (GrepHit hit : sr.hits()) {
            j.beginObject()
                    .field("class", hit.fqcn())
                    .field("simpleName", simpleNameOf(hit.fqcn()))
                    .field("bundleId", hit.bundleId())
                    .optional("bundle", hit.bundleLabel())
                    .optional("plugin", hit.pluginKey())
                    .strings("matches", hit.matches())
                    .endObject();
        }
        j.endArray().endObject();
        return new Result(200, j.toString());
    }

    public Result findCallers(String opKey, String classCandidates, String methodFilter, long fromBundleId,
                              Long bundleIdFilter, String pluginKeyFilter, String packagePrefix, int limit) {
        if (!enabled.getAsBoolean()) {
            return disabledError();
        }
        long t0 = System.nanoTime();
        TargetResolution target;
        try {
            target = resolveTargetAndLoaders(opKey, classCandidates, fromBundleId);
        } catch (IllegalArgumentException e) {
            return invalidTargetError(e.getMessage());
        } catch (SpecException e) {
            return specExceptionResult(opKey, e);
        }
        ResolvedClassInfo resolved = target.resolved();
        if (resolved == null) {
            return classNotFoundResult(classCandidates, fromBundleId, target.loaders());
        }
        String cleanMethod = cleanMethodFilter(methodFilter);
        CallersResult res = OsgiBytecodeScanner.findCallers(
                resolved.name(), cleanMethod, resolved.bundleId(), bundleIdFilter, pluginKeyFilter,
                packagePrefix, limit, this::pluginKeyForBundle);
        long elapsedMs = Math.max(1L, (System.nanoTime() - t0) / 1_000_000L);
        Json j = new Json().beginObject()
                .field("format", 1)
                .field("target", resolved.name())
                .optional("method", cleanMethod)
                .field("bundleId", resolved.bundleId())
                .field("count", res.hits().size())
                .field("scannedClasses", res.scannedClasses())
                .field("scannedBundles", res.scannedBundles())
                .field("truncated", res.truncated())
                .field("elapsedMs", elapsedMs)
                .name("results").beginArray();
        for (CallerHit hit : res.hits()) {
            j.beginObject()
                    .field("class", hit.fqcn())
                    .field("simpleName", simpleNameOf(hit.fqcn()))
                    .field("bundleId", hit.bundleId())
                    .optional("bundle", hit.bundleLabel())
                    .optional("plugin", hit.pluginKey())
                    .strings("calls", hit.calls())
                    .endObject();
        }
        j.endArray().endObject();
        return new Result(200, j.toString());
    }

    private String pluginKeyForBundle(Bundle bundle) {
        Plugin owner = AtlassianPluginInspector.pluginForBundle(pluginAccessor, bundle);
        return owner == null ? null : owner.getKey();
    }

    // ---- helpers & delegating hooks for tests

    private record ResolvedOp(RestModule module, Handler handler, Result error) {
    }

    private ResolvedOp resolveOperation(String opKey) throws SpecException {
        RestModule module = OperationDetails.moduleOf(discovery.discover(), opKey);
        if (module == null) {
            return new ResolvedOp(null, null, error(404, "unknown-module",
                    "Check indexed modules via GET /rest/restbrowser/1/catalog."));
        }
        JerseyModelSource source = jersey.get();
        if (source == null || !module.restV2()) {
            return new ResolvedOp(module, null, error(404, "not-described"));
        }
        Optional<Handler> handler = source.handler(module, opKey);
        if (handler.isEmpty() || handler.get().handling() == null) {
            return new ResolvedOp(module, null, unknownOperationResult(module, opKey, source));
        }
        return new ResolvedOp(module, handler.get(), null);
    }

    private Result specExceptionResult(String opKey, SpecException e) {
        if (JerseyModelSource.NOT_STARTED.equals(e.reason()) && opKey != null) {
            RestModule mod = OperationDetails.moduleOf(discovery.discover(), opKey);
            if (mod != null) {
                String json = new Json().beginObject()
                        .field("error", JerseyModelSource.NOT_STARTED)
                        .field("module", mod.id())
                        .field("hint", "Module '" + mod.id() + "' has not initialized on this node. Probe GET /rest/"
                                + stripLeadingSlashes(mod.path()) + " and then POST /rest/restbrowser/1/catalog/started?module="
                                + mod.id() + " with header X-Atlassian-Token: no-check.")
                        .endObject().toString();
                return new Result(503, json);
            }
        }
        return error(503, e.reason());
    }

    private Result unknownOperationResult(RestModule module, String opKey, JerseyModelSource source) {
        List<String> suggestions = List.of();
        try {
            List<String> allKeys = source.operationKeys(module);
            suggestions = rankSimilarKeys(opKey, allKeys, 5);
        } catch (SpecException | RuntimeException | LinkageError ignored) {
            // best-effort suggestions only
        }
        String hint = "Operation key not found in module '" + module.id()
                + "'; search via GET /rest/restbrowser/1/catalog/operations?module=" + module.id() + ".";
        return error(404, "unknown-operation", hint, suggestions);
    }

    static List<String> rankSimilarKeys(String target, List<String> candidates, int limit) {
        if (target == null || candidates == null || candidates.isEmpty()) {
            return List.of();
        }
        String[] want = target.toLowerCase(java.util.Locale.ROOT).split("[:/_\\-{}.]+");
        List<Map.Entry<String, Integer>> scored = new ArrayList<>();
        for (String c : candidates) {
            String low = c.toLowerCase(java.util.Locale.ROOT);
            int score = 0;
            for (String tok : want) {
                if (!tok.isEmpty() && low.contains(tok)) {
                    score += tok.length();
                }
            }
            if (score > 0 || scored.size() < limit) {
                scored.add(Map.entry(c, score));
            }
        }
        scored.sort((a, b) -> {
            int cmp = Integer.compare(b.getValue(), a.getValue());
            return cmp != 0 ? cmp : a.getKey().compareTo(b.getKey());
        });
        List<String> out = new ArrayList<>(Math.min(limit, scored.size()));
        for (int i = 0; i < Math.min(limit, scored.size()); i++) {
            out.add(scored.get(i).getKey());
        }
        return out;
    }

    private static String stripLeadingSlashes(String s) {
        if (s == null) return "";
        int i = 0;
        while (i < s.length() && s.charAt(i) == '/') i++;
        return s.substring(i);
    }

    private static Set<String> parseCsvSet(String csv) {
        Set<String> set = new LinkedHashSet<>();
        if (csv != null && !csv.isBlank()) {
            for (String p : csv.split(",")) {
                if (!p.isBlank()) {
                    set.add(p.trim().toLowerCase(java.util.Locale.ROOT));
                }
            }
        }
        return set;
    }

    private static String serializeServices(List<OsgiServiceHit> hits) {
        Json j = new Json().beginArray();
        for (OsgiServiceHit s : hits) {
            j.beginObject()
                    .field("serviceId", s.serviceId())
                    .field("bundleId", s.bundleId())
                    .optional("bundle", s.bundleLabel())
                    .optional("plugin", s.pluginKey())
                    .optional("beanName", s.beanName())
                    .field("ranking", s.ranking())
                    .strings("objectClass", s.objectClass())
                    .endObject();
        }
        return j.endArray().toString();
    }

    private static String serializeImplHits(List<ImplHit> hits) {
        Json j = new Json().beginArray();
        for (ImplHit h : hits) {
            j.beginObject()
                    .field("class", h.fqcn())
                    .field("simpleName", h.simpleName())
                    .field("kind", h.kind())
                    .field("via", h.via())
                    .field("bundleId", h.bundleId())
                    .optional("bundle", h.bundleLabel())
                    .optional("plugin", h.pluginKey())
                    .endObject();
        }
        return j.endArray().toString();
    }

    // ---- Wave 3: bundle resource reader, OpenAPI module schema map, one-shot investigation context

    public Result inspectResource(Long bundleId, String pluginKey, String path, String prefix,
                                  Integer startLine, Integer maxLines, boolean lineNumbers, int limit) {
        return readOrListResource(bundleId, pluginKey, path, prefix, startLine, maxLines, lineNumbers, limit, false);
    }

    public Result inspectResourceText(Long bundleId, String pluginKey, String path, String prefix,
                                      Integer startLine, Integer maxLines, boolean lineNumbers, int limit) {
        return readOrListResource(bundleId, pluginKey, path, prefix, startLine, maxLines, lineNumbers, limit, true);
    }

    private Result readOrListResource(Long bundleId, String pluginKey, String path, String prefix,
                                      Integer startLine, Integer maxLines, boolean lineNumbers, int limit,
                                      boolean plainText) {
        if (!enabled.getAsBoolean()) {
            return disabledError();
        }
        Bundle bundle;
        if (bundleId != null && bundleId >= 0) {
            bundle = OsgiClassResolver.bundleByIdOrClass(bundleId, null);
        } else if (pluginKey != null && !pluginKey.isBlank()) {
            String key = pluginKey.trim();
            bundle = OsgiBundleInspector.bundleForPluginKey(key, key);
        } else {
            return error(400, "missing-bundle", "Pass ?bundleId={id} or ?plugin={pluginKey}.");
        }
        if (bundle == null) {
            return error(404, "bundle-not-found",
                    "OSGi bundle not found or inactive; locate bundles via GET /rest/restbrowser/1/code/plugin or /code/class.");
        }
        String bLabel = OsgiBundleInspector.bundleLabel(bundle);
        String pKey = pluginKeyForBundle(bundle);
        if (path == null || path.isBlank()) {
            ResourceList list = OsgiBundleResourceReader.listResources(bundle, prefix, limit);
            if (plainText) {
                StringBuilder sb = new StringBuilder();
                for (ResourceEntry e : list.entries()) {
                    sb.append('[').append(e.kind()).append("] ").append(e.path()).append('\n');
                }
                return new Result(200, sb.toString());
            }
            Json j = new Json().beginObject()
                    .field("format", 1)
                    .field("bundleId", bundle.getBundleId())
                    .optional("bundle", bLabel)
                    .optional("plugin", pKey)
                    .optional("prefix", prefix == null || prefix.isBlank() ? null : prefix.trim())
                    .field("count", list.entries().size())
                    .field("truncated", list.truncated())
                    .name("entries").beginArray();
            for (ResourceEntry e : list.entries()) {
                j.beginObject().field("path", e.path()).field("kind", e.kind()).endObject();
            }
            return new Result(200, j.endArray().endObject().toString());
        }

        ResourceContent rc = OsgiBundleResourceReader.readResource(bundle, path, OsgiBundleResourceReader.MAX_RESOURCE_BYTES);
        if (!rc.ok()) {
            int st = "invalid-path".equals(rc.errorCode()) ? 400
                    : "binary-resource".equals(rc.errorCode()) ? 415
                    : ("bundle-not-found".equals(rc.errorCode()) || "resource-not-found".equals(rc.errorCode())) ? 404 : 500;
            return error(st, rc.errorCode(), rc.hint());
        }
        int totalLines = LineSlicer.countLines(rc.content());
        Slice slice = LineSlicer.slice(rc.content(), totalLines, startLine, maxLines);
        String body = lineNumbers ? LineSlicer.formatWithLineNumbers(slice.text(), slice.startLine()) : slice.text();
        if (plainText) {
            return new Result(200, body);
        }
        Json j = new Json().beginObject()
                .field("format", 1)
                .field("bundleId", bundle.getBundleId())
                .optional("bundle", bLabel)
                .optional("plugin", pKey)
                .field("path", rc.path())
                .field("kind", OsgiBundleResourceReader.classifyKind(rc.path()))
                .field("bytes", rc.bytes())
                .field("totalLines", totalLines)
                .field("startLine", slice.startLine())
                .field("endLine", slice.endLine())
                .field("truncated", rc.truncated() || slice.truncated());
        if (lineNumbers) {
            j.field("lineNumbers", true);
        }
        j.field("content", body).endObject();
        return new Result(200, j.toString());
    }

    public Map<String, OperationSchemas> moduleOperationSchemas(String moduleId, int depth, int maxOps) {
        if (!enabled.getAsBoolean() || moduleId == null || moduleId.isBlank()) {
            return Map.of();
        }
        RestModule mod = null;
        for (RestModule candidate : discovery.discover()) {
            if (moduleId.equals(candidate.id())) {
                mod = candidate;
                break;
            }
        }
        JerseyModelSource src = jersey.get();
        if (mod == null || src == null || !mod.restV2()) {
            return Map.of();
        }
        Map<String, Handler> handlers;
        try {
            handlers = src.handlers(mod);
        } catch (SpecException | RuntimeException | LinkageError e) {
            return Map.of();
        }
        Map<String, OperationSchemas> out = new LinkedHashMap<>();
        int cap = Math.max(1, Math.min(100, maxOps <= 0 ? 60 : maxOps));
        for (Map.Entry<String, Handler> entry : handlers.entrySet()) {
            if (out.size() >= cap) {
                break;
            }
            Handler h = entry.getValue();
            if (h == null || h.handling() == null) {
                continue;
            }
            try {
                Method handling = h.handling();
                Method def = h.definition();
                List<ClassLoader> loaders = buildHandlerLoaders(-1L, h.handlerClass(), handling.getDeclaringClass());
                Type reqType = findEntityParameterType(handling, def);
                Type respType = resolveOperationReturnType(handling, def, loaders);
                SchemaResult reqSr = reqType == null ? null : inspectTypeSchema(reqType, loaders, depth);
                SchemaResult respSr = respType == null ? null : inspectTypeSchema(respType, loaders, depth);
                if (reqSr != null || respSr != null) {
                    out.put(entry.getKey(), new OperationSchemas(
                            reqSr == null ? null : reqSr.schemaJson(),
                            reqSr == null ? null : reqSr.exampleJson(),
                            respSr == null ? null : respSr.schemaJson(),
                            respSr == null ? null : respSr.exampleJson()));
                }
            } catch (RuntimeException | LinkageError ignored) {
                // skip unresolvable operation types
            }
        }
        return out;
    }

    private static SchemaResult inspectTypeSchema(Type type, List<ClassLoader> loaders, int depth) {
        Class<?> raw = type instanceof Class<?> c ? c
                : (type instanceof ParameterizedType pt && pt.getRawType() instanceof Class<?> rc ? rc : null);
        if (raw == null) {
            String tn = TypeFormatter.stableTypeName(type, null);
            if (tn != null) {
                int lt = tn.indexOf('<');
                String base = (lt > 0 ? tn.substring(0, lt) : tn).replace("[]", "").trim();
                ResolvedClassInfo r = OsgiClassResolver.resolveFromCandidates(List.of(base), loaders);
                raw = r == null ? null : ensureLoadedClass(r);
            }
        }
        if (raw == null && !(type instanceof ParameterizedType)) {
            return null;
        }
        return DtoSchemaInspector.inspect(type, raw, depth, true);
    }

    public Result investigationContext(CatalogSnapshot snapshot, String opKey, String url, String method,
                                        int maxLines, int schemaDepth, boolean includeSchemas,
                                        boolean includeImplementations, boolean includeSource,
                                        boolean lineNumbers, String decompiler, OperationDetails details) {
        if (!enabled.getAsBoolean()) {
            return disabledError();
        }
        TopResolution top = null;
        String effectiveKey = opKey != null && !opKey.isBlank() ? opKey.trim() : null;
        if (effectiveKey == null) {
            if (url == null || url.isBlank()) {
                return error(400, "missing-target", "Pass \"op\" or \"url\".");
            }
            top = CatalogQuery.resolveTopOperation(snapshot, method, url);
            if (top == null) {
                return error(404, "url-not-matched",
                        "No operation matched URL '" + url + "'; search via GET /rest/restbrowser/1/catalog/operations.");
            }
            effectiveKey = top.operation().key();
        }

        ResolvedOp op;
        try {
            op = resolveOperation(effectiveKey);
        } catch (SpecException e) {
            return specExceptionResult(effectiveKey, e);
        }
        if (op.error != null) {
            return op.error;
        }

        Json j = new Json().beginObject()
                .field("format", 1)
                .field("key", effectiveKey);

        if (top != null) {
            j.name("resolvedUrl").beginObject()
                    .optional("method", method)
                    .field("url", url)
                    .field("fullPath", top.fullPath())
                    .stringMap("pathParams", top.pathParams())
                    .name("queryParams").beginObject();
            for (Map.Entry<String, List<String>> e : top.queryParams().entrySet()) {
                j.strings(e.getKey(), e.getValue());
            }
            j.endObject().endObject();
        }

        Operation catalogOp = snapshot == null ? null : snapshot.operation(effectiveKey).orElse(null);
        if (catalogOp != null) {
            ModuleEntry mod = snapshot.module(catalogOp.moduleId()).orElse(null);
            OperationSpec spec = catalogOp.spec();
            j.name("catalog").beginObject()
                    .field("module", catalogOp.moduleId())
                    .field("method", spec.method())
                    .field("fullPath", CatalogQuery.fullPath(mod, spec))
                    .optional("access", spec.access())
                    .field("deprecated", spec.deprecated())
                    .optional("summary", spec.summary())
                    .optional("description", spec.description())
                    .optional("bodyJavaType", spec.bodyJavaType() != null ? spec.bodyJavaType() : spec.bodyType())
                    .optional("returnJavaType", spec.returnJavaType() != null ? spec.returnJavaType() : spec.returnType())
                    .endObject();
        }

        if (details != null) {
            Result detailRes = details.describeHandler(effectiveKey, op.module, op.handler, true);
            if (detailRes.status() == 200) {
                j.name("details").raw(detailRes.json());
            }
        }

        Method handling = op.handler.handling();
        Method def = op.handler.definition();
        List<ClassLoader> opLoaders = buildHandlerLoaders(-1L, op.handler.handlerClass(),
                handling.getDeclaringClass());
        if (includeSchemas) {
            Type reqType = findEntityParameterType(handling, def);
            if (reqType != null) {
                j.name("requestBody");
                writeOperationSchemaPart(j, reqType, opLoaders, schemaDepth, true);
            }
            Type respType = resolveOperationReturnType(handling, def, opLoaders);
            if (respType != null) {
                j.name("responseBody");
                writeOperationSchemaPart(j, respType, opLoaders, schemaDepth, true);
            }
        }

        if (includeSource) {
            int budget = Math.max(20, Math.min(800, maxLines <= 0 ? 400 : maxLines));
            ResolvedClassInfo resolved = OsgiClassResolver.resolveLoaded(TypeProxyUnwrapper.targetClass(handling.getDeclaringClass()));
            Result srcRes = resolved == null
                    ? error(404, "class-not-found")
                    : runAndFormat(effectiveKey, resolved, "method", handling.getName(),
                            handling.getParameterCount(), Engine.parse(decompiler), 1, budget,
                            false, lineNumbers, true);
            j.name("source").raw(srcRes.json());
        }

        if (includeImplementations) {
            j.name("dependencies").beginArray();
            Set<Class<?>> seenDepTypes = new LinkedHashSet<>();
            int depCount = 0;
            for (Class<?> ownerCls : new Class<?>[]{
                    op.handler.handlerClass() == null ? null : TypeProxyUnwrapper.targetClass(op.handler.handlerClass()),
                    TypeProxyUnwrapper.targetClass(handling.getDeclaringClass())}) {
                if (ownerCls == null) continue;
                Field[] fields;
                try {
                    fields = ownerCls.getDeclaredFields();
                } catch (RuntimeException | LinkageError e) {
                    fields = new Field[0];
                }
                for (Field f : fields) {
                    if (depCount >= 6) break;
                    if (f.isSynthetic() || Modifier.isStatic(f.getModifiers())) continue;
                    Class<?> ft = f.getType();
                    if (ft.isPrimitive() || ft.isEnum() || !seenDepTypes.add(ft)) continue;
                    if (!(ft.isInterface() || Modifier.isAbstract(ft.getModifiers()))) continue;
                    String ftn = ft.getName();
                    if (ClassGraphTraverser.isStandardJdk(ftn) || ClassGraphTraverser.isCommonLibrary(ftn)) continue;
                    depCount++;
                    Bundle fb = OsgiBundleInspector.bundleOf(ft);
                    ImplementationResult ir = OsgiImplementationFinder.find(
                            ftn, fb == null ? -1L : fb.getBundleId(), null, null, false, 5, this::pluginKeyForBundle);
                    j.beginObject()
                            .field("field", f.getName())
                            .field("type", ftn)
                            .name("services").raw(serializeServices(ir.services()))
                            .strings("implementations", ir.implementations().stream().map(ImplHit::fqcn).toList())
                            .endObject();
                }
            }
            j.endArray();
        }

        return new Result(200, j.endObject().toString());
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

    private record FieldSummary(String name, String type, String shortType, String modifiers,
                                String serializedName, List<String> annotations) {
    }

    private static List<FieldSummary> inspectDeclaredFields(Class<?> c) {
        Field[] raw;
        try {
            raw = c.getDeclaredFields();
        } catch (LinkageError | RuntimeException e) {
            return List.of();
        }
        List<FieldSummary> out = new ArrayList<>();
        for (Field f : raw) {
            if (f.isSynthetic()) {
                continue;
            }
            if (out.size() >= MAX_FIELDS) {
                break;
            }
            Type gType;
            try {
                gType = f.getGenericType();
            } catch (RuntimeException | LinkageError e) {
                gType = f.getType();
            }
            String fullType = TypeFormatter.stableTypeName(gType, f.getType());
            String shortType = TypeFormatter.shortTypeName(fullType);
            String mods = Modifier.toString(f.getModifiers());
            String serialized = DtoSchemaInspector.serializedFieldName(f);
            List<String> anns = AnnotationFormatter.annotations(f);
            out.add(new FieldSummary(f.getName(), fullType, shortType, mods, serialized, anns));
        }
        return out;
    }

    private static void writeFieldSummaries(Json j, List<FieldSummary> fields, boolean includeAnnotations) {
        j.name("fields").beginArray();
        for (FieldSummary f : fields) {
            j.beginObject()
                    .field("name", f.name())
                    .optional("type", f.type())
                    .optional("shortType", f.shortType())
                    .field("modifiers", f.modifiers())
                    .optional("serializedName", f.serializedName());
            if (includeAnnotations && !f.annotations().isEmpty()) {
                j.strings("annotations", f.annotations());
            }
            j.endObject();
        }
        j.endArray();
    }

    private static List<String> inspectEnumConstants(Class<?> c) {
        try {
            Object[] all = c.getEnumConstants();
            if (all == null) {
                return List.of();
            }
            List<String> names = new ArrayList<>(Math.min(all.length, MAX_ENUM_CONSTANTS));
            for (Object item : all) {
                if (names.size() >= MAX_ENUM_CONSTANTS) {
                    break;
                }
                names.add(((Enum<?>) item).name());
            }
            return names;
        } catch (RuntimeException | LinkageError e) {
            return List.of();
        }
    }

    private static Class<?> ensureLoadedClass(ResolvedClassInfo resolved) {
        if (resolved.loaded() != null) {
            return resolved.loaded();
        }
        return OsgiClassResolver.tryLoadClass(resolved.loader(), resolved.name());
    }

    private static Type findEntityParameterType(Method handling, Method def) {
        if (handling == null) {
            return null;
        }
        Parameter[] hParams = handling.getParameters();
        Parameter[] dParams = def != null && def.getParameterCount() == hParams.length ? def.getParameters() : null;
        for (int i = 0; i < hParams.length; i++) {
            Parameter hp = hParams[i];
            Parameter dp = dParams == null ? null : dParams[i];
            if (hasJaxRsBindingAnnotation(hp) || (dp != null && hasJaxRsBindingAnnotation(dp))) {
                continue;
            }
            Class<?> raw = hp.getType();
            if (raw.getName().startsWith("jakarta.servlet.") || raw.getName().startsWith("javax.servlet.")
                    || raw.getName().startsWith("jakarta.ws.rs.core.") || raw.getName().startsWith("javax.ws.rs.core.")) {
                continue;
            }
            Type generic;
            try {
                generic = hp.getParameterizedType();
            } catch (RuntimeException | LinkageError e) {
                generic = raw;
            }
            return TypeProxyUnwrapper.targetClass(raw) != raw ? TypeProxyUnwrapper.targetClass(raw) : generic;
        }
        return null;
    }

    private static boolean hasJaxRsBindingAnnotation(Parameter p) {
        for (Annotation a : ReflectiveBridge.safeDeclaredAnnotations(p)) {
            String n = a.annotationType().getName();
            if (n.endsWith("Param") || n.endsWith(".Context") || n.endsWith(".Suspended")
                    || n.endsWith(".BeanParam") || n.endsWith(".MultipartFormParam") || n.endsWith(".FormDataParam")) {
                return true;
            }
        }
        return false;
    }

    private static Type resolveOperationReturnType(Method handling, Method def, List<ClassLoader> loaders) {
        if (handling == null) {
            return null;
        }
        Class<?> raw = handling.getReturnType();
        if (raw == void.class || raw == Void.class) {
            return null;
        }
        String rawName = raw.getName();
        boolean isWrapper = rawName.equals("jakarta.ws.rs.core.Response")
                || rawName.equals("javax.ws.rs.core.Response")
                || raw == Object.class;
        if (isWrapper) {
            String annotated = OpenApiAnnotationExtractor.annotatedReturnJavaType(def, handling);
            if (annotated != null && !annotated.isBlank()) {
                int lt = annotated.indexOf('<');
                String base = (lt > 0 ? annotated.substring(0, lt) : annotated).replace("[]", "").trim();
                ResolvedClassInfo r = OsgiClassResolver.resolveFromCandidates(List.of(base), loaders);
                Class<?> resolvedCls = r == null ? null : ensureLoadedClass(r);
                if (resolvedCls != null) {
                    return resolvedCls;
                }
            }
        }
        try {
            return handling.getGenericReturnType();
        } catch (RuntimeException | LinkageError e) {
            return raw;
        }
    }

    private static void writeOperationSchemaPart(Json j, Type type, List<ClassLoader> loaders,
                                                 int depth, boolean includeExample) {
        Class<?> raw = type instanceof Class<?> c ? c
                : (type instanceof ParameterizedType pt && pt.getRawType() instanceof Class<?> rc ? rc : null);
        if (raw == null && type != null) {
            String tn = TypeFormatter.stableTypeName(type, null);
            if (tn != null) {
                int lt = tn.indexOf('<');
                String base = (lt > 0 ? tn.substring(0, lt) : tn).replace("[]", "").trim();
                ResolvedClassInfo r = OsgiClassResolver.resolveFromCandidates(List.of(base), loaders);
                raw = r == null ? null : ensureLoadedClass(r);
            }
        }
        if (raw == null && type == null) {
            j.beginObject().field("error", "unresolvable-type").endObject();
            return;
        }
        SchemaResult sr = DtoSchemaInspector.inspect(type != null ? type : raw, raw, depth, includeExample);
        j.beginObject()
                .field("javaType", sr.javaType())
                .field("typesVisited", sr.typesVisited())
                .field("truncated", sr.truncated())
                .name("schema").raw(sr.schemaJson());
        if (sr.exampleJson() != null) {
            j.name("example").raw(sr.exampleJson());
        }
        j.endObject();
    }

    private Result disabledError() {
        return error(403, "decompile-disabled", "Enable via -D" + ENABLED_PROPERTY + "=true.");
    }

    private Result invalidTargetError(String code) {
        if ("invalid-class".equals(code)) {
            return error(400, code, "Pass a valid binary Java class name without '..'.");
        }
        return error(400, code, "Pass ?class={fqcn} or ?op={operationKey}.");
    }

    private Result classNotFoundResult(String classCandidates, long fromBundleId, List<ClassLoader> loaders) {
        List<String> suggestions = List.of();
        String hint = "Verify the fully qualified class name or search with /rest/restbrowser/1/code/search?q=...";
        List<String> parsed = OsgiClassResolver.parseCandidates(classCandidates);
        if (!parsed.isEmpty()) {
            String simple = simpleNameOf(parsed.get(0));
            if (simple.length() >= 2) {
                Long bf = fromBundleId >= 0 ? fromBundleId : null;
                SearchResult sr = OsgiClassSearcher.search(simple, 5, bf, loaders, this::pluginKeyForBundle);
                if (!sr.hits().isEmpty()) {
                    suggestions = sr.hits().stream().map(SearchHit::fqcn).toList();
                }
                hint = "Class not found; try /rest/restbrowser/1/code/search?q=" + simple
                        + (fromBundleId < 0 ? " or pass fromBundle={bundleId}." : ".");
            }
        }
        return error(404, "class-not-found", hint, suggestions);
    }

    private static Result error(int status, String reason) {
        return new Result(status, new Json().beginObject().field("error", reason).endObject().toString());
    }

    private static Result error(int status, String reason, String hint) {
        return error(status, reason, hint, List.of());
    }

    private static Result error(int status, String reason, String hint, List<String> suggestions) {
        Json j = new Json().beginObject()
                .field("error", reason)
                .optional("hint", hint);
        if (suggestions != null && !suggestions.isEmpty()) {
            j.strings("suggestions", suggestions);
        }
        return new Result(status, j.endObject().toString());
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
}
