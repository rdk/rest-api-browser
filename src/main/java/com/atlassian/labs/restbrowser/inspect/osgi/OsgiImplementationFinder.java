package com.atlassian.labs.restbrowser.inspect.osgi;

import com.atlassian.labs.restbrowser.inspect.BytecodeReader;
import com.atlassian.labs.restbrowser.inspect.ClassFileInspector;
import com.atlassian.labs.restbrowser.inspect.ClassFileInspector.ClassHierarchy;
import org.osgi.framework.Bundle;
import org.osgi.framework.BundleContext;
import org.osgi.framework.Constants;
import org.osgi.framework.FrameworkUtil;
import org.osgi.framework.InvalidSyntaxException;
import org.osgi.framework.ServiceReference;

import java.net.URL;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.Set;
import java.util.function.Function;

/**
 * Finds live OSGi service providers (without dereferencing lazy services) and concrete implementing/extending classes
 * via bytecode hierarchy inspection scoped to wired OSGi bundles. Zero Atlassian coupling.
 */
public final class OsgiImplementationFinder {

    private static final long TIME_BUDGET_MS = 4_000L;
    private static final int MAX_SCANNED_CLASSES = 8_000;

    public record OsgiServiceHit(long serviceId, long bundleId, String bundleLabel, String pluginKey,
                                 String beanName, int ranking, List<String> objectClass) {
    }

    public record ImplHit(String fqcn, String simpleName, String kind, boolean isAbstract, long bundleId,
                          String bundleLabel, String pluginKey, String via) {
    }

    public record ImplementationResult(List<OsgiServiceHit> services, List<ImplHit> implementations,
                                       int scannedBundles, boolean truncated) {
    }

    private OsgiImplementationFinder() {
    }

    /** Fast lookup returning live OSGi service providers without scanning bundle bytecode. */
    public static List<OsgiServiceHit> findServicesOnly(String targetFqcn, Function<Bundle, String> pluginKeyForBundle) {
        if (targetFqcn == null || targetFqcn.isBlank()) {
            return List.of();
        }
        List<OsgiServiceHit> hits = new ArrayList<>();
        try {
            Bundle self = FrameworkUtil.getBundle(OsgiImplementationFinder.class);
            BundleContext ctx = self == null ? null : self.getBundleContext();
            if (ctx != null) {
                collectServiceReferences(ctx, targetFqcn, hits, new LinkedHashSet<>(), pluginKeyForBundle);
            }
        } catch (RuntimeException | LinkageError ignored) {
            // outside OSGi
        }
        return List.copyOf(hits);
    }

