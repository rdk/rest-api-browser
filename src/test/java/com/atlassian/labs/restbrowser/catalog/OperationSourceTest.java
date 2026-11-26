package com.atlassian.labs.restbrowser.catalog;

import static org.mockito.Mockito.when;

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
    public void scopeClassMethodLineDiffersAcrossSiblingMethodsAndTextBlocksExtract() throws Exception {
        OperationSource source = new OperationSource(mock(ModuleDiscovery.class), () -> null, () -> true);
        Result r1 = source.decompile(null, SampleResource.class.getName(), -1, "class", "vineflower", "greet", null, null, false);
        Result r2 = source.decompile(null, SampleResource.class.getName(), -1, "class", "vineflower", "count", null, null, false);
        assertEquals(200, r1.status());
        assertEquals(200, r2.status());
        int line1 = ((Number) ((Map<String, Object>) parseJson(r1.json())).get("methodLine")).intValue();
        int line2 = ((Number) ((Map<String, Object>) parseJson(r2.json())).get("methodLine")).intValue();
        assertTrue("methodLine must reflect each queried method independently: " + line1 + " vs " + line2,
                line1 > 0 && line2 > line1);

        // Multiline annotation + text block containing braces/semicolons
        String withBlock = """
                package com.example;
                public class TB {
                    @Operation(
                        summary = "x",
                        description = "y"
                    )
                    public String textBlockMethod() {
                        String q = \"\"\"
                            { not a method end; }
                        \"\"\";
                        return q;
                    }
                    public int after() { return 1; }
                }
                """;
        String extracted = OperationSource.extractMethod(withBlock, "textBlockMethod");
        assertTrue(extracted.contains("@Operation("));
        assertTrue(extracted.contains("return q;"));
        assertFalse(extracted.contains("after()"));

        // LineSlicer int overflow guard
        var sliced = com.atlassian.labs.restbrowser.decompile.LineSlicer.slice("a\nb\nc", 3, 2, Integer.MAX_VALUE);
        assertEquals(3, sliced.endLine());
        assertEquals("b\nc", sliced.text());
    }

    /** Carries a fake descriptor-like String constant and a parameterized generic signature. */
    public static class PoolSample {
        public static final String FAKE_STRING = "Lcom/fake/NotReferencedClass;";
        public List<Greeting> greetings() {
            return List.of();
        }
    }

    @Test
    public void constantPoolIgnoresStringLiteralsAndExtractsGenericSignatures() throws Exception {
        byte[] bytes;
        try (var in = PoolSample.class.getClassLoader()
                .getResourceAsStream(PoolSample.class.getName().replace('.', '/') + ".class")) {
            bytes = in.readAllBytes();
        }
        var refs = OperationSource.constantPoolClasses(bytes);
        assertFalse("Must ignore CONSTANT_String literals: " + refs, refs.contains("com.fake.NotReferencedClass"));
        assertTrue("Must extract generic Signature classes: " + refs, refs.contains(Greeting.class.getName()));
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

        // default engine is Vineflower; explicit "cfr" selects CFR
        assertEquals(Engine.VINEFLOWER, Engine.parse(null));
        assertEquals(Engine.VINEFLOWER, Engine.parse(""));
        assertEquals(Engine.VINEFLOWER, Engine.parse("vineflower"));
        assertEquals(Engine.CFR, Engine.parse("cfr"));
        Result def = source.decompile(null, Greeting.class.getName(), -1, "class", null);
        assertEquals(200, def.status());
        assertEquals("vineflower", ((Map<String, Object>) parseJson(def.json())).get("decompilerId"));

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
        assertEquals(403, source.inspectPlugin("com.example").status());
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

        // graph with includeSources + narrow packagePrefix must NOT poison global decompile/inspect refs
        Result narrowGraph = source.traverseGraph(null, SampleResource.class.getName(), -1, 1, 10, false,
                "com.nonexistent.prefix", true, "vineflower");
        assertEquals(200, narrowGraph.status());
        Result fullAfter = source.decompile(null, SampleResource.class.getName(), -1, "class", "vineflower");
        assertEquals(200, fullAfter.status());
        List<String> postRefs = (List<String>) ((Map<String, Object>) parseJson(fullAfter.json())).get("refs");
        assertTrue("Full refs must remain intact after filtered graph: " + postRefs,
                postRefs.contains(Greeting.class.getName()));

        // opKey hint that throws/is missing must NOT break explicit class decompilation
        Result hinted = source.decompile("no.such:module:GET:missing", Greeting.class.getName(), -1, "class", "cfr");
        assertEquals(200, hinted.status());

        // search exact class fallback
        Result search = source.searchClasses(Greeting.class.getName(), 10, null);
        assertEquals(200, search.status());
        Map<String, Object> srBody = (Map<String, Object>) parseJson(search.json());
        assertEquals(1L, srBody.get("count"));

        // Wave 1 & 2: inspectClass includes fields & enumConstants; compact omits refs/annotations; lineNumbers works
        Result dtoInfo = source.inspectClass(null, Greeting.class.getName(), -1, false);
        assertEquals(200, dtoInfo.status());
        Map<String, Object> dtoMap = (Map<String, Object>) parseJson(dtoInfo.json());
        assertTrue(dtoMap.get("fields") instanceof List);
        assertFalse(((List<?>) dtoMap.get("fields")).isEmpty());

        Result enumInfo = source.inspectClass(null, SampleEnum.class.getName(), -1, true);
        assertEquals(200, enumInfo.status());
        Map<String, Object> enumMap = (Map<String, Object>) parseJson(enumInfo.json());
        assertEquals(List.of("ALPHA", "BETA"), enumMap.get("enumConstants"));
        assertFalse(enumMap.containsKey("refs"));
        assertFalse(enumMap.containsKey("annotations"));

        Result numbered = source.decompile(null, SampleResource.class.getName(), -1, "class", "cfr", null, 1, 5, false, true);
        assertEquals(200, numbered.status());
        Map<String, Object> numMap = (Map<String, Object>) parseJson(numbered.json());
        assertEquals(Boolean.TRUE, numMap.get("lineNumbers"));
        assertTrue(String.valueOf(numMap.get("source")).startsWith("1 | "));

        Result schema = source.inspectSchema(null, Greeting.class.getName(), -1, 3, true);
        assertEquals(200, schema.status());
        Map<String, Object> schemaMap = (Map<String, Object>) parseJson(schema.json());
        assertTrue(schemaMap.get("schema") instanceof Map);
        assertTrue(schemaMap.get("example") instanceof Map);

        // class-not-found provides an actionable hint referencing the simple class name
        Result notFound = source.inspectClass(null, "com.wrong.pkg.Greeting", -1);
        assertEquals(404, notFound.status());
        Map<String, Object> nfMap = (Map<String, Object>) parseJson(notFound.json());
        assertEquals("class-not-found", nfMap.get("error"));
        assertTrue(String.valueOf(nfMap.get("hint")).contains("Greeting"));

        // Wave 3: unknown-operation suggestions, not-started probe hint, outline, and rankSimilarKeys
        assertEquals(
                List.of("m:POST:issue/{id}/comment", "m:GET:issue/{id}", "m:GET:project"),
                OperationSource.rankSimilarKeys("m:POST:issue/comment",
                        List.of("m:GET:project", "m:GET:issue/{id}", "m:POST:issue/{id}/comment"), 3));

        Result outlined = source.inspectClass(null, SampleResource.class.getName(), -1, true, true, false);
        assertEquals(200, outlined.status());
        Map<String, Object> outlineMap = (Map<String, Object>) parseJson(outlined.json());
        assertTrue(outlineMap.get("outline") instanceof List && !((List<?>) outlineMap.get("outline")).isEmpty());
    }

    @Test
    @SuppressWarnings("unchecked")
    public void notStartedHintUnknownOperationSuggestionsAndContextWorkWithMockJersey() throws Exception {
        ModuleDiscovery discovery = mock(ModuleDiscovery.class);
        JerseyModelSource jersey = mock(JerseyModelSource.class);
        ModuleDiscovery.RestModule mod = new ModuleDiscovery.RestModule(
                "p:mod", "demo/1", "/demo", "1", true,
                "p", "Plugin P", "1.0", "Demo module",
                mock(com.atlassian.plugin.Plugin.class), null);
        when(discovery.discover()).thenReturn(List.of(mod));

        OperationSource source = new OperationSource(discovery, () -> jersey, () -> true);

        // not-started SpecException includes probe hint
        when(jersey.handler(mod, "p:mod:GET:x")).thenThrow(new SpecSource.SpecException("not-started", "cold", null));
        Result notStarted = source.decompile("p:mod:GET:x", null, -1, "method", "vineflower");
        assertEquals(503, notStarted.status());
        Map<String, Object> nsMap = (Map<String, Object>) parseJson(notStarted.json());
        assertEquals("not-started", nsMap.get("error"));
        assertTrue(String.valueOf(nsMap.get("hint")).contains("/rest/demo/1"));

        // unknown-operation returns fuzzy suggestions from module keys
        when(jersey.handler(mod, "p:mod:GET:greetings")).thenReturn(java.util.Optional.empty());
        when(jersey.operationKeys(mod)).thenReturn(List.of("p:mod:GET:greet", "p:mod:POST:other"));
        Result unknownOp = source.decompile("p:mod:GET:greetings", null, -1, "method", "vineflower");
        assertEquals(404, unknownOp.status());
        Map<String, Object> uoMap = (Map<String, Object>) parseJson(unknownOp.json());
        assertEquals("unknown-operation", uoMap.get("error"));
        assertTrue(((List<?>) uoMap.get("suggestions")).contains("p:mod:GET:greet"));

        // investigationContext + moduleOperationSchemas
        java.lang.reflect.Method greetMethod = SampleResource.class.getDeclaredMethod("greet", String.class);
        JerseyModelSource.Handler handler = new JerseyModelSource.Handler(
                greetMethod, greetMethod, SampleResource.class, List.of());
        when(jersey.handler(mod, "p:mod:GET:greet")).thenReturn(java.util.Optional.of(handler));
        when(jersey.handlers(mod)).thenReturn(Map.of("p:mod:GET:greet", handler));

        Model.ModuleEntry entry = CatalogTestSupport.module("p:mod", "demo/1", Model.State.ok, "1.0");
        Model.Operation opModel = new Model.Operation("p:mod:GET:greet", "p:mod",
                CatalogTestSupport.spec("GET", "greet"));
        CatalogSnapshot snap = CatalogTestSupport.snapshot(List.of(entry), List.of(opModel), true, "4.3.3-SNAPSHOT");

        OperationDetails details = new OperationDetails(discovery, () -> jersey,
                new ProductAdapter(mock(com.atlassian.sal.api.ApplicationProperties.class), () -> null));
        Result ctx = source.investigationContext(snap, null, "/rest/demo/1/greet", "GET",
                120, 2, true, true, true, true, "cfr", details);
        assertEquals(200, ctx.status());
        Map<String, Object> ctxMap = (Map<String, Object>) parseJson(ctx.json());
        assertEquals("p:mod:GET:greet", ctxMap.get("key"));
        assertTrue(ctxMap.get("responseBody") instanceof Map);
        assertTrue(ctxMap.get("source") instanceof Map);
        assertTrue(ctxMap.get("dependencies") instanceof List);

        Map<String, OperationSource.OperationSchemas> modSchemas = source.moduleOperationSchemas("p:mod", 2, 10);
        assertTrue(modSchemas.containsKey("p:mod:GET:greet"));
    }

    public enum SampleEnum {
        ALPHA, BETA
    }
}
