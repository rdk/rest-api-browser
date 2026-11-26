package com.atlassian.labs.restbrowser.inspect.osgi;

import com.atlassian.labs.restbrowser.inspect.BytecodeReader;
import com.atlassian.labs.restbrowser.inspect.ClassFileInspector;
import com.atlassian.labs.restbrowser.inspect.ClassFileInspector.MethodRef;
import com.atlassian.labs.restbrowser.inspect.ClassFileInspector.StringConstant;
import org.osgi.framework.Bundle;

import java.net.URL;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.Function;

/**
 * Fast, bounded OSGi bytecode constant-pool scanner for {@code /code/grep} and {@code /code/callers} without
 * loading or decompiling classes. Zero Atlassian coupling.
 */
public final class OsgiBytecodeScanner {

    private static final long SCAN_TIME_BUDGET_MS = 4_000L;
    private static final int MAX_SCANNED_CLASSES = 8_000;
    private static final int MAX_SNIPPET_CHARS = 200;
    private static final int MAX_MATCHES_PER_CLASS = 5;

    public record GrepHit(String fqcn, long bundleId, String bundleLabel, String pluginKey, List<String> matches) {
    }

    public record GrepResult(List<GrepHit> hits, int scannedClasses, int scannedBundles, boolean truncated) {
    }

    public record CallerHit(String fqcn, long bundleId, String bundleLabel, String pluginKey, List<String> calls) {
    }

    public record CallersResult(List<CallerHit> hits, int scannedClasses, int scannedBundles, boolean truncated) {
    }

    private OsgiBytecodeScanner() {
    }

    public static GrepResult grep(String rawQuery, boolean caseSensitive, boolean includeUtf8,
                                  Long bundleIdFilter, String pluginKeyFilter, String packagePrefix,
                                  int rawLimit, Function<Bundle, String> pluginKeyForBundle) {
        String query = rawQuery == null ? "" : rawQuery;
        int limit = Math.max(1, Math.min(100, rawLimit <= 0 ? 50 : rawLimit));
        String pkgFilter = packagePrefix == null ? "" : packagePrefix.trim();
        List<Bundle> bundles = OsgiBundleInspector.selectBundles(bundleIdFilter, pluginKeyFilter, pluginKeyForBundle);
        ScanOutcome<GrepHit> out = scanBundles(bundles, pkgFilter, limit, pluginKeyForBundle,
                (fqcn, bytes, bid, bLabel, pKey) -> {
                    List<String> m = matchStrings(bytes, query, caseSensitive, includeUtf8);
                    return m.isEmpty() ? null : new GrepHit(fqcn, bid, bLabel, pKey, m);
                });
        return new GrepResult(out.hits, out.scannedClasses, out.scannedBundles, out.truncated);
    }

    public static CallersResult findCallers(String targetFqcn, String methodFilter, long targetBundleId,
                                            Long bundleIdFilter, String pluginKeyFilter, String packagePrefix,
                                            int rawLimit, Function<Bundle, String> pluginKeyForBundle) {
        int limit = Math.max(1, Math.min(100, rawLimit <= 0 ? 50 : rawLimit));
        String pkgFilter = packagePrefix == null ? "" : packagePrefix.trim();
        String method = methodFilter == null || methodFilter.isBlank() ? null : methodFilter.trim();
        List<Bundle> bundles = selectCallerBundles(targetFqcn, targetBundleId, bundleIdFilter, pluginKeyFilter, pluginKeyForBundle);
        ScanOutcome<CallerHit> out = scanBundles(bundles, pkgFilter, limit, pluginKeyForBundle,
                (fqcn, bytes, bid, bLabel, pKey) -> {
                    if (fqcn.equals(targetFqcn)) {
                        return null;
                    }
                    List<String> calls = matchCalls(bytes, targetFqcn, method);
                    return calls.isEmpty() ? null : new CallerHit(fqcn, bid, bLabel, pKey, calls);
                });
        return new CallersResult(out.hits, out.scannedClasses, out.scannedBundles, out.truncated);
    }

    /** Pure classfile string constant matcher (exposed for direct unit testing). */
    public static List<String> matchStrings(byte[] classBytes, String query, boolean caseSensitive, boolean includeUtf8) {
        if (query == null || query.isEmpty()) {
            return List.of();
        }
        String needle = caseSensitive ? query : query.toLowerCase(Locale.ROOT);
        List<String> matches = new ArrayList<>();
        for (StringConstant sc : ClassFileInspector.extractStringConstants(classBytes, includeUtf8)) {
            String v = sc.value();
            String hay = caseSensitive ? v : v.toLowerCase(Locale.ROOT);
            if (hay.contains(needle)) {
                matches.add(v.length() <= MAX_SNIPPET_CHARS ? v : OsgiBundleInspector.cut(v, MAX_SNIPPET_CHARS));
                if (matches.size() >= MAX_MATCHES_PER_CLASS) {
                    break;
                }
            }
        }
        return List.copyOf(matches);
    }

