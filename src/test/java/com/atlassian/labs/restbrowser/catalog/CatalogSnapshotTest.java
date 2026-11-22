package com.atlassian.labs.restbrowser.catalog;

import static org.junit.Assert.assertSame;
import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.State;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import static com.atlassian.labs.restbrowser.catalog.CatalogTestSupport.module;
import static com.atlassian.labs.restbrowser.catalog.CatalogTestSupport.parseJson;
import static com.atlassian.labs.restbrowser.catalog.CatalogTestSupport.snapshot;
import static com.atlassian.labs.restbrowser.catalog.CatalogTestSupport.spec;
import static java.nio.charset.StandardCharsets.UTF_8;
import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

public class CatalogSnapshotTest {

    private final ModuleEntry a = module("a", "api/1", State.ok, "1.0");
    private final ModuleEntry b = module("b", "api/2", State.ok, "2.0");
    private final List<Operation> ops = List.of(
            new Operation("a:GET:x", "a", spec("GET", "x")),
            new Operation("a:POST:x", "a", spec("POST", "x")),
            new Operation("b:GET:y/{}", "b", spec("GET", "y/{id}")));

    private CatalogSnapshot base() {
        return snapshot(List.of(a, b), ops, true, "1.0.0");
    }

    @Test
    public void inputOrderDoesNotMatter() {
        List<ModuleEntry> modules = new ArrayList<>(List.of(a, b));
        List<Operation> operations = new ArrayList<>(ops);
        Collections.reverse(modules);
        Collections.reverse(operations);
        CatalogSnapshot reversed = snapshot(modules, operations, true, "1.0.0");
        assertEquals(base().hash(), reversed.hash());
        assertArrayEquals(base().index(), reversed.index());
        assertEquals(base().modules(), reversed.modules());
    }

    @Test
    public void pluginVersionOfThisPluginChangesHash() {
        assertNotEquals(base().hash(), snapshot(List.of(a, b), ops, true, "1.0.1").hash());
    }

    @Test
    public void moduleStateChangeChangesHash() {
        ModuleEntry failed = new ModuleEntry("b", "api/2", "product", "supported", "jersey", State.failed, "timeout",
                "boom", 0, "plugin.b", "Plugin b", "2.0");
        assertNotEquals(base().hash(), snapshot(List.of(a, failed), ops, true, "1.0.0").hash());
        ModuleEntry otherVersion = module("b", "api/2", State.ok, "2.1");
        assertNotEquals(base().hash(), snapshot(List.of(a, otherVersion), ops, true, "1.0.0").hash());
    }

    @Test
    public void completeChangesHash() {
        assertNotEquals(base().hash(), snapshot(List.of(a, b), ops, false, "1.0.0").hash());
    }

    @Test
    public void operationsChangeHash() {
        assertNotEquals(base().hash(), snapshot(List.of(a, b), ops.subList(0, 2), true, "1.0.0").hash());
    }

