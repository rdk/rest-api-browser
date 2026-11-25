package com.atlassian.labs.restbrowser.catalog;

import static org.junit.Assert.assertNull;
import com.atlassian.annotations.security.XsrfProtectionExcluded;
import com.atlassian.annotations.security.LicensedOnly;
import com.atlassian.annotations.security.AdminOnly;
import com.atlassian.labs.restbrowser.catalog.Model.Param;
import java.util.List;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.plugin.ModuleDescriptor;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;

public class JerseyModelSourceTest {

    @Test
    public void joinStripsAndJoinsSlashes() {
        assertEquals("api/issue", JerseyModelSource.join("api", "issue"));
        assertEquals("api/issue", JerseyModelSource.join("/api/", "/issue/"));
        assertEquals("api/issue/{id}", JerseyModelSource.join("//api//", "///issue/{id}//"));
    }

    @Test
    public void joinHandlesNullsAndEmpty() {
        assertEquals("", JerseyModelSource.join(null, null));
        assertEquals("", JerseyModelSource.join("", ""));
        assertEquals("", JerseyModelSource.join("/", "/"));
        assertEquals("b", JerseyModelSource.join(null, "/b"));
        assertEquals("a", JerseyModelSource.join("a", null));
        assertEquals("a", JerseyModelSource.join("a", ""));
        assertEquals("b", JerseyModelSource.join("", "b"));
    }

    @Test
    public void typeNames() {
        assertEquals("string", JerseyModelSource.typeName(null));
        assertEquals("string", JerseyModelSource.typeName(String.class));
        assertEquals("string", JerseyModelSource.typeName(Thread.State.class));
        assertEquals("string", JerseyModelSource.typeName(char.class));
        assertEquals("string", JerseyModelSource.typeName(Character.class));
        assertEquals("int", JerseyModelSource.typeName(int.class));
        assertEquals("int", JerseyModelSource.typeName(Integer.class));
        assertEquals("int", JerseyModelSource.typeName(short.class));
        assertEquals("long", JerseyModelSource.typeName(Long.class));
        assertEquals("long", JerseyModelSource.typeName(long.class));
        assertEquals("boolean", JerseyModelSource.typeName(boolean.class));
        assertEquals("boolean", JerseyModelSource.typeName(Boolean.class));
        assertEquals("number", JerseyModelSource.typeName(double.class));
        assertEquals("number", JerseyModelSource.typeName(Float.class));
        assertEquals("UUID", JerseyModelSource.typeName(java.util.UUID.class));
    }

    @Test
    public void describeIsEmptyForRestV1() throws Exception {
        RestModule v1 = new RestModule("p:m", "api/1", "/api", "1", false, "p", "P", "1", null, null,
                mock(ModuleDescriptor.class));
        JerseyModelSource source = new JerseyModelSource(() -> null, () -> null);
        assertFalse(source.describe(v1).isPresent());
        assertEquals("jersey", source.id());
    }

    /** Jersey's ServletContainer: getApplicationHandler throws until the application runs. */
    public static class FakeContainer {
        private final Object handler;

        FakeContainer(Object handler) {
            this.handler = handler;
        }

        public Object getApplicationHandler() {
            if (handler == null) {
                throw new IllegalStateException("not initialized");
            }
            return handler;
        }
    }

    /** The REST module's filter, which holds the container. */
    public static class FakeFilter {
        @SuppressWarnings("unused")
        private final Object servletContainer;

        FakeFilter(Object servletContainer) {
            this.servletContainer = servletContainer;
        }
    }

    private static RestModule restV2(Object filter) {
        ModuleDescriptor<?> descriptor = mock(ModuleDescriptor.class);
        org.mockito.Mockito.doReturn(filter).when(descriptor).getModule();
        return new RestModule("p:m", "api/1", "/api", "1", true, "p", "P", "1", null, null, descriptor);
    }

    @Test
    public void startedTellsWhetherTheModulesApplicationRunsNow() {
        JerseyModelSource source = new JerseyModelSource(() -> null, () -> null);
        assertTrue(source.started(restV2(new FakeFilter(new FakeContainer("handler")))));
        assertFalse(source.started(restV2(new FakeFilter(new FakeContainer(null))))); // not started yet
        assertFalse(source.started(restV2(new Object()))); // no container: cannot be told
        assertFalse(source.started(new RestModule("p:v1", "api/1", "/api", "1", false, "p", "P", "1", null, null,
                mock(ModuleDescriptor.class))));
    }

