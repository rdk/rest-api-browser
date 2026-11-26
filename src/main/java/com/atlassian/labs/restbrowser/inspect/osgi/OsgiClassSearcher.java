package com.atlassian.labs.restbrowser.inspect.osgi;

import com.atlassian.labs.restbrowser.inspect.ClassFileInspector;
import com.atlassian.labs.restbrowser.inspect.ClassGraphTraverser.ResolvedClassInfo;
import org.osgi.framework.Bundle;
import org.osgi.framework.BundleContext;
import org.osgi.framework.FrameworkUtil;

import java.net.URL;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * Bounded substring/prefix searcher across active/resolved OSGi bundles and context classloaders.
 */
public final class OsgiClassSearcher {

    /** Precompiled once rather than recompiled per {@code .class} entry across all bundles. */
    private static final Pattern ANON_INNER = Pattern.compile("\\$\\d+");
    private static final long SEARCH_TIME_BUDGET_MS = 3_000L;

    public record SearchHit(String fqcn, long bundleId, String bundleLabel, String pluginKey) {
    }

    public record SearchResult(List<SearchHit> hits, boolean truncated) {
    }

    private OsgiClassSearcher() {
    }

    public static SearchResult search(String rawQuery, int limit, Long bundleIdFilter,
                                      List<ClassLoader> fallbackLoaders,
                                      Function<Bundle, String> pluginKeyForBundle) {
        String query = rawQuery == null ? "" : rawQuery.trim();
        if (query.contains("..")) {
            return new SearchResult(List.of(), false);
        }
        String needle = query.toLowerCase(Locale.ROOT);
        boolean includeAnonymous = needle.contains("$");
        Map<String, SearchHit> hits = new LinkedHashMap<>();
        boolean truncated = false;
        long deadlineNanos = System.nanoTime() + SEARCH_TIME_BUDGET_MS * 1_000_000L;

        try {
            Bundle self = FrameworkUtil.getBundle(OsgiClassSearcher.class);
            BundleContext ctx = self == null ? null : self.getBundleContext();
            if (ctx != null) {
                Bundle[] bundles;
                if (bundleIdFilter != null && bundleIdFilter >= 0) {
                    Bundle target = ctx.getBundle(bundleIdFilter);
                    bundles = target == null ? new Bundle[0] : new Bundle[]{target};
                } else {
                    bundles = ctx.getBundles();
                }
                if (bundles != null) {
                    outer:
                    for (Bundle b : bundles) {
                        if (System.nanoTime() - deadlineNanos > 0) {
                            truncated = true;
                            break;
                        }
                        try {
                            int st = b.getState();
                            if (st != Bundle.ACTIVE && st != Bundle.RESOLVED && st != Bundle.STARTING) {
                                continue;
                            }
                            Enumeration<URL> entries = b.findEntries("/", "*.class", true);
                            if (entries == null) {
                                continue;
                            }
                            String bundleLabel = b.getSymbolicName() + " " + b.getVersion();
                            long bundleId = b.getBundleId();
                            String ownerKey = null;
                            boolean ownerChecked = false;
                            while (entries.hasMoreElements()) {
                                if (System.nanoTime() - deadlineNanos > 0) {
                                    truncated = true;
                                    break outer;
                                }
                                String fqcn = ClassFileInspector.bundlePathToClassName(entries.nextElement().getPath());
                                if (fqcn == null) {
                                    continue;
                                }
                                if (!includeAnonymous && ANON_INNER.matcher(fqcn).find()) {
                                    continue;
                                }
                                if (fqcn.toLowerCase(Locale.ROOT).contains(needle)) {
                                    if (!hits.containsKey(fqcn)) {
                                        if (hits.size() >= limit) {
                                            truncated = true;
                                            break outer;
                                        }
                                        if (!ownerChecked) {
                                            ownerKey = pluginKeyForBundle == null ? null : pluginKeyForBundle.apply(b);
                                            ownerChecked = true;
                                        }
                                        hits.put(fqcn, new SearchHit(fqcn, bundleId, bundleLabel, ownerKey));
                                    }
                                }
                            }
                        } catch (RuntimeException | LinkageError ignored) {
                            // skip bundle uninstalled or refreshed mid-scan
                        }
                    }
                }
            }
        } catch (RuntimeException | LinkageError ignored) {
            // outside OSGi
        }

        // Exact class lookup via context classloaders (tests / JDK classes)
        if (hits.size() < limit && ClassFileInspector.SAFE_CLASS_NAME.matcher(query).matches() && !hits.containsKey(query)) {
            ResolvedClassInfo r = OsgiClassResolver.resolveFromCandidates(List.of(query), fallbackLoaders);
            if (r != null && (bundleIdFilter == null || bundleIdFilter < 0 || r.bundleId() == bundleIdFilter)) {
                hits.putIfAbsent(r.name(), new SearchHit(r.name(), r.bundleId(), null, null));
            }
        }
        return new SearchResult(List.copyOf(hits.values()), truncated);
    }
}
