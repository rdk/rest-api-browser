package com.atlassian.labs.restbrowser.catalog;

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
}