    /** Pure classfile method-call matcher (exposed for direct unit testing). */
    public static List<String> matchCalls(byte[] classBytes, String targetFqcn, String methodFilter) {
        if (targetFqcn == null || targetFqcn.isEmpty()) {
            return List.of();
        }
        Set<String> calls = new LinkedHashSet<>();
        for (MethodRef ref : ClassFileInspector.extractMethodRefs(classBytes)) {
            if (!targetFqcn.equals(ref.owner())) {
                continue;
            }
            if (methodFilter != null && !methodFilter.equals(ref.name())) {
                continue;
            }
            calls.add(ref.name() + ref.descriptor());
            if (calls.size() >= MAX_MATCHES_PER_CLASS) {
                break;
            }
        }
        return List.copyOf(calls);
    }

    private static List<Bundle> selectCallerBundles(String targetFqcn, long targetBundleId, Long bundleIdFilter,
                                                    String pluginKeyFilter, Function<Bundle, String> pluginKeyForBundle) {
        if ((bundleIdFilter != null && bundleIdFilter >= 0) || (pluginKeyFilter != null && !pluginKeyFilter.isBlank())) {
            return OsgiBundleInspector.selectBundles(bundleIdFilter, pluginKeyFilter, pluginKeyForBundle);
        }
        Bundle defining = OsgiClassResolver.bundleByIdOrClass(targetBundleId, null);
        if (defining != null && targetFqcn != null) {
            int dot = targetFqcn.lastIndexOf('.');
            String pkg = dot > 0 ? targetFqcn.substring(0, dot) : "";
            List<Bundle> wired = OsgiBundleInspector.bundlesUsingPackage(defining, pkg);
            if (!wired.isEmpty()) {
                return wired;
            }
        }
        return OsgiBundleInspector.selectBundles(null, null, pluginKeyForBundle);
    }

    @FunctionalInterface
    private interface BytecodeMatcher<T> {
        T match(String fqcn, byte[] bytes, long bundleId, String bundleLabel, String pluginKey);
    }

    private record ScanOutcome<T>(List<T> hits, int scannedClasses, int scannedBundles, boolean truncated) {
    }

    private static <T> ScanOutcome<T> scanBundles(List<Bundle> bundles, String pkgFilter, int limit,
                                                  Function<Bundle, String> pluginKeyForBundle,
                                                  BytecodeMatcher<T> matcher) {
        List<T> hits = new ArrayList<>();
        int scannedClasses = 0;
        int scannedBundles = 0;
        boolean truncated = false;
        long deadlineNanos = System.nanoTime() + SCAN_TIME_BUDGET_MS * 1_000_000L;

        for (Bundle b : bundles) {
            if (System.nanoTime() - deadlineNanos > 0 || hits.size() >= limit || scannedClasses >= MAX_SCANNED_CLASSES) {
                truncated = true;
                break;
            }
            if (!OsgiBundleInspector.isScannableState(b)) {
                continue;
            }
            scannedBundles++;
            long bid = b.getBundleId();
            String bLabel = OsgiBundleInspector.bundleLabel(b);
            String pKey = OsgiBundleInspector.pluginKey(b, pluginKeyForBundle);
            try {
                Enumeration<URL> entries = b.findEntries("/", "*.class", true);
                if (entries == null) {
                    continue;
                }
                while (entries.hasMoreElements()) {
                    if (System.nanoTime() - deadlineNanos > 0 || scannedClasses >= MAX_SCANNED_CLASSES) {
                        truncated = true;
                        break;
                    }
                    URL url = entries.nextElement();
                    String fqcn = ClassFileInspector.bundlePathToClassName(url.getPath());
                    if (fqcn == null || (!pkgFilter.isEmpty() && !fqcn.startsWith(pkgFilter))) {
                        continue;
                    }
                    scannedClasses++;
                    byte[] bytes = BytecodeReader.readUrl(url);
                    if (bytes == null) {
                        continue;
                    }
                    T hit = matcher.match(fqcn, bytes, bid, bLabel, pKey);
                    if (hit != null) {
                        hits.add(hit);
                        if (hits.size() >= limit) {
                            truncated = true;
                            break;
                        }
                    }
                }
            } catch (RuntimeException | LinkageError ignored) {
                // skip bundle transitioned concurrently
            }
        }
        return new ScanOutcome<>(List.copyOf(hits), scannedClasses, scannedBundles, truncated);
    }
}
