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
    }
}
