package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.ModuleSpec;
import com.atlassian.labs.restbrowser.catalog.Model.OperationSpec;
import com.atlassian.labs.restbrowser.catalog.Model.State;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.labs.restbrowser.catalog.SpecSource.SpecException;
import com.atlassian.plugin.ModuleDescriptor;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.event.events.PluginEnabledEvent;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

public class CatalogServiceTest {

    /** A discovery that returns a fixed list. */
    private static class FakeDiscovery extends ModuleDiscovery {
        volatile List<RestModule> modules = List.of();

        FakeDiscovery() {
            super(mock(com.atlassian.plugin.PluginAccessor.class));
        }

        @Override
        public List<RestModule> discover() {
            return modules;
        }
    }

    /** A source whose answer is decided per module id; counts describe calls. */
    private static class FakeSource implements SpecSource {
        final Map<String, AtomicInteger> calls = new ConcurrentHashMap<>();
        final Map<String, SpecException> failures = new HashMap<>();
        final List<String> noSource = new ArrayList<>();
        volatile CountDownLatch gate;

        @Override
        public String id() {
            return "fake";
        }

        @Override
        public Optional<ModuleSpec> describe(RestModule module) throws SpecException {
            calls.computeIfAbsent(module.id(), k -> new AtomicInteger()).incrementAndGet();
            CountDownLatch g = gate;
            if (g != null) {
                try {
                    g.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            if (failures.containsKey(module.id())) {
                throw failures.get(module.id());
            }
            if (noSource.contains(module.id())) {
                return Optional.empty();
            }
            return Optional.of(new ModuleSpec("fake", List.of(
                    new OperationSpec("GET", module.id() + "/x", List.of(), List.of("application/json"), List.of(),
                            null, false, null),
                    new OperationSpec("POST", module.id() + "/x", List.of("application/json"), List.of(),
                            List.of(), null, false, null))));
        }

        int count(String id) {
            AtomicInteger c = calls.get(id);
            return c == null ? 0 : c.get();
        }
    }

    private FakeDiscovery discovery;
    private FakeSource source;
    private CatalogService service;

    private static RestModule module(String id, String pluginKey) {
        Plugin plugin = mock(Plugin.class);
        when(plugin.getKey()).thenReturn(pluginKey);
        ModuleDescriptor<?> descriptor = mock(ModuleDescriptor.class);
        return new RestModule(id, "api/" + id, "/api", id, true, pluginKey, "Plugin " + pluginKey, "1.0", null,
                plugin, descriptor);
    }

    @Before
    public void setUp() {
        discovery = new FakeDiscovery();
        discovery.modules = List.of(module("a", "plugin.a"), module("b", "plugin.b"), module("c", "plugin.c"));
        source = new FakeSource();
        service = new CatalogService(discovery, List.of(source), new ProductAdapter("jira", () -> null), null,
                () -> "1.0.0");
        service.afterPropertiesSet();
    }

    @After
    public void tearDown() {
        service.destroy();
    }

    private static void await(BooleanSupplier condition) throws InterruptedException {
        long end = System.currentTimeMillis() + 15_000;
        while (!condition.getAsBoolean()) {
            if (System.currentTimeMillis() > end) {
                throw new AssertionError("timed out");
            }
            Thread.sleep(20);
        }
    }

    private static ModuleEntry entry(CatalogSnapshot s, String id) {
        return s.modules().stream().filter(m -> m.id().equals(id)).findFirst().orElseThrow();
    }

    private CatalogSnapshot completeSnapshot() throws InterruptedException {
        await(() -> service.current(null).complete());
        return service.current(null);
    }

    @Test
    public void firstSnapshotHasEveryModulePendingAndThenBuildCompletes() throws Exception {
        source.gate = new CountDownLatch(1); // holds the background build, so the first snapshot is observable
        CatalogSnapshot first = service.current(null);
        assertFalse(first.complete());
        assertEquals(3, first.total());
        assertEquals(0, first.done());
        assertEquals(3, first.modules().size());
        assertTrue(first.modules().stream().allMatch(m -> m.state() == State.pending));
        assertEquals("Plugin plugin.a", entry(first, "a").pluginName());
        assertEquals("api/a", entry(first, "a").path());

        source.gate.countDown();
        CatalogSnapshot done = completeSnapshot();
        assertEquals(3, done.done());
        assertTrue(done.modules().stream().allMatch(m -> m.state() == State.ok));
        assertTrue(done.modules().stream().allMatch(m -> m.opCount() == 2 && "fake".equals(m.source())));
        String index = new String(done.index(), java.nio.charset.StandardCharsets.UTF_8);
        assertTrue(index.contains("\"key\":\"a:GET:a/x\""));
        assertTrue(index.contains("\"key\":\"c:POST:c/x\""));

        // build() called directly (as the build thread does) changes nothing when nothing is stale
        service.build();
        assertEquals(done.hash(), service.current(null).hash());
        assertEquals(1, source.count("a"));
    }

    @Test
    public void buildCalledDirectlyCompletesTheSnapshot() throws Exception {
        source.gate = new CountDownLatch(1);
        service.current(null);
        source.gate.countDown();
        await(() -> service.current(null).complete());
        service.build();
        CatalogSnapshot s = service.current(null);
        assertTrue(s.complete());
        assertEquals(6, countOps(s));
    }

    private static int countOps(CatalogSnapshot s) {
        return s.modules().stream().mapToInt(ModuleEntry::opCount).sum();
    }

    @Test
    public void specExceptionMarksTheModuleFailedWithItsReason() throws Exception {
        source.failures.put("b", new SpecException("model-unavailable", "details for admins", null));
        service.current(null);
        CatalogSnapshot s = completeSnapshot();
        ModuleEntry b = entry(s, "b");
        assertEquals(State.failed, b.state());
        assertEquals("model-unavailable", b.reason());
        assertEquals("details for admins", b.error());
        assertEquals(0, b.opCount());
        assertEquals(State.ok, entry(s, "a").state());
    }

    @Test
    public void unexpectedExceptionMarksTheModuleFailedWithErrorReason() throws Exception {
        discovery.modules = List.of(module("a", "plugin.a"));
        FakeSource throwing = new FakeSource() {
            @Override
            public Optional<ModuleSpec> describe(RestModule module) {
                throw new IllegalStateException("kaboom");
            }
        };
        CatalogService svc = new CatalogService(discovery, List.of(throwing), new ProductAdapter("jira", () -> null),
                null, () -> "1");
        svc.afterPropertiesSet();
        try {
            svc.current(null);
            await(() -> svc.current(null).complete());
            ModuleEntry a = entry(svc.current(null), "a");
            assertEquals(State.failed, a.state());
            assertEquals("error", a.reason());
            assertTrue(a.error().contains("kaboom"));
        } finally {
            svc.destroy();
        }
    }

    @Test
    public void moduleNoSourceAnswersForIsFailedWithNoSource() throws Exception {
        source.noSource.add("c");
        service.current(null);
        ModuleEntry c = entry(completeSnapshot(), "c");
        assertEquals(State.failed, c.state());
        assertEquals("no-source", c.reason());
    }

    @Test
    public void restV1ModuleWithoutSourceIsFailedWithRestV1() throws Exception {
        RestModule v1 = new RestModule("old", "api/old", "/api", "1", false, "plugin.old", "Old", "1", null,
                mock(Plugin.class), mock(ModuleDescriptor.class));
        discovery.modules = List.of(v1);
        source.noSource.add("old");
        service.current(null);
        assertEquals("rest-v1", entry(completeSnapshot(), "old").reason());
    }

    @Test
    public void refreshOfOneModuleRebuildsOnlyThatModule() throws Exception {
        service.current(null);
        completeSnapshot();
        assertEquals(1, source.count("a"));
        service.refresh("b");
        await(() -> source.count("b") == 2);
        Thread.sleep(300);
        assertEquals(1, source.count("a"));
        assertEquals(2, source.count("b"));
        assertEquals(1, source.count("c"));
        assertTrue(service.current(null).complete());
    }

    @Test
    public void refreshWithoutIdRebuildsEverything() throws Exception {
        service.current(null);
        completeSnapshot();
        service.refresh(null);
        await(() -> source.count("a") == 2 && source.count("b") == 2 && source.count("c") == 2);
        Thread.sleep(300);
        assertEquals(2, source.count("a"));
    }

    @Test
    public void pluginEnabledEventRebuildsOnlyThatPluginsModules() throws Exception {
        service.current(null);
        completeSnapshot();
        PluginEnabledEvent event = mock(PluginEnabledEvent.class);
        Plugin plugin = mock(Plugin.class);
        when(plugin.getKey()).thenReturn("plugin.c");
        when(event.getPlugin()).thenReturn(plugin);
        service.onPluginEnabled(event);
        await(() -> source.count("c") == 2); // after the debounce
        Thread.sleep(300);
        assertEquals(1, source.count("a"));
        assertEquals(1, source.count("b"));
        assertEquals(2, source.count("c"));
    }

    @Test
    public void eventsBeforeFirstUseAreIgnored() throws Exception {
        PluginEnabledEvent event = mock(PluginEnabledEvent.class);
        Plugin plugin = mock(Plugin.class);
        when(plugin.getKey()).thenReturn("plugin.a");
        when(event.getPlugin()).thenReturn(plugin);
        service.onPluginEnabled(event);
        Thread.sleep(200);
        assertEquals(0, source.count("a"));
    }

    @Test
    public void removedModulesDisappearOnTheNextBuild() throws Exception {
        service.current(null);
        completeSnapshot();
        discovery.modules = List.of(discovery.modules.get(0), discovery.modules.get(1));
        service.refresh("a");
        await(() -> service.current(null).modules().size() == 2 && service.current(null).complete());
        assertEquals(2, service.current(null).total());
    }
}