    @Test
    public void templateNamesIncludeRegexTemplates() {
        assertEquals(List.of("x", "y"), JerseyModelSource.templateNames("a/{x}/b/{y: [0-9]{2}}"));
        assertEquals(List.of(), JerseyModelSource.templateNames("a/b"));
        assertEquals(List.of(), JerseyModelSource.templateNames(""));
    }

    private static Param param(String name, String in, String type, boolean required) {
        return new Param(name, in, type, required, null, List.of(), false);
    }

    @Test
    public void completePathParamsAddsMissingKeepsDeclaredAndDropsDuplicates() {
        Param declared = param("id", "path", "int", true);
        Param query = param("id", "query", "string", false);
        List<Param> out = JerseyModelSource.completePathParams("a/{id}/b/{name}",
                List.of(declared, declared, query));
        assertEquals(List.of(declared, query, param("name", "path", "string", true)), out);
    }

    public static class Methods {
        @AdminOnly
        public void annotated() {
        }

        public void plain() {
        }

        @XsrfProtectionExcluded
        public void other() {
        }
    }

    @LicensedOnly
    public static class Licensed {
        @AdminOnly
        public void annotated() {
        }

        public void plain() {
        }

        @XsrfProtectionExcluded
        public void other() {
        }
    }

    @Test
    public void accessFromTheMethodWinsOverTheClass() throws Exception {
        assertEquals("AdminOnly", JerseyModelSource.access(Licensed.class.getMethod("annotated")));
    }

    @Test
    public void accessFallsBackToTheClass() throws Exception {
        assertEquals("LicensedOnly", JerseyModelSource.access(Licensed.class.getMethod("plain")));
        assertEquals("LicensedOnly", JerseyModelSource.access(Licensed.class.getMethod("other")));
    }

    @Test
    public void accessIsNullForOtherAnnotationsAndNoAnnotation() throws Exception {
        assertEquals("AdminOnly", JerseyModelSource.access(Methods.class.getMethod("annotated")));
        assertNull(JerseyModelSource.access(Methods.class.getMethod("plain")));
        assertNull(JerseyModelSource.access(Methods.class.getMethod("other")));
    }

    public static class Documented {
        @io.swagger.v3.oas.annotations.Operation(
                summary = "  Get server info  ",
                description = "Returns general information\r\nabout the server.",
                deprecated = true
        )
        @io.swagger.v3.oas.annotations.Parameter(name = "id", in = io.swagger.v3.oas.annotations.enums.ParameterIn.PATH,
                description = "  The issue key  ")
        @io.swagger.v3.oas.annotations.Parameter(name = "expand", in = io.swagger.v3.oas.annotations.enums.ParameterIn.QUERY,
                description = "Fields to expand")
        public void oasV3(
                @io.swagger.v3.oas.annotations.Parameter(description = "Inline wins") String inlineParam) {
        }

        @io.swagger.v3.oas.annotations.Operation(
                summary = "Same text",
                description = "Same text",
                parameters = {
                        @io.swagger.v3.oas.annotations.Parameter(name = "limit", description = "Max items")
                }
        )
        public void sameSummaryAndDescription() {
        }

        @io.swagger.annotations.ApiOperation(value = "Legacy summary", notes = "Legacy notes")
        public void swaggerV2(@io.swagger.annotations.ApiParam("Legacy param doc") String q) {
        }

        public void upload(@com.atlassian.plugins.rest.api.multipart.MultipartFormParam("file")
                           com.atlassian.plugins.rest.api.multipart.FilePart part) {
        }
    }

