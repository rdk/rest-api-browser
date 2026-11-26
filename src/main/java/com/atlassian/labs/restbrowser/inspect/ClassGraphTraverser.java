package com.atlassian.labs.restbrowser.inspect;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Bounded BFS reference-graph walker across compiled class constant pools.
 * <p>
 * Maintains a per-traversal negative-lookup cache so missing optional classes are resolved at most once per
 * traversal instead of triggering repeated full-classpath/bundle scans, and respects both node count and
 * wall-clock time budgets.
 */
public final class ClassGraphTraverser {

    @FunctionalInterface
    public interface ClassResolver {
        ResolvedClassInfo resolve(String fqcn, List<ClassLoader> hintLoaders);
    }

    public record ResolvedClassInfo(String name, Class<?> loaded, ClassLoader loader,
                                    long bundleId, long bundleModified, byte[] bytes) {
    }

    public record GraphResult(Map<String, ResolvedClassInfo> visited,
                              Map<String, List<String>> adjacency,
                              List<String[]> edges,
                              boolean truncated,
                              Map<String, List<String>> edgeKinds) {
        public GraphResult(Map<String, ResolvedClassInfo> visited,
                           Map<String, List<String>> adjacency,
                           List<String[]> edges,
                           boolean truncated) {
            this(visited, adjacency, edges, truncated, Map.of());
        }
    }

    public static String edgeKey(String from, String to) {
        return from + "->" + to;
    }

    private static final Pattern ANON_INNER = Pattern.compile(".*\\$\\d+.*");

    private ClassGraphTraverser() {
    }

    public static GraphResult traverse(ResolvedClassInfo root,
                                       List<ClassLoader> baseLoaders,
                                       ClassResolver resolver,
                                       int depth,
                                       int maxNodes,
                                       boolean includeJdk,
                                       String packagePrefix,
                                       long timeBudgetMs) {
        return traverse(root, baseLoaders, resolver, depth, maxNodes, includeJdk, false, packagePrefix, timeBudgetMs);
    }

    public static GraphResult traverse(ResolvedClassInfo root,
                                       List<ClassLoader> baseLoaders,
                                       ClassResolver resolver,
                                       int depth,
                                       int maxNodes,
                                       boolean includeJdk,
                                       boolean excludeLibraries,
                                       String packagePrefix,
                                       long timeBudgetMs) {
        return traverse(root, baseLoaders, resolver, depth, maxNodes, includeJdk, excludeLibraries,
                packagePrefix, Set.of(), timeBudgetMs);
    }

