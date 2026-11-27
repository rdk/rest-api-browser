package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.OperationDetails.Result;
import com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.ResolvedOp;
import com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.TargetResolution;
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
import com.atlassian.labs.restbrowser.inspect.ClassGraphTraverser.ResolvedClassInfo;
import com.atlassian.labs.restbrowser.inspect.SingleFlightLruCache;
import com.atlassian.labs.restbrowser.inspect.TypeProxyUnwrapper;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiClassResolver;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiImplementationFinder;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiImplementationFinder.ImplementationResult;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiImplementationFinder.OsgiServiceHit;
import com.atlassian.labs.restbrowser.json.Json;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

import static com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.cleanMethodFilter;
import static com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.disabledError;
import static com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.error;
import static com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.invalidTargetError;
import static java.util.Objects.requireNonNull;

/**
 * Facade for on-demand Java bytecode decompilation, class/OSGi/plugin metadata inspection, and code graph traversal.
 * <p>
 * Collaborates with {@link OperationTargetResolver}, {@link ClassMetadataSerializer}, and
 * {@link CodeInvestigationService}, maintains single-flight concurrency-bounded LRU caches, and honors
 * {@code -Drest.api.browser.decompile=false}.
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

    record CachedOutput(String source, List<String> refs, int totalLines, List<String> warnings) {
    }

    private record InspectKey(String className, long bundleId, long bundleModified, boolean compact, boolean outline) {
    }

    public record OperationSchemas(String requestSchemaJson, String requestExampleJson,
                                   String responseSchemaJson, String responseExampleJson) {
    }

    private final BooleanSupplier enabled;
    private final PluginAccessor pluginAccessor;
    private final ProductAdapter product;
    private final OperationTargetResolver targets;
    private final CodeInvestigationService investigations;

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
        ModuleDiscovery reqDiscovery = requireNonNull(discovery);
        Supplier<JerseyModelSource> reqJersey = requireNonNull(jersey);
        this.pluginAccessor = pluginAccessor;
        this.product = product;
        this.enabled = requireNonNull(enabled);
        this.targets = new OperationTargetResolver(reqDiscovery, reqJersey, pluginAccessor);
        this.investigations = new CodeInvestigationService(this, targets, reqDiscovery, reqJersey, pluginAccessor);
    }

    public boolean isEnabled() {
        return enabled.getAsBoolean();
    }

    // ---- decompilation

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
            List<ClassLoader> loaders = targets.loadersFor(opKey, fromBundleId);
            ResolvedClassInfo resolved = OsgiClassResolver.resolveFromCandidates(candidates, loaders);
            if (resolved == null) {
                return targets.classNotFoundResult(candidates.get(0), fromBundleId, loaders);
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
            List<ClassLoader> loaders = targets.loadersFor(opKey, fromBundleId);
            ResolvedClassInfo resolved = OsgiClassResolver.resolveFromCandidates(candidates, loaders);
            if (resolved == null) {
                return targets.classNotFoundResult(candidates.get(0), fromBundleId, loaders);
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
            op = targets.resolveOperation(opKey);
        } catch (SpecException e) {
            return targets.specExceptionResult(opKey, e);
        }
        if (op.error() != null) {
            return op.error();
        }
        Method handling = op.handler().handling();
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

    Result runAndFormat(String key, ResolvedClassInfo resolved, String scope, String methodName,
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

    CachedOutput decompileCached(ResolvedClassInfo resolved, String scope, String methodName,
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
            target = targets.resolveTargetAndLoaders(opKey, classCandidates, fromBundleId);
        } catch (IllegalArgumentException e) {
            return invalidTargetError(e.getMessage());
        } catch (SpecException e) {
            return targets.specExceptionResult(opKey, e);
        }
        ResolvedClassInfo resolved = target.resolved();
        if (resolved == null) {
            return targets.classNotFoundResult(classCandidates, fromBundleId, target.loaders());
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
                    resolved.name(), targets::pluginKeyForBundle);
            if (!services.isEmpty()) {
                extra.append(",\"osgiServices\":").append(ClassMetadataSerializer.serializeServices(services));
            }
            if (includeImplementations) {
                ImplementationResult ir = OsgiImplementationFinder.find(
                        resolved.name(), resolved.bundleId(), null, null, false, 10, targets::pluginKeyForBundle);
                extra.append(",\"implementations\":").append(ClassMetadataSerializer.serializeImplHits(ir.implementations()));
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

    String buildClassInfoJson(ResolvedClassInfo resolved, long[] elapsedMs, boolean[] fromCache,
                              List<String> precomputedRefs, boolean compact, boolean outline) {
        InspectKey key = new InspectKey(resolved.name(), resolved.bundleId(), resolved.bundleModified(), compact, outline);
        long t0 = System.nanoTime();
        String json = inspectCache.getOrCompute(key,
                () -> ClassMetadataSerializer.buildClassInfoUncached(
                        resolved, precomputedRefs, compact, outline, pluginAccessor, product),
                fromCache);
        elapsedMs[0] = fromCache[0] ? 0L : Math.max(1L, (System.nanoTime() - t0) / 1_000_000L);
        return json;
    }

    // ---- agent & code intelligence delegations

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
        return investigations.traverseGraph(opKey, classCandidates, fromBundleId, rawDepth, rawMaxNodes,
                includeJdk, excludeLibraries, packagePrefix, includeSources, decompiler, edgeKindsFilter);
    }

    public Result searchClasses(String rawQuery, int rawLimit, Long bundleIdFilter) {
        return investigations.searchClasses(rawQuery, rawLimit, bundleIdFilter);
    }

    public Result operationBundle(String opKey, String scope, String decompiler, OperationDetails details) {
        return operationBundle(opKey, scope, decompiler, details, false, null, null, false);
    }

    public Result operationBundle(String opKey, String scope, String decompiler, OperationDetails details,
                                  boolean compact, Integer startLine, Integer maxLines, boolean lineNumbers) {
        return investigations.operationBundle(opKey, scope, decompiler, details, compact, startLine, maxLines, lineNumbers);
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
        return investigations.batchItems(rawItems);
    }

    public Result inspectSchema(String opKey, String classCandidates, long fromBundleId, int depth, boolean includeExample) {
        return investigations.inspectSchema(opKey, classCandidates, fromBundleId, depth, includeExample);
    }

    public Result findImplementations(String opKey, String classCandidates, long fromBundleId,
                                      Long bundleIdFilter, String pluginKeyFilter,
                                      boolean includeAbstract, int limit) {
        return investigations.findImplementations(opKey, classCandidates, fromBundleId, bundleIdFilter,
                pluginKeyFilter, includeAbstract, limit);
    }

    public Result grepBytecode(String rawQuery, boolean caseSensitive, boolean includeUtf8,
                               Long bundleIdFilter, String pluginKeyFilter, String packagePrefix, int limit) {
        return investigations.grepBytecode(rawQuery, caseSensitive, includeUtf8, bundleIdFilter,
                pluginKeyFilter, packagePrefix, limit);
    }

    public Result findCallers(String opKey, String classCandidates, String methodFilter, long fromBundleId,
                              Long bundleIdFilter, String pluginKeyFilter, String packagePrefix, int limit) {
        return investigations.findCallers(opKey, classCandidates, methodFilter, fromBundleId, bundleIdFilter,
                pluginKeyFilter, packagePrefix, limit);
    }

    public Result inspectResource(Long bundleId, String pluginKey, String path, String prefix,
                                  Integer startLine, Integer maxLines, boolean lineNumbers, int limit) {
        return investigations.readOrListResource(bundleId, pluginKey, path, prefix, startLine, maxLines, lineNumbers, limit, false);
    }

    public Result inspectResourceText(Long bundleId, String pluginKey, String path, String prefix,
                                      Integer startLine, Integer maxLines, boolean lineNumbers, int limit) {
        return investigations.readOrListResource(bundleId, pluginKey, path, prefix, startLine, maxLines, lineNumbers, limit, true);
    }

    public Map<String, OperationSchemas> moduleOperationSchemas(String moduleId, int depth, int maxOps) {
        return investigations.moduleOperationSchemas(moduleId, depth, maxOps);
    }

    public Result investigationContext(CatalogSnapshot snapshot, String opKey, String url, String method,
                                        int maxLines, int schemaDepth, boolean includeSchemas,
                                        boolean includeImplementations, boolean includeSource,
                                        boolean lineNumbers, String decompiler, OperationDetails details) {
        return investigations.investigationContext(snapshot, opKey, url, method, maxLines, schemaDepth,
                includeSchemas, includeImplementations, includeSource, lineNumbers, decompiler, details);
    }

    // ---- delegating hooks for unit tests

    static List<String> rankSimilarKeys(String target, List<String> candidates, int limit) {
        return OperationTargetResolver.rankSimilarKeys(target, candidates, limit);
    }

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
