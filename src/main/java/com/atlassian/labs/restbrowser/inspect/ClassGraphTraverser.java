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
                              boolean truncated) {
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
        record QueueItem(ResolvedClassInfo resolved, int level) {
        }
        long deadlineNanos = System.nanoTime() + Math.max(100L, timeBudgetMs) * 1_000_000L;
        Map<String, ResolvedClassInfo> visited = new LinkedHashMap<>();
        Map<String, List<String>> adjacency = new LinkedHashMap<>();
        Set<String> missingCache = new HashSet<>();
        Queue<QueueItem> queue = new ArrayDeque<>();
        visited.put(root.name(), root);
        queue.add(new QueueItem(root, 0));
        boolean truncated = false;

        while (!queue.isEmpty()) {
            if (System.nanoTime() - deadlineNanos > 0) {
                truncated = true;
                break;
            }
            QueueItem cur = queue.poll();
            List<String> rawRefs = ClassFileInspector.collectReferencedClasses(
                    cur.resolved().loader(), cur.resolved().name(), cur.resolved().bytes());
            List<String> filtered = new ArrayList<>();
            for (String ref : rawRefs) {
                if (ref.equals(cur.resolved().name()) || ANON_INNER.matcher(ref).matches()) {
                    continue;
                }
                if (!includeJdk && isStandardJdk(ref)) {
                    continue;
                }
                if (packagePrefix != null && !packagePrefix.isEmpty() && !ref.startsWith(packagePrefix)) {
                    continue;
                }
                filtered.add(ref);
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

        List<String[]> edges = new ArrayList<>();
        for (Map.Entry<String, ResolvedClassInfo> entry : visited.entrySet()) {
            String from = entry.getKey();
            for (String target : adjacency.getOrDefault(from, List.of())) {
                if (visited.containsKey(target)) {
                    edges.add(new String[]{from, target});
                }
            }
        }
        return new GraphResult(visited, adjacency, edges, truncated);
    }

    public static boolean isStandardJdk(String fqcn) {
        return fqcn.startsWith("java.") || fqcn.startsWith("javax.") || fqcn.startsWith("jakarta.")
                || fqcn.startsWith("jdk.") || fqcn.startsWith("sun.") || fqcn.startsWith("com.sun.")
                || fqcn.startsWith("org.w3c.") || fqcn.startsWith("org.xml.");
    }
}
