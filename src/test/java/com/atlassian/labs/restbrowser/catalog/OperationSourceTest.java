package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.OperationDetails.Result;
import com.atlassian.labs.restbrowser.catalog.OperationSource.Engine;
import org.junit.Test;

import java.lang.reflect.Method;
import java.util.List;
import java.util.Map;

import static com.atlassian.labs.restbrowser.catalog.CatalogTestSupport.parseJson;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;

public class OperationSourceTest {

    public static class Greeting {
        private final String message;

        public Greeting(String message) {
            this.message = message;
        }

        public String message() {
            return message;
        }
    }

    public static class SampleResource {
        public Greeting greet(String who) {
            if (who == null || who.isBlank()) {
                return new Greeting("hello");
            }
            return new Greeting("hello, " + who);
        }

        public int count() {
            return 42;
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    public void decompilesMethodAndClassWithBothEnginesAndCollectsRefs() throws Exception {
        OperationSource source = new OperationSource(mock(ModuleDiscovery.class), () -> null, () -> true);
        Method m = SampleResource.class.getMethod("greet", String.class);

        for (Engine engine : Engine.values()) {
            Result methodRes = source.decompileMethod("p:m:GET:greet", m, engine);
            assertEquals(engine.name(), 200, methodRes.status());
            Map<String, Object> body = (Map<String, Object>) parseJson(methodRes.json());
            assertEquals(1L, body.get("format"));
            assertEquals("method", body.get("scope"));
            assertEquals(engine.id, body.get("decompilerId"));
            assertEquals(engine.label, body.get("decompiler"));
            assertEquals("greet", body.get("method"));
            String code = (String) body.get("source");
            assertTrue(engine + ": " + code, code.contains("greet"));
            assertTrue(engine + ": " + code, code.contains("hello, "));
            List<String> refs = (List<String>) body.get("refs");
            assertTrue(engine + " refs: " + refs, refs.contains(Greeting.class.getName()));

            // whole class
            Result classRes = source.decompileClass("p:m:GET:greet", SampleResource.class, engine);
            assertEquals(engine.name(), 200, classRes.status());
            Map<String, Object> classBody = (Map<String, Object>) parseJson(classRes.json());
            assertEquals("class", classBody.get("scope"));
            String classCode = (String) classBody.get("source");
            assertTrue(engine + ": " + classCode, classCode.contains("SampleResource"));
            assertTrue(engine + ": " + classCode, classCode.contains("count"));
        }

        // cached hit returns identical JSON
        assertEquals(
                source.decompileMethod("p:m:GET:greet", m, Engine.CFR).json(),
                source.decompileMethod("p:m:GET:greet", m, Engine.CFR).json());
    }

    @Test
    @SuppressWarnings("unchecked")
    public void decompilesReferencedClassByNameAndRejectsUnsafeNames() {
        OperationSource source = new OperationSource(mock(ModuleDiscovery.class), () -> null, () -> true);
        Result ok = source.decompile(null, Greeting.class.getName(), -1, "class", "vineflower");
        assertEquals(200, ok.status());
        Map<String, Object> body = (Map<String, Object>) parseJson(ok.json());
        assertEquals(Greeting.class.getName(), body.get("class"));
        assertEquals("vineflower", body.get("decompilerId"));
        assertTrue(((String) body.get("source")).contains("Greeting"));

        // nested dot syntax resolves to $ inner class
        String dotted = Greeting.class.getName().replace('$', '.');
        assertEquals(200, source.decompile(null, dotted, -1, "class", "cfr").status());

        // invalid / path traversal rejected
        assertEquals(400, source.decompile(null, "../etc/passwd", -1, "class", "cfr").status());
        assertEquals(404, source.decompile(null, "com.example.NoSuchClassHere", -1, "class", "cfr").status());
    }

    @Test
    public void returns403WhenDisabled() {
        OperationSource source = new OperationSource(mock(ModuleDiscovery.class), () -> null, () -> false);
        Result r = source.decompile("p:m:GET:greet");
        assertEquals(403, r.status());
        assertTrue(r.json().contains("decompile-disabled"));
    }

    @Test
    public void cleanSourceStripsBannerAndCapsLength() {
        assertEquals("int x = 1;", OperationSource.cleanSource("/*\n * Decompiled with CFR 0.152.\n */\nint x = 1;\n"));
        String huge = "a".repeat(OperationSource.MAX_SOURCE + 50);
        String capped = OperationSource.cleanSource(huge);
        assertTrue(capped.endsWith("…"));
        assertEquals(OperationSource.MAX_SOURCE + 1, capped.length());
    }

    @Test
    public void extractMethodIsolatesAnnotatedMethodBody() {
        String cls = """
                package com.example;

                public class Foo {
                    @Deprecated
                    public String bar(int x) {
                        if (x > 0) {
                            return "ok";
                        }
                        return "no";
                    }

                    public int other() {
                        return 1;
                    }
                }
                """;
        String m = OperationSource.extractMethod(cls, "bar");
        assertTrue(m.contains("@Deprecated"));
        assertTrue(m.contains("return \"ok\""));
        assertFalse(m.contains("other"));
        assertEquals(5, OperationSource.findMethodLine(cls, "bar"));
        assertEquals(12, OperationSource.findMethodLine(cls, "other"));
        assertEquals(0, OperationSource.findMethodLine(cls, "missing"));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void inspectsClassTraversesGraphSlicesLinesAndBatches() {
        OperationSource source = new OperationSource(mock(ModuleDiscovery.class), () -> null, () -> true);

        // inspectClass
        Result inspected = source.inspectClass(null, SampleResource.class.getName(), -1);
        assertEquals(200, inspected.status());
        Map<String, Object> info = (Map<String, Object>) parseJson(inspected.json());
        assertEquals(SampleResource.class.getName(), info.get("name"));
        assertEquals("class", info.get("kind"));
        assertTrue(((Number) info.get("methodCount")).intValue() >= 2);
        assertTrue(((Number) info.get("bytecodeBytes")).intValue() > 0);
        assertTrue(((String) info.get("bytecodeVersion")).contains("Java"));
        List<String> refs = (List<String>) info.get("refs");
        assertTrue(refs.contains(Greeting.class.getName()));

        // line slicing + methodLine + includeMeta
        Result sliced = source.decompile(null, SampleResource.class.getName(), -1, "class", "cfr", "greet", 1, 5, true);
        assertEquals(200, sliced.status());
        Map<String, Object> sBody = (Map<String, Object>) parseJson(sliced.json());
        assertEquals(1L, sBody.get("startLine"));
        assertTrue(((Number) sBody.get("endLine")).intValue() <= 5);
        assertTrue(((Number) sBody.get("methodLine")).intValue() > 0);
        assertTrue(sBody.get("meta") instanceof Map);

        // graph traversal across class references
        Result graph = source.traverseGraph(null, SampleResource.class.getName(), -1, 1, 10, false,
                "com.atlassian.labs.restbrowser.catalog", false, "cfr");
        assertEquals(200, graph.status());
        Map<String, Object> gBody = (Map<String, Object>) parseJson(graph.json());
        assertEquals(SampleResource.class.getName(), gBody.get("root"));
        List<Map<String, Object>> nodes = (List<Map<String, Object>>) gBody.get("nodes");
        assertTrue(nodes.stream().anyMatch(n -> Greeting.class.getName().equals(n.get("class"))));

        // batch
        Result batch = source.batch(List.of(SampleResource.class.getName(), Greeting.class.getName()), -1, null, "cfr",
                true, false, 10);
        assertEquals(200, batch.status());
        Map<String, Object> bBody = (Map<String, Object>) parseJson(batch.json());
        assertEquals(2L, bBody.get("count"));

        // search exact class fallback
        Result search = source.searchClasses(Greeting.class.getName(), 10, null);
        assertEquals(200, search.status());
        Map<String, Object> srBody = (Map<String, Object>) parseJson(search.json());
        assertEquals(1L, srBody.get("count"));
    }
}
