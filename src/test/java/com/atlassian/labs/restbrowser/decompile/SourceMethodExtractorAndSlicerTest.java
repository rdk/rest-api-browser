package com.atlassian.labs.restbrowser.decompile;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class SourceMethodExtractorAndSlicerTest {

    @Test
    public void bareCallDoesNotHijackAndInlineAnnotationAttributesAreExtracted() {
        String src = """
                package com.example;

                public class DemoResource {
                    public void caller(String id) {
                        get(id);
                    }

                    @Operation(
                        summary = "1) First sentence with ) paren",
                        description = "Second :) line"
                    )
                    @SuppressWarnings({"unchecked"})
                    public Response get(@Parameter(description = "id") String id, @Ann({"a", "b"}) AuditRecord record, @Schema(implementation = Foo.class) String ref) {
                        return Response.ok(id).build();
                    }

                    public int trailing() {
                        return 7;
                    }
                }
                """;

        int line = SourceMethodExtractor.findMethodLine(src, "get", 3);
        assertEquals(13, line);

        String extracted = SourceMethodExtractor.extractMethod(src, "get", 3);
        assertTrue("Extracted method must start at @Operation, got:\n" + extracted,
                extracted.contains("@Operation("));
        assertTrue("Must contain full method body:\n" + extracted,
                extracted.contains("return Response.ok(id).build();"));
        assertFalse("Must not prepend earlier caller() method:\n" + extracted,
                extracted.contains("caller("));
        assertFalse("Must not leak following method:\n" + extracted,
                extracted.contains("trailing()"));
    }

    @Test
    public void extractsConstructorsAndRespectsClassDeclarationsNamedLikeMethod() {
        String src = """
                package com.example;

                public record Thing(int x) {
                    public Thing(int x) {
                        this.x = x;
                    }
                }
                """;
        // Should locate constructor line 4, not record declaration line 3
        assertEquals(4, SourceMethodExtractor.findMethodLine(src, "Thing", 1));
        String ctor = SourceMethodExtractor.extractMethod(src, "Thing", 1);
        assertTrue(ctor.contains("this.x = x;"));
        assertFalse(ctor.contains("public record Thing"));
    }

    @Test
    public void multiLineCapitalizedHelperCallDoesNotFalseMatchPackagePrivateConstructor() {
        String src = """
                package com.example;

                public class Helper {
                    public void run() {
                        Helper(
                            "arg1",
                            "arg2"
                        );
                    }

                    Helper(String a, String b) {
                        System.out.println(a + b);
                    }

                    private static void Helper(String a, String b) {}
                }
                """;
        // Must skip the multi-line call Helper(\n "arg1",\n "arg2"\n); ending in ';' and match line 11
        assertEquals(11, SourceMethodExtractor.findMethodLine(src, "Helper", 2));
        String ctor = SourceMethodExtractor.extractMethod(src, "Helper", 2);
        assertTrue(ctor.contains("System.out.println(a + b);"));
        assertFalse(ctor.contains("\"arg1\""));
    }

    @Test
    public void ternariesAndWrappedCallArgumentsDoNotFalseMatchMethodDeclarations() {
        String src = """
                package com.example;

                public class ExprResource {
                    public String caller(boolean cond, String a, String x) {
                        String v =
                            cond ? get(x) : "fallback";
                        return combine(
                            a, get(x));
                    }

                    public Response get(String id) {
                        return Response.ok(id).build();
                    }
                }
                """;
        assertEquals(11, SourceMethodExtractor.findMethodLine(src, "get", 1));
        String extracted = SourceMethodExtractor.extractMethod(src, "get", 1);
        assertTrue(extracted.contains("return Response.ok(id).build();"));
        assertFalse(extracted.contains("cond ?"));
        assertFalse(extracted.contains("a, get(x)"));
    }

    @Test
    public void lineSlicerClampsBoundsAndCountsTrailingLines() {
        LineSlicer.Slice s = LineSlicer.slice("a\nb\nc\nd", 4, 2, 2);
        assertEquals("b\nc", s.text());
        assertEquals(2, s.startLine());
        assertEquals(3, s.endLine());
        assertTrue(s.truncated());

        LineSlicer.Slice tail = LineSlicer.slice("a\nb", 2, 99, 5);
        assertEquals("b", tail.text());
        assertEquals(2, tail.startLine());
        assertEquals(2, tail.endLine());
    }
}
