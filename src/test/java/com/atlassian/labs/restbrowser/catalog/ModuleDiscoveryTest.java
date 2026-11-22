package com.atlassian.labs.restbrowser.catalog;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class ModuleDiscoveryTest {

    @Test
    public void pathJoinsBasePathAndVersion() {
        assertEquals("api/2", ModuleDiscovery.path("/api", "2"));
        assertEquals("api/1", ModuleDiscovery.path("api/", "1"));
        assertEquals("1", ModuleDiscovery.path("/", "1"));
        assertEquals("x", ModuleDiscovery.path("/x", "none"));
    }
}