    @Test
    public void opDocReadsOpenApiV3AndSwaggerV2() throws Exception {
        JerseyModelSource.OpDoc v3 = JerseyModelSource.opDoc(Documented.class.getMethod("oasV3", String.class), null);
        assertEquals("Get server info", v3.summary());
        assertEquals("Returns general information\nabout the server.", v3.description());
        assertTrue(v3.deprecated());

        JerseyModelSource.OpDoc dup = JerseyModelSource.opDoc(Documented.class.getMethod("sameSummaryAndDescription"), null);
        assertEquals("Same text", dup.summary());
        assertNull(dup.description());
        assertFalse(dup.deprecated());

        JerseyModelSource.OpDoc v2 = JerseyModelSource.opDoc(Documented.class.getMethod("swaggerV2", String.class), null);
        assertEquals("Legacy summary", v2.summary());
        assertEquals("Legacy notes", v2.description());
        assertFalse(v2.deprecated());

        JerseyModelSource.OpDoc none = JerseyModelSource.opDoc(Methods.class.getMethod("plain"), null);
        assertNull(none.summary());
        assertNull(none.description());
        assertFalse(none.deprecated());
    }

    @Test
    public void paramDocsMatchByLocationAndFallbackToName() throws Exception {
        java.lang.reflect.Method m = Documented.class.getMethod("oasV3", String.class);
        java.util.Map<String, String> docs = JerseyModelSource.paramDocs(m, null);
        Param pathId = param("id", "path", "string", true);
        Param queryExpand = param("expand", "query", "string", false);
        Param inline = new Param("inlineParam", "query", "string", false, null, List.of(), false,
                JerseyModelSource.paramDoc(m.getParameters()[0].getAnnotations()));
        List<Param> enriched = JerseyModelSource.applyParamDocs(List.of(pathId, queryExpand, inline), docs);
        assertEquals("The issue key", enriched.get(0).description());
        assertEquals("Fields to expand", enriched.get(1).description());
        assertEquals("Inline wins", enriched.get(2).description());

        java.lang.reflect.Method embedded = Documented.class.getMethod("sameSummaryAndDescription");
        List<Param> fromOp = JerseyModelSource.applyParamDocs(
                List.of(param("limit", "query", "int", false)),
                JerseyModelSource.paramDocs(embedded, null));
        assertEquals("Max items", fromOp.get(0).description());

        java.lang.reflect.Method v2 = Documented.class.getMethod("swaggerV2", String.class);
        assertEquals("Legacy param doc", JerseyModelSource.paramDoc(v2.getParameters()[0].getAnnotations()));
    }

    @Test
    public void cleanDocCapsLengthAndDropsBlanks() {
        assertNull(JerseyModelSource.cleanDoc(null, 10));
        assertNull(JerseyModelSource.cleanDoc("   \r\n  ", 10));
        assertEquals("abc", JerseyModelSource.cleanDoc("  abc  ", 10));
        assertEquals("abcde…", JerseyModelSource.cleanDoc("abcdefgh", 5));
    }

    @Test
    public void multipartFormParamAndFileTypesAreRecognized() throws Exception {
        java.lang.reflect.Method m = Documented.class.getMethod("upload",
                com.atlassian.plugins.rest.api.multipart.FilePart.class);
        assertEquals("file", JerseyModelSource.multipartParamName(m.getParameters()[0].getAnnotations()));
        assertTrue(JerseyModelSource.isFileType(com.atlassian.plugins.rest.api.multipart.FilePart.class));
        assertTrue(JerseyModelSource.isFileType(java.io.File.class));
        assertTrue(JerseyModelSource.isFileType(java.io.InputStream.class));
        assertFalse(JerseyModelSource.isFileType(String.class));
    }

    @Test
    public void stableTypeNameFormatsAnonymousParameterizedTypeWithoutIdentityHash() {
        java.lang.reflect.ParameterizedType jerseyLike = new java.lang.reflect.ParameterizedType() {
            @Override
            public java.lang.reflect.Type[] getActualTypeArguments() {
                return new java.lang.reflect.Type[]{Long.class};
            }

            @Override
            public java.lang.reflect.Type getRawType() {
                return List.class;
            }

            @Override
            public java.lang.reflect.Type getOwnerType() {
                return null;
            }
        };
        assertEquals("java.util.List<java.lang.Long>", JerseyModelSource.stableTypeName(jerseyLike, List.class));
        assertEquals("List<Long>", JerseyModelSource.shortTypeName(jerseyLike));
        assertEquals("java.lang.String[]", JerseyModelSource.stableTypeName(String[].class, String[].class));
    }
}