    public static ImplementationResult find(String targetFqcn, long targetBundleId, Long bundleIdFilter,
                                            String pluginKeyFilter, boolean includeAbstract, int rawLimit,
                                            Function<Bundle, String> pluginKeyForBundle) {
        int limit = Math.max(1, Math.min(100, rawLimit <= 0 ? 30 : rawLimit));
        List<OsgiServiceHit> serviceHits = new ArrayList<>();
        Set<Bundle> serviceBundles = new LinkedHashSet<>();

        try {
            Bundle self = FrameworkUtil.getBundle(OsgiImplementationFinder.class);
            BundleContext ctx = self == null ? null : self.getBundleContext();
            if (ctx != null) {
                collectServiceReferences(ctx, targetFqcn, serviceHits, serviceBundles, pluginKeyForBundle);
            }
        } catch (RuntimeException | LinkageError ignored) {
            // outside OSGi
        }

        List<Bundle> candidates = chooseCandidateBundles(
                targetFqcn, targetBundleId, bundleIdFilter, pluginKeyFilter, serviceBundles, pluginKeyForBundle);
        if (bundleIdFilter != null && bundleIdFilter >= 0) {
            serviceHits.removeIf(s -> s.bundleId() != bundleIdFilter);
        } else if (pluginKeyFilter != null && !pluginKeyFilter.isBlank()) {
            String p = pluginKeyFilter.trim();
            serviceHits.removeIf(s -> !p.equalsIgnoreCase(s.pluginKey()));
        }

        List<ImplHit> impls = new ArrayList<>();
        Set<String> seenFqcn = new HashSet<>();
        int scannedBundles = 0;
        int scannedClasses = 0;
        boolean truncated = false;
        long deadlineNanos = System.nanoTime() + TIME_BUDGET_MS * 1_000_000L;

        for (Bundle b : candidates) {
            if (System.nanoTime() - deadlineNanos > 0 || impls.size() >= limit || scannedClasses >= MAX_SCANNED_CLASSES) {
                truncated = true;
                break;
            }
            if (!OsgiBundleInspector.isScannableState(b)) {
                continue;
            }
            scannedBundles++;
            Map<String, ClassHierarchy> hierarchies = new LinkedHashMap<>();
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
                    if (fqcn == null) {
                        continue;
                    }
                    scannedClasses++;
                    ClassHierarchy h = ClassFileInspector.readHierarchy(BytecodeReader.readUrl(url));
                    if (h != null) {
                        hierarchies.putIfAbsent(h.name(), h);
                    }
                }
            } catch (RuntimeException | LinkageError ignored) {
                // bundle transitioned mid-scan
            }
            String bLabel = OsgiBundleInspector.bundleLabel(b);
            String pKey = OsgiBundleInspector.pluginKey(b, pluginKeyForBundle);
            for (ImplHit hit : matchHierarchies(targetFqcn, hierarchies, b.getBundleId(), bLabel, pKey,
                    includeAbstract, limit - impls.size())) {
                if (seenFqcn.add(hit.fqcn())) {
                    impls.add(hit);
                    if (impls.size() >= limit) {
                        truncated = true;
                        break;
                    }
                }
            }
        }
        return new ImplementationResult(List.copyOf(serviceHits), List.copyOf(impls), scannedBundles, truncated);
    }

    /**
     * Computes direct and transitive subtypes of {@code targetFqcn} within a pre-parsed map of class hierarchies.
     */
    public static List<ImplHit> matchHierarchies(String targetFqcn, Map<String, ClassHierarchy> hierarchies,
                                                 long bundleId, String bundleLabel, String pluginKey,
                                                 boolean includeAbstract, int limit) {
        if (targetFqcn == null || hierarchies == null || hierarchies.isEmpty() || limit <= 0) {
            return List.of();
        }
        Map<String, List<ClassHierarchy>> reverseEdges = new LinkedHashMap<>();
        for (ClassHierarchy h : hierarchies.values()) {
            if (h.superName() != null) {
                reverseEdges.computeIfAbsent(h.superName(), k -> new ArrayList<>()).add(h);
            }
            for (String iface : h.interfaces()) {
                reverseEdges.computeIfAbsent(iface, k -> new ArrayList<>()).add(h);
            }
        }

        List<ImplHit> hits = new ArrayList<>();
        Set<String> visited = new HashSet<>();
        Queue<String> queue = new ArrayDeque<>();
        visited.add(targetFqcn);
        queue.add(targetFqcn);

        while (!queue.isEmpty() && hits.size() < limit) {
            String cur = queue.poll();
            List<ClassHierarchy> children = reverseEdges.get(cur);
            if (children == null) {
                continue;
            }
            for (ClassHierarchy child : children) {
                if (!visited.add(child.name())) {
                    continue;
                }
                queue.add(child.name());
                if (child.isAnnotation()) {
                    continue;
                }
                boolean isAbs = child.isAbstract() || child.isInterface();
                if (!includeAbstract && isAbs) {
                    continue;
                }
                String via = cur.equals(targetFqcn) ? "direct" : "extends/implements " + cur;
                String kind = child.isInterface() ? "interface" : child.isEnum() ? "enum" : "class";
                hits.add(new ImplHit(child.name(), simpleName(child.name()), kind, isAbs,
                        bundleId, bundleLabel, pluginKey, via));
                if (hits.size() >= limit) {
                    break;
                }
            }
        }
        return hits;
    }

    private static void collectServiceReferences(BundleContext ctx, String targetFqcn,
                                                 List<OsgiServiceHit> out, Set<Bundle> bundles,
                                                 Function<Bundle, String> pluginKeyForBundle) {
        ServiceReference<?>[] refs;
        try {
            refs = ctx.getAllServiceReferences(targetFqcn, null);
        } catch (InvalidSyntaxException e) {
            refs = null;
        }
        if (refs == null) {
            return;
        }
        for (ServiceReference<?> ref : refs) {
            Bundle b = ref.getBundle();
            if (b != null) {
                bundles.add(b);
            }
            long sid = ref.getProperty(Constants.SERVICE_ID) instanceof Number n ? n.longValue() : -1L;
            int rank = ref.getProperty(Constants.SERVICE_RANKING) instanceof Number n ? n.intValue() : 0;
            String beanName = firstStringProp(ref,
                    "org.eclipse.gemini.blueprint.bean.name",
                    "Spring-Context-Bean-Name",
                    "component.name");
            List<String> objCls = ref.getProperty(Constants.OBJECTCLASS) instanceof String[] arr
                    ? List.of(arr) : List.of();
            out.add(new OsgiServiceHit(sid, b == null ? -1L : b.getBundleId(),
                    OsgiBundleInspector.bundleLabel(b), OsgiBundleInspector.pluginKey(b, pluginKeyForBundle),
                    beanName, rank, objCls));
        }
    }

    private static List<Bundle> chooseCandidateBundles(String targetFqcn, long targetBundleId, Long bundleIdFilter,
                                                       String pluginKeyFilter, Set<Bundle> serviceBundles,
                                                       Function<Bundle, String> pluginKeyForBundle) {
        if ((bundleIdFilter != null && bundleIdFilter >= 0) || (pluginKeyFilter != null && !pluginKeyFilter.isBlank())) {
            return OsgiBundleInspector.selectBundles(bundleIdFilter, pluginKeyFilter, pluginKeyForBundle);
        }
        Set<Bundle> chosen = new LinkedHashSet<>(serviceBundles);
        Bundle defining = OsgiClassResolver.bundleByIdOrClass(targetBundleId, null);
        if (defining != null) {
            String pkg = packageOf(targetFqcn);
            chosen.addAll(OsgiBundleInspector.bundlesUsingPackage(defining, pkg));
        }
        return new ArrayList<>(chosen);
    }

    private static String firstStringProp(ServiceReference<?> ref, String... keys) {
        for (String k : keys) {
            Object v = ref.getProperty(k);
            if (v instanceof String s && !s.isBlank()) {
                return s.trim();
            }
        }
        return null;
    }

    private static String packageOf(String fqcn) {
        int dot = fqcn.lastIndexOf('.');
        return dot > 0 ? fqcn.substring(0, dot) : "";
    }

    private static String simpleName(String fqcn) {
        int dot = fqcn.lastIndexOf('.');
        return (dot >= 0 ? fqcn.substring(dot + 1) : fqcn).replace('$', '.');
    }
}
