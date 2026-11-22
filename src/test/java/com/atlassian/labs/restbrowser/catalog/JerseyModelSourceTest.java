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
}
