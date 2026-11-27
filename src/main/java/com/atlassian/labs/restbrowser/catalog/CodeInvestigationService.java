package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.CatalogQuery.TopResolution;
import com.atlassian.labs.restbrowser.catalog.JerseyModelSource.Handler;
import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.OperationSpec;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.labs.restbrowser.catalog.OperationDetails.Result;
import com.atlassian.labs.restbrowser.catalog.OperationSource.BatchItem;
import com.atlassian.labs.restbrowser.catalog.OperationSource.CachedOutput;
import com.atlassian.labs.restbrowser.catalog.OperationSource.Engine;
import com.atlassian.labs.restbrowser.catalog.OperationSource.OperationSchemas;
import com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.ResolvedOp;
import com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.TargetResolution;
import com.atlassian.labs.restbrowser.catalog.SpecSource.SpecException;
import com.atlassian.labs.restbrowser.decompile.LineSlicer;
import com.atlassian.labs.restbrowser.decompile.LineSlicer.Slice;
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
import com.atlassian.labs.restbrowser.json.Json;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import org.osgi.framework.Bundle;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Type;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;

import static com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.buildHandlerLoaders;
import static com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.cleanMethodFilter;
import static com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.disabledError;
import static com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.error;
import static com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.invalidTargetError;
import static com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.simpleNameOf;

/**
 * Orchestrates higher-level code intelligence workflows: reference graphs, batching, DTO schema synthesis,
 * OSGi implementations, constant-pool callers/grep, bundle resource reading, and one-shot investigation context.
 */
final class CodeInvestigationService {

    private static final long GRAPH_TIME_BUDGET_MS = 15_000L;
    private static final int MAX_GRAPH_NODES_WITH_SOURCES = 10;
    private static final int MAX_GRAPH_SOURCE_LINES = 500;

    private final OperationSource owner;
    private final OperationTargetResolver targets;
    private final ModuleDiscovery discovery;
    private final Supplier<JerseyModelSource> jersey;
    private final PluginAccessor pluginAccessor;

    CodeInvestigationService(OperationSource owner, OperationTargetResolver targets,
                             ModuleDiscovery discovery, Supplier<JerseyModelSource> jersey,
                             PluginAccessor pluginAccessor) {
        this.owner = owner;
        this.targets = targets;
        this.discovery = discovery;
        this.jersey = jersey;
        this.pluginAccessor = pluginAccessor;
    }

