package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.JerseyModelSource.Handler;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.labs.restbrowser.catalog.OperationDetails.Result;
import com.atlassian.labs.restbrowser.catalog.SpecSource.SpecException;
import com.atlassian.labs.restbrowser.inspect.ClassGraphTraverser.ResolvedClassInfo;
import com.atlassian.labs.restbrowser.inspect.TypeProxyUnwrapper;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiClassResolver;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiClassSearcher;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiClassSearcher.SearchHit;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiClassSearcher.SearchResult;
import com.atlassian.labs.restbrowser.json.Json;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import org.osgi.framework.Bundle;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

/**
 * Resolves REST operation keys, Java candidate names, and OSGi bundle classloaders, and builds structured error hints.
 */
final class OperationTargetResolver {

    record ResolvedOp(RestModule module, Handler handler, Result error) {
    }

    record TargetResolution(List<ClassLoader> loaders, ResolvedClassInfo resolved) {
    }

    private final ModuleDiscovery discovery;
    private final Supplier<JerseyModelSource> jersey;
    private final PluginAccessor pluginAccessor;

    OperationTargetResolver(ModuleDiscovery discovery, Supplier<JerseyModelSource> jersey,
                          PluginAccessor pluginAccessor) {
        this.discovery = discovery;
        this.jersey = jersey;
        this.pluginAccessor = pluginAccessor;
    }

    String pluginKeyForBundle(Bundle bundle) {
        Plugin owner = AtlassianPluginInspector.pluginForBundle(pluginAccessor, bundle);
        return owner == null ? null : owner.getKey();
    }

    ResolvedOp resolveOperation(String opKey) throws SpecException {
        RestModule module = OperationDetails.moduleOf(discovery.discover(), opKey);
        if (module == null) {
            return new ResolvedOp(null, null, error(404, "unknown-module",
                    "Check indexed modules via GET /rest/restbrowser/1/catalog."));
        }
        JerseyModelSource src = jersey.get();
        if (src == null || !module.restV2()) {
            return new ResolvedOp(module, null, error(404, "not-described"));
        }
        Optional<Handler> handler = src.handler(module, opKey);
        if (handler.isEmpty() || handler.get().handling() == null) {
            return new ResolvedOp(module, null, unknownOperationResult(module, opKey, src));
        }
        return new ResolvedOp(module, handler.get(), null);
    }

    Result specExceptionResult(String opKey, SpecException e) {
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

    private Result unknownOperationResult(RestModule module, String opKey, JerseyModelSource src) {
        List<String> suggestions = List.of();
        try {
            List<String> allKeys = src.operationKeys(module);
            suggestions = rankSimilarKeys(opKey, allKeys, 5);
        } catch (SpecException | RuntimeException | LinkageError ignored) {
            // best-effort suggestions only
        }
        String hint = "Operation key not found in module '" + module.id()
                + "'; search via GET /rest/restbrowser/1/catalog/operations?module=" + module.id() + ".";
        return error(404, "unknown-operation", hint, suggestions);
    }

    List<ClassLoader> loadersFor(String opKey, long fromBundleId) {
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

    static List<ClassLoader> buildHandlerLoaders(long fromBundleId, Class<?> handlerCls, Class<?> declaringCls) {
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

    TargetResolution resolveTargetAndLoaders(String opKey, String classCandidates, long fromBundleId)
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

    Result classNotFoundResult(String classCandidates, long fromBundleId, List<ClassLoader> loaders) {
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

    static List<String> rankSimilarKeys(String target, List<String> candidates, int limit) {
        if (target == null || candidates == null || candidates.isEmpty()) {
            return List.of();
        }
        String[] want = target.toLowerCase(Locale.ROOT).split("[:/_\\-{}.]+");
        List<Map.Entry<String, Integer>> scored = new ArrayList<>();
        for (String c : candidates) {
            String low = c.toLowerCase(Locale.ROOT);
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

    static Result disabledError() {
        return error(403, "decompile-disabled", "Enable via -D" + OperationSource.ENABLED_PROPERTY + "=true.");
    }

    static Result invalidTargetError(String code) {
        if ("invalid-class".equals(code)) {
            return error(400, code, "Pass a valid binary Java class name without '..'.");
        }
        return error(400, code, "Pass ?class={fqcn} or ?op={operationKey}.");
    }

    static Result error(int status, String reason) {
        return new Result(status, new Json().beginObject().field("error", reason).endObject().toString());
    }

    static Result error(int status, String reason, String hint) {
        return error(status, reason, hint, List.of());
    }

    static Result error(int status, String reason, String hint, List<String> suggestions) {
        Json j = new Json().beginObject()
                .field("error", reason)
                .optional("hint", hint);
        if (suggestions != null && !suggestions.isEmpty()) {
            j.strings("suggestions", suggestions);
        }
        return new Result(status, j.endObject().toString());
    }

    static String cleanMethodFilter(String raw) {
        return raw != null && !raw.isBlank() ? raw.trim() : null;
    }

    static String packageOf(String fqcn) {
        int dot = fqcn.lastIndexOf('.');
        return dot > 0 ? fqcn.substring(0, dot) : "";
    }

    static String simpleNameOf(String fqcn) {
        int dot = fqcn.lastIndexOf('.');
        String tail = dot >= 0 ? fqcn.substring(dot + 1) : fqcn;
        return tail.replace('$', '.');
    }

    static String stripLeadingSlashes(String s) {
        if (s == null) return "";
        int i = 0;
        while (i < s.length() && s.charAt(i) == '/') i++;
        return s.substring(i);
    }
}