    public static GraphResult traverse(ResolvedClassInfo root,
                                       List<ClassLoader> baseLoaders,
                                       ClassResolver resolver,
                                       int depth,
                                       int maxNodes,
                                       boolean includeJdk,
                                       boolean excludeLibraries,
                                       String packagePrefix,
                                       Set<String> allowedEdgeKinds,
                                       long timeBudgetMs) {
        record QueueItem(ResolvedClassInfo resolved, int level) {
        }
        long deadlineNanos = System.nanoTime() + Math.max(100L, timeBudgetMs) * 1_000_000L;
        Map<String, ResolvedClassInfo> visited = new LinkedHashMap<>();
        Map<String, List<String>> adjacency = new LinkedHashMap<>();
        Map<String, List<String>> edgeKinds = new LinkedHashMap<>();
        Set<String> missingCache = new HashSet<>();
        Queue<QueueItem> queue = new ArrayDeque<>();
        visited.put(root.name(), root);
        queue.add(new QueueItem(root, 0));
        boolean truncated = false;
        boolean filterByKind = allowedEdgeKinds != null && !allowedEdgeKinds.isEmpty();

        while (!queue.isEmpty()) {
            if (System.nanoTime() - deadlineNanos > 0) {
                truncated = true;
                break;
            }
            QueueItem cur = queue.poll();
            Map<String, List<String>> typedRefs = ClassFileInspector.collectTypedReferences(
                    cur.resolved().loader(), cur.resolved().name(), cur.resolved().bytes());
            List<String> filtered = new ArrayList<>();
            for (Map.Entry<String, List<String>> entry : typedRefs.entrySet()) {
                String ref = entry.getKey();
                List<String> kinds = entry.getValue();
                if (ref.equals(cur.resolved().name()) || ANON_INNER.matcher(ref).matches()) {
                    continue;
                }
                if ((!includeJdk || excludeLibraries) && isStandardJdk(ref)) {
                    continue;
                }
                if (excludeLibraries && isCommonLibrary(ref)) {
                    continue;
                }
                if (packagePrefix != null && !packagePrefix.isEmpty() && !ref.startsWith(packagePrefix)) {
                    continue;
                }
                if (filterByKind && kinds.stream().noneMatch(allowedEdgeKinds::contains)) {
                    continue;
                }
                filtered.add(ref);
                edgeKinds.put(edgeKey(cur.resolved().name(), ref), kinds);
            }
            adjacency.put(cur.resolved().name(), filtered);
            if (cur.level() >= depth) {
                continue;
            }
            List<ClassLoader> loaders = baseLoaders;
            if (cur.resolved().loader() != null && !baseLoaders.contains(cur.resolved().loader())) {
                List<ClassLoader> withOwn = new ArrayList<>(baseLoaders.size() + 1);
                withOwn.add(cur.resolved().loader());
                withOwn.addAll(baseLoaders);
                loaders = withOwn;
            }
            boolean timedOut = false;
            for (String ref : filtered) {
                if (visited.containsKey(ref) || missingCache.contains(ref)) {
                    continue;
                }
                if (System.nanoTime() - deadlineNanos > 0) {
                    truncated = true;
                    timedOut = true;
                    break;
                }
                if (visited.size() >= maxNodes) {
                    truncated = true;
                    break;
                }
                ResolvedClassInfo next = resolver.resolve(ref, loaders);
                if (next == null) {
                    missingCache.add(ref);
                } else if (!visited.containsKey(next.name())) {
                    visited.put(next.name(), next);
                    queue.add(new QueueItem(next, cur.level() + 1));
                }
            }
            if (timedOut) {
                break;
            }
        }

        Map<String, List<String>> emittedEdgeKinds = new LinkedHashMap<>();
        List<String[]> edges = new ArrayList<>();
        for (Map.Entry<String, ResolvedClassInfo> entry : visited.entrySet()) {
            String from = entry.getKey();
            for (String target : adjacency.getOrDefault(from, List.of())) {
                if (visited.containsKey(target)) {
                    edges.add(new String[]{from, target});
                    String k = edgeKey(from, target);
                    List<String> kinds = edgeKinds.get(k);
                    if (kinds != null) {
                        emittedEdgeKinds.put(k, kinds);
                    }
                }
            }
        }
        return new GraphResult(visited, adjacency, edges, truncated, emittedEdgeKinds);
    }

    public static boolean isStandardJdk(String fqcn) {
        return fqcn.startsWith("java.") || fqcn.startsWith("javax.") || fqcn.startsWith("jakarta.")
                || fqcn.startsWith("jdk.") || fqcn.startsWith("sun.") || fqcn.startsWith("com.sun.")
                || fqcn.startsWith("org.w3c.") || fqcn.startsWith("org.xml.");
    }

    /** Returns true for common framework and utility libraries filtered out when {@code excludeLibraries=true}. */
    public static boolean isCommonLibrary(String fqcn) {
        return fqcn.startsWith("org.slf4j.")
                || fqcn.startsWith("org.apache.logging.")
                || fqcn.startsWith("org.apache.log4j.")
                || fqcn.startsWith("ch.qos.logback.")
                || fqcn.startsWith("com.google.common.")
                || fqcn.startsWith("com.google.gson.")
                || fqcn.startsWith("org.apache.commons.")
                || fqcn.startsWith("org.apache.http.")
                || fqcn.startsWith("com.fasterxml.jackson.")
                || fqcn.startsWith("org.codehaus.jackson.")
                || fqcn.startsWith("org.springframework.")
                || fqcn.startsWith("org.eclipse.gemini.")
                || fqcn.startsWith("org.osgi.")
                || fqcn.startsWith("org.glassfish.jersey.")
                || fqcn.startsWith("io.swagger.")
                || fqcn.startsWith("io.atlassian.fugue.")
                || fqcn.startsWith("com.atlassian.annotations.")
                || fqcn.startsWith("org.junit.")
                || fqcn.startsWith("org.mockito.")
                || fqcn.startsWith("org.hamcrest.");
    }
}
