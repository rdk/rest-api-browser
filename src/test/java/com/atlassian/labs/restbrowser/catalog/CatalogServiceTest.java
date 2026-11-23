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
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
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
        volatile Runnable duringDescribe;

        @Override
        public String id() {
            return "fake";
        }

        @Override
        public Optional<ModuleSpec> describe(RestModule module) throws SpecException {
            calls.computeIfAbsent(module.id(), k -> new AtomicInteger()).incrementAndGet();
            Runnable during = duringDescribe;
            if (during != null) {
                during.run();
            }
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

    @Test
    public void readStartedReadsThatModuleAloneAndKeepsTheCatalogComplete() throws Exception {
        source.failures.put("b", new SpecSource.SpecException(JerseyModelSource.NOT_STARTED, "not started", null));
        CatalogSnapshot before = completeSnapshot();
        assertEquals(JerseyModelSource.NOT_STARTED, entry(before, "b").reason());
        int aCalls = source.calls.get("a").get();
        source.failures.remove("b"); // a request started it
        CatalogService.Started started = service.readStarted("b", 10_000);
        assertEquals(CatalogService.StartOutcome.READ, started.outcome());
        assertEquals(Model.State.ok, started.entry().state());
        CatalogSnapshot after = service.current(null);
        assertTrue(after.complete());
        assertEquals(Model.State.ok, entry(after, "b").state());
        assertEquals(aCalls, source.calls.get("a").get()); // nothing else was read again
        assertEquals(CatalogService.StartOutcome.UNKNOWN, service.readStarted("no-such", 1_000).outcome());
    }

    @Test
    public void aSlowReadOfAStartedModuleIsQueuedPublishedOnceDoneAndNotReused() throws Exception {
        source.failures.put("b", new SpecSource.SpecException(JerseyModelSource.NOT_STARTED, "not started", null));
        completeSnapshot();
        source.failures.remove("b");
        source.gate = new CountDownLatch(1); // the read hangs
        assertEquals(CatalogService.StartOutcome.QUEUED, service.readStarted("b", 100).outcome());
        assertEquals(JerseyModelSource.NOT_STARTED, entry(service.current(null), "b").reason());
        source.gate.countDown();
        source.gate = null;
        await(() -> entry(service.current(null), "b").state() == Model.State.ok && service.current(null).complete());
        // not started again (a rebuild met it so): a new start reads it again, the earlier read is not reused
        source.failures.put("b", new SpecSource.SpecException(JerseyModelSource.NOT_STARTED, "not started", null));
        service.refresh("b");
        await(() -> JerseyModelSource.NOT_STARTED.equals(entry(service.current(null), "b").reason()) && service.current(null).complete());
        source.failures.remove("b");
        int calls = source.count("b");
        assertEquals(Model.State.ok, service.readStarted("b", 10_000).entry().state());
        assertEquals(calls + 1, source.count("b"));
    }

    @Test
    public void aSecondReadOfAModuleReadMeanwhileReadsNothing() throws Exception {
        source.failures.put("b", new SpecSource.SpecException(JerseyModelSource.NOT_STARTED, "not started", null));
        completeSnapshot();
        source.failures.remove("b");
        assertEquals(CatalogService.StartOutcome.READ, service.readStarted("b", 10_000).outcome());
        int calls = source.count("b");
        CatalogService.Started again = service.readStarted("b", 10_000); // a request that checked before the publish
        assertEquals(Model.State.ok, again.entry().state());
        assertEquals(calls, source.count("b"));
    }

    @Test
    public void aModuleWhoseApplicationStillDoesNotRunIsNotRead() throws Exception {
        JerseyModelSource notRunning = new JerseyModelSource(() -> null, () -> null) {
            @Override
            public boolean started(RestModule module) {
                return false;
            }

            @Override
            public Optional<ModuleSpec> describe(RestModule module) {
                return Optional.empty(); // the fake source describes
            }
        };
        service.destroy();
        source.failures.put("b", new SpecSource.SpecException(JerseyModelSource.NOT_STARTED, "not started", null));
        service = new CatalogService(discovery, List.of(notRunning, source), new ProductAdapter("jira", () -> null), null,
                () -> "1.0.0");
        service.afterPropertiesSet();
        service.current(null);
        completeSnapshot();
        source.failures.remove("b");
        int calls = source.count("b");
        assertEquals(CatalogService.StartOutcome.STILL_NOT_STARTED, service.readStarted("b", 10_000).outcome());
        assertEquals(calls, source.count("b"));
        assertEquals(JerseyModelSource.NOT_STARTED, entry(service.current(null), "b").reason());
    }

    @Test
    public void aReadDoesNotSayCompleteWhileAModuleIsNotReadYet() throws Exception {
        source.failures.put("b", new SpecSource.SpecException(JerseyModelSource.NOT_STARTED, "not started", null));
        completeSnapshot();
        source.failures.remove("b");
        // a module the discovery sees before its plugin's event reaches the catalog
        discovery.modules = List.of(module("a", "plugin.a"), module("b", "plugin.b"), module("c", "plugin.c"),
                module("d", "plugin.d"));
        assertEquals(CatalogService.StartOutcome.READ, service.readStarted("b", 10_000).outcome());
        CatalogSnapshot after = service.current(null);
        assertFalse(after.complete());
        assertEquals(Model.State.pending, entry(after, "d").state());
        assertEquals(3, after.done());
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
        assertEquals("fake: details for admins", b.error());
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

    /** A source with a fixed id that either fails or describes one operation. */
    private static SpecSource src(String id, SpecException failure) {
        return new SpecSource() {
            @Override
            public String id() {
                return id;
            }

            @Override
            public Optional<ModuleSpec> describe(RestModule module) throws SpecException {
                if (failure != null) {
                    throw failure;
                }
                return Optional.of(new ModuleSpec(id, List.of(new OperationSpec("GET", module.id() + "/y",
                        List.of(), List.of(), List.of(), null, false, null))));
            }
        };
    }

    private CatalogService serviceWith(List<SpecSource> sources, ModuleDiscovery d) {
        CatalogService svc = new CatalogService(d, sources, new ProductAdapter("jira", () -> null), null, () -> "1");
        svc.afterPropertiesSet();
        return svc;
    }

    private static void awaitLatch(CountDownLatch latch) {
        try {
            latch.await(10, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @Test
    public void concurrentFirstCallsBothGetASnapshot() throws Exception {
        FakeDiscovery slow = new FakeDiscovery() {
            @Override
            public List<RestModule> discover() {
                try {
                    Thread.sleep(150);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return super.discover();
            }
        };
        slow.modules = List.of(module("a", "plugin.a"));
        CatalogService svc = serviceWith(List.of(source), slow);
        try {
            CountDownLatch start = new CountDownLatch(1);
            AtomicReference<CatalogSnapshot> one = new AtomicReference<>();
            AtomicReference<CatalogSnapshot> two = new AtomicReference<>();
            Thread t1 = new Thread(() -> {
                awaitLatch(start);
                one.set(svc.current(null));
            });
            Thread t2 = new Thread(() -> {
                awaitLatch(start);
                two.set(svc.current(null));
            });
            t1.start();
            t2.start();
            start.countDown();
            t1.join(10_000);
            t2.join(10_000);
            assertNotNull(one.get());
            assertNotNull(two.get());
        } finally {
            svc.destroy();
        }
    }

    @Test
    public void aSpecExceptionFallsThroughToTheNextSource() throws Exception {
        discovery.modules = List.of(module("a", "plugin.a"));
        CatalogService svc = serviceWith(
                List.of(src("first", new SpecException("r1", "m1", null)), src("second", null)), discovery);
        try {
            svc.current(null);
            await(() -> svc.current(null).complete());
            ModuleEntry a = entry(svc.current(null), "a");
            assertEquals(State.ok, a.state());
            assertEquals("second", a.source());
            assertEquals(1, a.opCount());
        } finally {
            svc.destroy();
        }
    }

    @Test
    public void whenAllSourcesFailTheLastReasonWins() throws Exception {
        discovery.modules = List.of(module("a", "plugin.a"));
        CatalogService svc = serviceWith(List.of(src("first", new SpecException("r1", "m1", null)),
                src("second", new SpecException("r2", "m2", null))), discovery);
        try {
            svc.current(null);
            await(() -> svc.current(null).complete());
            ModuleEntry a = entry(svc.current(null), "a");
            assertEquals(State.failed, a.state());
            assertEquals("r2", a.reason());
            assertEquals("second: m2", a.error());
        } finally {
            svc.destroy();
        }
    }

    @Test
    public void refreshOfEverythingMarksTheCatalogIncompleteAtOnce() throws Exception {
        service.current(null);
        CatalogSnapshot before = completeSnapshot();
        source.gate = new CountDownLatch(1);
        service.refresh(null);
        CatalogSnapshot during = service.current(null);
        assertFalse(during.complete());
        assertNotEquals(before.hash(), during.hash());
        source.gate.countDown();
        await(() -> service.current(null).complete());
        assertEquals(before.hash(), service.current(null).hash());
    }

    @Test
    public void aModuleKeepsItsOperationsWhileItIsRebuilt() throws Exception {
        service.current(null);
        completeSnapshot();
        source.gate = new CountDownLatch(1);
        service.refresh("a");
        await(() -> source.count("a") == 2); // the second describe is now blocked on the latch
        CatalogSnapshot during = service.current(null);
        assertFalse(during.complete());
        ModuleEntry a = entry(during, "a");
        assertEquals(State.ok, a.state());
        assertEquals(2, a.opCount());
        assertTrue(new String(during.index(), java.nio.charset.StandardCharsets.UTF_8)
                .contains("\"key\":\"a:GET:a/x\""));
        source.gate.countDown();
        await(() -> service.current(null).complete());
    }

    @Test
    public void aPluginEventWithoutRestModulesLeavesTheHashUnchanged() throws Exception {
        service.current(null);
        CatalogSnapshot before = completeSnapshot();
        PluginEnabledEvent event = mock(PluginEnabledEvent.class);
        Plugin plugin = mock(Plugin.class);
        when(plugin.getKey()).thenReturn("plugin.without.rest");
        when(event.getPlugin()).thenReturn(plugin);
        service.onPluginEnabled(event);
        service.build(); // what the debounced task does, without waiting for the debounce
        assertEquals(before.hash(), service.current(null).hash());
        assertTrue(service.current(null).complete());
        assertEquals(1, source.count("a"));
    }

    @Test
    public void aBuildThatEndsWithMoreWorkQueuedDoesNotSayComplete() throws Exception {
        completeSnapshot();
        service.onPluginEnabled(pluginEvent("plugin.b"));
        source.duringDescribe = () -> service.onPluginEnabled(pluginEvent("plugin.c")); // c changes while b is read
        service.build(); // reads b, as the debounced task would; c is queued for the next build
        source.duringDescribe = null;
        assertFalse(service.current(null).complete()); // not complete while c waits
        await(() -> service.current(null).complete() && source.count("c") == 2);
    }

    private static PluginEnabledEvent pluginEvent(String key) {
        PluginEnabledEvent event = mock(PluginEnabledEvent.class);
        Plugin plugin = mock(Plugin.class);
        when(plugin.getKey()).thenReturn(key);
        when(event.getPlugin()).thenReturn(plugin);
        return event;
    }
}