    Result traverseGraph(String opKey, String classCandidates, long fromBundleId,
                         int rawDepth, int rawMaxNodes, boolean includeJdk, boolean excludeLibraries,
                         String packagePrefix, boolean includeSources, String decompiler,
                         String edgeKindsFilter) {
        if (!owner.isEnabled()) {
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
            TargetResolution target = targets.resolveTargetAndLoaders(opKey, classCandidates, fromBundleId);
            baseLoaders = target.loaders();
            root = target.resolved();
        } catch (IllegalArgumentException e) {
            return invalidTargetError(e.getMessage());
        } catch (SpecException e) {
            return targets.specExceptionResult(opKey, e);
        }
        if (root == null) {
            return targets.classNotFoundResult(classCandidates, fromBundleId, baseLoaders);
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
                    CachedOutput src = owner.decompileCached(r, "class", null, -1, engine, new long[1], new boolean[1], null);
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
            Plugin plug = AtlassianPluginInspector.pluginForBundle(pluginAccessor, b);
            j.beginObject()
                    .field("class", r.name())
                    .field("simpleName", simpleNameOf(r.name()))
                    .field("kind", c == null ? "class" : (c.isAnnotation() ? "annotation" : c.isInterface() ? "interface"
                            : c.isEnum() ? "enum" : c.isRecord() ? "record" : "class"))
                    .field("bundleId", r.bundleId())
                    .optional("bundle", b == null ? null : b.getSymbolicName() + " " + b.getVersion())
                    .optional("plugin", plug == null ? null : plug.getKey())
                    .optional("pluginName", plug == null ? null : plug.getName())
                    .field("methodCount", ClassMetadataSerializer.safeMethodCount(c))
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

    Result searchClasses(String rawQuery, int rawLimit, Long bundleIdFilter) {
        if (!owner.isEnabled()) {
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
        SearchResult sr = OsgiClassSearcher.search(query, limit, bundleIdFilter, loaders, targets::pluginKeyForBundle);

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

    Result operationBundle(String opKey, String scope, String decompiler, OperationDetails details,
                           boolean compact, Integer startLine, Integer maxLines, boolean lineNumbers) {
        if (!owner.isEnabled()) {
            return disabledError();
        }
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
        // Reuse the single resolved module + handler for both details and source (avoids duplicate Jersey walk!)
        Result detailRes = details.describeHandler(opKey, op.module(), op.handler(), compact);
        if (detailRes.status() != 200) {
            return detailRes;
        }
        Engine engine = Engine.parse(decompiler);
        Method handling = op.handler().handling();
        ResolvedClassInfo resolved = OsgiClassResolver.resolveLoaded(TypeProxyUnwrapper.targetClass(handling.getDeclaringClass()));
        Result srcRes;
        if (resolved == null) {
            srcRes = error(404, "class-not-found");
        } else {
            boolean wholeClass = "class".equalsIgnoreCase(scope);
            srcRes = owner.runAndFormat(opKey, resolved, wholeClass ? "class" : "method",
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

    Result batchItems(List<BatchItem> rawItems) {
        if (!owner.isEnabled()) {
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
            loaders = loaderCache.computeIfAbsent(loaderKey, k -> targets.loadersFor(item.opKey(), item.fromBundle()));
            List<String> candidates = OsgiClassResolver.parseCandidates(item.cls());
            if (candidates.isEmpty()) {
                return error(400, "invalid-class", "Pass a valid binary Java class name without '..'.");
            }
            resolved = OsgiClassResolver.resolveFromCandidates(candidates, loaders);
            if (resolved == null) {
                return targets.classNotFoundResult(candidates.get(0), item.fromBundle(), loaders);
            }
        } else {
            try {
                TargetResolution target = targets.resolveTargetAndLoaders(item.opKey(), null, item.fromBundle());
                loaders = target.loaders();
                resolved = target.resolved();
            } catch (IllegalArgumentException e) {
                return invalidTargetError(e.getMessage());
            } catch (SpecException e) {
                return targets.specExceptionResult(item.opKey(), e);
            }
            if (resolved == null) {
                return targets.classNotFoundResult(item.opKey(), item.fromBundle(), loaders);
            }
        }
        Engine engine = Engine.parse(item.decompiler());
        String targetMethod = cleanMethodFilter(item.method());
        String resolvedScope = ("method".equalsIgnoreCase(item.scope()) && targetMethod != null) ? "method" : "class";
        Result base;
        if (item.includeSource()) {
            base = owner.runAndFormat(item.opKey(), resolved, resolvedScope, targetMethod, -1, engine,
                    item.startLine(), item.maxLines(), item.includeMeta(), item.lineNumbers(), true);
        } else {
            long[] elapsed = new long[1];
            boolean[] fromCache = new boolean[1];
            try {
                String body = owner.buildClassInfoJson(resolved, elapsed, fromCache, null, false, false);
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
            Class<?> cls = ClassMetadataSerializer.ensureLoadedClass(resolved);
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

    Result inspectSchema(String opKey, String classCandidates, long fromBundleId, int depth, boolean includeExample) {
        if (!owner.isEnabled()) {
            return disabledError();
        }
        if (classCandidates != null && !classCandidates.isBlank()) {
            TargetResolution target;
            try {
                target = targets.resolveTargetAndLoaders(opKey, classCandidates, fromBundleId);
            } catch (IllegalArgumentException e) {
                return invalidTargetError(e.getMessage());
            } catch (SpecException e) {
                return error(503, e.reason());
            }
            ResolvedClassInfo resolved = target.resolved();
            if (resolved == null) {
                return targets.classNotFoundResult(classCandidates, fromBundleId, target.loaders());
            }
            Class<?> cls = ClassMetadataSerializer.ensureLoadedClass(resolved);
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
            op = targets.resolveOperation(opKey);
        } catch (SpecException e) {
            return targets.specExceptionResult(opKey, e);
        }
        if (op.error() != null) {
            return op.error();
        }
        Method handling = op.handler().handling();
        Method def = op.handler().definition();
        List<ClassLoader> opLoaders = buildHandlerLoaders(fromBundleId, op.handler().handlerClass(),
                handling.getDeclaringClass());
        Json j = new Json().beginObject()
                .field("format", 1)
                .field("key", opKey);
        Type reqType = ClassMetadataSerializer.findEntityParameterType(handling, def);
        if (reqType != null) {
            j.name("requestBody");
            ClassMetadataSerializer.writeOperationSchemaPart(j, reqType, opLoaders, depth, includeExample);
        }
        Type respType = ClassMetadataSerializer.resolveOperationReturnType(handling, def, opLoaders);
        if (respType != null) {
            j.name("responseBody");
            ClassMetadataSerializer.writeOperationSchemaPart(j, respType, opLoaders, depth, includeExample);
        }
        return new Result(200, j.endObject().toString());
    }

    Result findImplementations(String opKey, String classCandidates, long fromBundleId,
                               Long bundleIdFilter, String pluginKeyFilter,
                               boolean includeAbstract, int limit) {
        if (!owner.isEnabled()) {
            return disabledError();
        }
        long t0 = System.nanoTime();
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
        ImplementationResult res = OsgiImplementationFinder.find(
                resolved.name(), resolved.bundleId(), bundleIdFilter, pluginKeyFilter,
                includeAbstract, limit, targets::pluginKeyForBundle);
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

    Result grepBytecode(String rawQuery, boolean caseSensitive, boolean includeUtf8,
                        Long bundleIdFilter, String pluginKeyFilter, String packagePrefix, int limit) {
        if (!owner.isEnabled()) {
            return disabledError();
        }
        String query = rawQuery == null ? "" : rawQuery;
        if (query.trim().length() < 2) {
            return error(400, "query-too-short", "Pass ?q={text} with at least 2 non-whitespace characters.");
        }
        long t0 = System.nanoTime();
        GrepResult sr = OsgiBytecodeScanner.grep(
                query, caseSensitive, includeUtf8, bundleIdFilter, pluginKeyFilter,
                packagePrefix, limit, targets::pluginKeyForBundle);
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

    Result findCallers(String opKey, String classCandidates, String methodFilter, long fromBundleId,
                       Long bundleIdFilter, String pluginKeyFilter, String packagePrefix, int limit) {
        if (!owner.isEnabled()) {
            return disabledError();
        }
        long t0 = System.nanoTime();
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
        String cleanMethod = cleanMethodFilter(methodFilter);
        CallersResult res = OsgiBytecodeScanner.findCallers(
                resolved.name(), cleanMethod, resolved.bundleId(), bundleIdFilter, pluginKeyFilter,
                packagePrefix, limit, targets::pluginKeyForBundle);
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

    Result readOrListResource(Long bundleId, String pluginKey, String path, String prefix,
                                Integer startLine, Integer maxLines, boolean lineNumbers, int limit,
                                boolean plainText) {
        if (!owner.isEnabled()) {
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
        String pKey = targets.pluginKeyForBundle(bundle);
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

    Map<String, OperationSchemas> moduleOperationSchemas(String moduleId, int depth, int maxOps) {
        if (!owner.isEnabled() || moduleId == null || moduleId.isBlank()) {
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
                Type reqType = ClassMetadataSerializer.findEntityParameterType(handling, def);
                Type respType = ClassMetadataSerializer.resolveOperationReturnType(handling, def, loaders);
                SchemaResult reqSr = reqType == null ? null : ClassMetadataSerializer.inspectTypeSchema(reqType, loaders, depth);
                SchemaResult respSr = respType == null ? null : ClassMetadataSerializer.inspectTypeSchema(respType, loaders, depth);
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

    Result investigationContext(CatalogSnapshot snapshot, String opKey, String url, String method,
                                 int maxLines, int schemaDepth, boolean includeSchemas,
                                 boolean includeImplementations, boolean includeSource,
                                 boolean lineNumbers, String decompiler, OperationDetails details) {
        if (!owner.isEnabled()) {
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
            op = targets.resolveOperation(effectiveKey);
        } catch (SpecException e) {
            return targets.specExceptionResult(effectiveKey, e);
        }
        if (op.error() != null) {
            return op.error();
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
            Result detailRes = details.describeHandler(effectiveKey, op.module(), op.handler(), true);
            if (detailRes.status() == 200) {
                j.name("details").raw(detailRes.json());
            }
        }

        Method handling = op.handler().handling();
        Method def = op.handler().definition();
        List<ClassLoader> opLoaders = buildHandlerLoaders(-1L, op.handler().handlerClass(),
                handling.getDeclaringClass());
        if (includeSchemas) {
            Type reqType = ClassMetadataSerializer.findEntityParameterType(handling, def);
            if (reqType != null) {
                j.name("requestBody");
                ClassMetadataSerializer.writeOperationSchemaPart(j, reqType, opLoaders, schemaDepth, true);
            }
            Type respType = ClassMetadataSerializer.resolveOperationReturnType(handling, def, opLoaders);
            if (respType != null) {
                j.name("responseBody");
                ClassMetadataSerializer.writeOperationSchemaPart(j, respType, opLoaders, schemaDepth, true);
            }
        }

        if (includeSource) {
            int budget = Math.max(20, Math.min(800, maxLines <= 0 ? 400 : maxLines));
            ResolvedClassInfo resolved = OsgiClassResolver.resolveLoaded(TypeProxyUnwrapper.targetClass(handling.getDeclaringClass()));
            Result srcRes = resolved == null
                    ? error(404, "class-not-found")
                    : owner.runAndFormat(effectiveKey, resolved, "method", handling.getName(),
                            handling.getParameterCount(), Engine.parse(decompiler), 1, budget,
                            false, lineNumbers, true);
            j.name("source").raw(srcRes.json());
        }

        if (includeImplementations) {
            j.name("dependencies").beginArray();
            Set<Class<?>> seenDepTypes = new LinkedHashSet<>();
            int depCount = 0;
            for (Class<?> ownerCls : new Class<?>[]{
                    op.handler().handlerClass() == null ? null : TypeProxyUnwrapper.targetClass(op.handler().handlerClass()),
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
                            ftn, fb == null ? -1L : fb.getBundleId(), null, null, false, 5, targets::pluginKeyForBundle);
                    j.beginObject()
                            .field("field", f.getName())
                            .field("type", ftn)
                            .name("services").raw(ClassMetadataSerializer.serializeServices(ir.services()))
                            .strings("implementations", ir.implementations().stream().map(ImplHit::fqcn).toList())
                            .endObject();
                }
            }
            j.endArray();
        }

        return new Result(200, j.endObject().toString());
    }

    private static Set<String> parseCsvSet(String csv) {
        Set<String> set = new LinkedHashSet<>();
        if (csv != null && !csv.isBlank()) {
            for (String p : csv.split(",")) {
                if (!p.isBlank()) {
                    set.add(p.trim().toLowerCase(Locale.ROOT));
                }
            }
        }
        return set;
    }
}
