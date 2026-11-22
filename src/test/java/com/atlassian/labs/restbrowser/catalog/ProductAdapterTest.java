package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.metadata.PluginMetadataManager;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

public class ProductAdapterTest {

    private static RestModule module(String path) {
        return new RestModule("p:" + path, path, path, "1", true, "p", "P", "1", null, null, null);
    }

    private static String stability(String product, String path, String origin) {
        return new ProductAdapter(product, () -> null).stability(module(path), origin);
    }

    @Test
    public void jiraPublicApis() {
        assertEquals("supported", stability("jira", "api/2", "product"));
        assertEquals("supported", stability("jira", "api/2/", "product"));
        assertEquals("supported", stability("jira", "auth/1", "product"));
        assertEquals("supported", stability("jira", "activities/1.0", "product"));
    }

    @Test
    public void jiraDottedVersionIsNotApi2() {
        // The rule is ^api/2(/|$): "api/2.0" and "api/latest" do not match it, they are not the "api/2" module
        assertEquals("internal", stability("jira", "api/2.0", "product"));
        assertEquals("internal", stability("jira", "api/latest", "product"));
        assertEquals("internal", stability("jira", "api/3", "product"));
    }

    @Test
    public void crowdApplicationApisAreExcludedInEveryProduct() {
        for (String product : new String[]{"jira", "conf", "unknown"}) {
            ProductAdapter adapter = new ProductAdapter(product, () -> null);
            assertTrue(adapter.excluded(module("usermanagement/1")));
            assertTrue(adapter.excluded(module("appmanagement/1")));
            assertFalse(adapter.excluded(module("api/2")));
            assertFalse(adapter.excluded(module("myusermanagement/1")));
        }
    }

    @Test
    public void jiraOtherModulesAreInternal() {
        assertEquals("internal", stability("jira", "agile/1.0", "product"));
        assertEquals("internal", stability("jira", "agile/1.0", "bundled"));
    }

    @Test
    public void userInstalledPluginsAreApps() {
        assertEquals("app", stability("jira", "myplugin/1.0", "user"));
        assertEquals("app", stability("conf", "myplugin/1.0", "user"));
    }

    @Test
    public void supportedWinsOverUserOrigin() {
        assertEquals("supported", stability("jira", "api/2", "user"));
    }

    @Test
    public void confluence() {
        assertEquals("supported", stability("conf", "api", "product"));
        assertEquals("supported", stability("conf", "api/user", "product"));
        assertEquals("internal", stability("conf", "apiv2", "product"));
        assertEquals("internal", stability("conf", "experimental/1", "bundled"));
    }

    @Test
    public void unknownProductHasNoSupportedModules() {
        assertEquals("internal", stability("nope", "api/2", "product"));
        assertEquals("app", stability("nope", "api/2", "user"));
        assertEquals("internal", stability(null, "api/2", "product"));
    }

    @Test
    public void productIdIsKept() {
        assertEquals("jira", new ProductAdapter("jira", () -> null).productId());
    }

    private static Plugin plugin(boolean bundled, boolean system) {
        Plugin p = mock(Plugin.class);
        when(p.getKey()).thenReturn("the.plugin");
        when(p.isBundledPlugin()).thenReturn(bundled);
        when(p.isSystemPlugin()).thenReturn(system);
        return p;
    }

    @Test
    public void originFromMetadataManager() {
        PluginMetadataManager pmm = mock(PluginMetadataManager.class);
        Plugin user = plugin(false, false);
        Plugin system = plugin(true, true);
        Plugin bundled = plugin(true, false);
        when(pmm.isUserInstalled(user)).thenReturn(true);
        when(pmm.isSystemProvided(system)).thenReturn(true);
        ProductAdapter adapter = new ProductAdapter("jira", () -> pmm);
        assertEquals("user", adapter.origin(user));
        assertEquals("product", adapter.origin(system));
        assertEquals("bundled", adapter.origin(bundled));
    }

    @Test
    public void metadataManagerWinsOverPluginFlags() {
        PluginMetadataManager pmm = mock(PluginMetadataManager.class);
        Plugin p = plugin(false, false); // flags say user, manager says product
        when(pmm.isSystemProvided(p)).thenReturn(true);
        assertEquals("product", new ProductAdapter("jira", () -> pmm).origin(p));
    }

    @Test
    public void originFallsBackToPluginFlagsWithoutManager() {
        for (ProductAdapter adapter : new ProductAdapter[]{
                new ProductAdapter("jira", null),
                new ProductAdapter("jira", () -> null),
                new ProductAdapter("jira", () -> {
                    throw new NoClassDefFoundError("not exported");
                })}) {
            assertEquals("user", adapter.origin(plugin(false, false)));
            assertEquals("product", adapter.origin(plugin(true, true)));
            assertEquals("bundled", adapter.origin(plugin(true, false)));
        }
    }

    @Test
    public void originFallsBackWhenManagerThrows() {
        PluginMetadataManager pmm = mock(PluginMetadataManager.class);
        when(pmm.isUserInstalled(org.mockito.ArgumentMatchers.any())).thenThrow(new IllegalStateException("x"));
        assertEquals("bundled", new ProductAdapter("jira", () -> pmm).origin(plugin(true, false)));
    }

    @Test
    public void managerIsNotCalledAgainAfterItFailedOnce() {
        PluginMetadataManager pmm = mock(PluginMetadataManager.class);
        when(pmm.isUserInstalled(org.mockito.ArgumentMatchers.any())).thenThrow(new IllegalStateException("x"));
        ProductAdapter adapter = new ProductAdapter("jira", () -> pmm);
        assertEquals("bundled", adapter.origin(plugin(true, false)));
        assertEquals("product", adapter.origin(plugin(true, true)));
        assertEquals("user", adapter.origin(plugin(false, false)));
        org.mockito.Mockito.verify(pmm, org.mockito.Mockito.times(1))
                .isUserInstalled(org.mockito.ArgumentMatchers.any());
        org.mockito.Mockito.verify(pmm, org.mockito.Mockito.never())
                .isSystemProvided(org.mockito.ArgumentMatchers.any());
    }
}