    @Test
    public void hashIsAShortHex() {
        assertTrue(base().hash().matches("[0-9a-f]{24}"));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void indexIsValidJsonWithHashAndSortedOperations() {
        CatalogSnapshot s = base();
        Map<String, Object> index = (Map<String, Object>) parseJson(new String(s.index(), UTF_8));
        assertEquals(1L, index.get("format"));
        assertEquals(s.hash(), index.get("hash"));
        List<Map<String, Object>> operations = (List<Map<String, Object>>) index.get("operations");
        assertEquals(List.of("a:GET:x", "a:POST:x", "b:GET:y/{}"),
                operations.stream().map(o -> o.get("key")).toList());
    }

    @Test
    public void indexIsACopy() {
        CatalogSnapshot s = base();
        s.index()[0] = 'X';
        assertEquals('{', s.index()[0]);
    }

    @Test
    @SuppressWarnings("unchecked")
    public void summaryHidesVersionsAndErrorsForNonAdmins() {
        ModuleEntry failed = new ModuleEntry("c", "api/3", "bundled", "internal", null, State.failed, "timeout",
                "secret detail", 0, "plugin.c", "Plugin c", "9.9.9");
        CatalogSnapshot s = snapshot(List.of(a, failed), ops, true, "1.0.0");
        String user = s.summary("Jira", "10", "100", "/jira", false);
        assertFalse(user.contains("9.9.9"));
        assertFalse(user.contains("secret detail"));
        assertFalse(user.contains("\"error\""));
        assertTrue(user.contains("\"reason\":\"timeout\""));
        Map<String, Object> parsed = (Map<String, Object>) parseJson(user);
        assertEquals(false, parsed.get("admin"));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void summaryShowsVersionsAndErrorsForAdmins() {
        ModuleEntry failed = new ModuleEntry("c", "api/3", "bundled", "internal", null, State.failed, "timeout",
                "secret detail", 0, "plugin.c", "Plugin c", "9.9.9");
        CatalogSnapshot s = snapshot(List.of(a, failed), ops, true, "1.0.0");
        Map<String, Object> parsed = (Map<String, Object>) parseJson(s.summary("Jira", "10", "100", "/jira", true));
        assertEquals(true, parsed.get("admin"));
        assertEquals(s.hash(), parsed.get("hash"));
        assertEquals(true, parsed.get("complete"));
        Map<String, Object> product = (Map<String, Object>) parsed.get("product");
        assertEquals("Jira", product.get("name"));
        assertEquals("/jira", parsed.get("baseUrl"));
        List<Map<String, Object>> modules = (List<Map<String, Object>>) parsed.get("modules");
        Map<String, Object> c = modules.get(1);
        assertEquals("secret detail", c.get("error"));
        assertEquals("9.9.9", ((Map<String, Object>) c.get("plugin")).get("version"));
    }

    @Test
    @SuppressWarnings("unchecked")
    public void summaryOmitsAbsentOptionalFields() {
        ModuleEntry noSource = new ModuleEntry("c", "api/3", "bundled", "internal", null, State.pending, null, null,
                0, "plugin.c", "Plugin c", null);
        CatalogSnapshot s = snapshot(List.of(noSource), List.of(), false, "1.0.0");
        Map<String, Object> parsed = (Map<String, Object>) parseJson(s.summary("P", "1", "2", "", true));
        Map<String, Object> m = ((List<Map<String, Object>>) parsed.get("modules")).get(0);
        assertFalse(m.containsKey("source"));
        assertFalse(m.containsKey("reason"));
        assertFalse(m.containsKey("error"));
        assertFalse(((Map<String, Object>) m.get("plugin")).containsKey("version"));
    }

    @Test
    public void incompleteKeepsTheOperationsButChangesTheHash() {
        CatalogSnapshot complete = base();
        CatalogSnapshot incomplete = complete.incomplete("1.0.0");
        assertTrue(complete.complete());
        assertFalse(incomplete.complete());
        assertNotEquals(complete.hash(), incomplete.hash());
        assertEquals(complete.modules(), incomplete.modules());
        assertEquals(complete.done(), incomplete.done());
        assertEquals(complete.total(), incomplete.total());
        String ops = "\"operations\":";
        String c = new String(complete.index(), UTF_8);
        String i = new String(incomplete.index(), UTF_8);
        assertEquals(c.substring(c.indexOf(ops)), i.substring(i.indexOf(ops)));
        assertSame(incomplete, incomplete.incomplete("1.0.0"));
    }

    @Test
    public void adminTagCoversErrorMessagesButTheHashDoesNot() {
        ModuleEntry one = new ModuleEntry("a", "api/1", "product", "supported", null, State.failed, "error", "first",
                0, "plugin.a", "Plugin a", "1.0");
        ModuleEntry two = new ModuleEntry("a", "api/1", "product", "supported", null, State.failed, "error", "second",
                0, "plugin.a", "Plugin a", "1.0");
        CatalogSnapshot s1 = snapshot(List.of(one), List.of(), true, "1.0.0");
        CatalogSnapshot s2 = snapshot(List.of(two), List.of(), true, "1.0.0");
        assertEquals(s1.hash(), s2.hash());
        assertNotEquals(s1.adminTag(), s2.adminTag());
        assertTrue(s1.adminTag().startsWith(s1.hash() + "-"));
    }
}
