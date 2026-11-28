package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.OperationDetails.Result;
import com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.TargetResolution;
import com.atlassian.labs.restbrowser.catalog.SpecSource.SpecException;
import com.atlassian.labs.restbrowser.decompile.LineSlicer;
import com.atlassian.labs.restbrowser.decompile.LineSlicer.Slice;
import com.atlassian.labs.restbrowser.inspect.ClassGraphTraverser.ResolvedClassInfo;
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
import org.osgi.framework.Bundle;

import java.lang.reflect.Modifier;
import java.util.List;

import static com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.cleanMethodFilter;
import static com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.disabledError;
import static com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.error;
import static com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.invalidTargetError;
import static com.atlassian.labs.restbrowser.catalog.OperationTargetResolver.simpleNameOf;

/**
 * OSGi-wide code search and resource endpoints backing {@link CodeInvestigationService}: class search,
 * service/subtype lookup, bytecode constant-pool grep, method caller lookup, and text bundle resource reads.
 */
final class CodeSearchAndResourceService {

    private final OperationSource owner;
    private final OperationTargetResolver targets;

    CodeSearchAndResourceService(OperationSource owner, OperationTargetResolver targets) {
        this.owner = owner;
        this.targets = targets;
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
}
