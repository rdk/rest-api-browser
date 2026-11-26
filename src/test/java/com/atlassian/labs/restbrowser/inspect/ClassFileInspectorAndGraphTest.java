package com.atlassian.labs.restbrowser.inspect;

import com.atlassian.labs.restbrowser.inspect.ClassGraphTraverser.GraphResult;
import com.atlassian.labs.restbrowser.inspect.ClassGraphTraverser.ResolvedClassInfo;
import org.junit.Test;

import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClassFileInspectorAndGraphTest {

    public static class Alpha {
        public Beta b;
        public ZGamma g;
    }

    public static class Beta {
        public Alpha backToAlpha;
    }

    public static class ZGamma {
    }

    public static class OuterSample {
        public static class InnerSample {
            public String ping() {
                return "ok";
            }
        }
    }

    private static byte[] readBytes(Class<?> c) throws Exception {
        try (var in = c.getClassLoader().getResourceAsStream(c.getName().replace('.', '/') + ".class")) {
            return in.readAllBytes();
        }
    }

    @Test
    public void truncatedGraphAtMaxNodesStillRecordsBackEdgesAmongVisitedNodes() throws Exception {
        ResolvedClassInfo alpha = new ResolvedClassInfo(
                Alpha.class.getName(), Alpha.class, Alpha.class.getClassLoader(), -1L, 0L, readBytes(Alpha.class));
        ResolvedClassInfo beta = new ResolvedClassInfo(
                Beta.class.getName(), Beta.class, Beta.class.getClassLoader(), -1L, 0L, readBytes(Beta.class));
        byte[] gammaBytes = readBytes(ZGamma.class);

        // With maxNodes=3, Alpha adds enclosing ClassFileInspectorAndGraphTest (#2) and Beta (#3),
        // then hits maxNodes=3 on ZGamma. Queued Beta must STILL be polled for its Alpha back-edge.
        GraphResult graph = ClassGraphTraverser.traverse(
                alpha,
                List.of(),
                (fqcn, hints) -> Beta.class.getName().equals(fqcn)
                        ? beta
                        : new ResolvedClassInfo(fqcn, ZGamma.class, ZGamma.class.getClassLoader(), -1L, 0L, gammaBytes),
                2,
                3,
                false,
                "",
                5_000L);

        assertTrue(graph.truncated());
        assertEquals(3, graph.visited().size());
        assertTrue("Beta adjacency must still be recorded when maxNodes is hit: " + graph.adjacency(),
                graph.adjacency().get(Beta.class.getName()).contains(Alpha.class.getName()));
        assertTrue("Beta -> Alpha back-edge must still be present",
                graph.edges().stream().anyMatch(e -> e[0].equals(Beta.class.getName()) && e[1].equals(Alpha.class.getName())));
    }

    @Test
    public void collectsNestedClassBytesAndReferencedClasses() throws Exception {
        byte[] outerBytes = readBytes(OuterSample.class);
        Map<String, byte[]> nested = ClassFileInspector.collectNestedClassBytes(
                OuterSample.class.getClassLoader(), OuterSample.class.getName(), outerBytes);
        String innerInternal = OuterSample.InnerSample.class.getName().replace('.', '/');
        assertTrue(nested.containsKey(innerInternal));
        assertFalse(ClassFileInspector.readBytecodeVersion(outerBytes).label().isEmpty());
    }

    public static class WithAnonymousInner {
        public Runnable make() {
            return new Runnable() {
                @Override
                public void run() {
                    new Beta();
                }
            };
        }
    }

    @Test
    public void traverseSkipsSyntheticAnonymousInnerClasses() throws Exception {
        byte[] gammaBytes = readBytes(ZGamma.class);
        ResolvedClassInfo root = new ResolvedClassInfo(
                WithAnonymousInner.class.getName(),
                WithAnonymousInner.class,
                WithAnonymousInner.class.getClassLoader(),
                -1L,
                0L,
                readBytes(WithAnonymousInner.class));
        GraphResult graph = ClassGraphTraverser.traverse(
                root,
                List.of(),
                (fqcn, hints) -> new ResolvedClassInfo(fqcn, ZGamma.class, ZGamma.class.getClassLoader(), -1L, 0L, gammaBytes),
                2,
                10,
                false,
                "",
                5_000L);
        assertTrue(graph.visited().keySet().stream().noneMatch(n -> n.matches(".*\\$\\d+.*")));
    }
}
