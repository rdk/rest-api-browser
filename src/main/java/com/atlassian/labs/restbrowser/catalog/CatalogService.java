package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.event.api.EventListener;
import com.atlassian.event.api.EventPublisher;
import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.ModuleSpec;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.State;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.labs.restbrowser.catalog.SpecSource.SpecException;
import com.atlassian.plugin.event.events.PluginDisabledEvent;
import com.atlassian.plugin.event.events.PluginEnabledEvent;
import com.atlassian.plugin.event.events.PluginModuleDisabledEvent;
import com.atlassian.plugin.event.events.PluginModuleEnabledEvent;
import jakarta.servlet.ServletContext;
import org.slf4j.Logger;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.InitializingBean;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

import static java.util.Objects.requireNonNull;
import static org.slf4j.LoggerFactory.getLogger;

/**
 * Builds and holds the catalog of this node's REST API.
 * <p>
 * Built on first use, never at product start: a tool few people open should not initialize every REST module of
 * every node. One background thread describes the modules one by one, with a short pause between them and a
 * timeout per module, and publishes a snapshot every few seconds until it is complete. Plugin events then mark only
 * the affected plugins' modules stale and rebuild them after a short debounce.
 */
public class CatalogService implements InitializingBean, DisposableBean {

    private static final Logger LOGGER = getLogger(CatalogService.class);

    static final long PUBLISH_EVERY_MS = 3_000;
    static final long PAUSE_BETWEEN_MODULES_MS = 10;
    static final long MODULE_TIMEOUT_MS = 30_000;
    static final long DEBOUNCE_MS = 3_000;

    private final ModuleDiscovery discovery;
    private final List<SpecSource> sources;
    private final ProductAdapter product;
    private final EventPublisher eventPublisher;
    private final Supplier<String> ownVersion;

    private final AtomicReference<CatalogSnapshot> current = new AtomicReference<>();
    private final AtomicReference<ServletContext> servletContext = new AtomicReference<>();
    private final AtomicBoolean started = new AtomicBoolean();
    /** Results per module id; only touched by the build thread. */
    private final Map<String, Built> built = new LinkedHashMap<>();
    private final Set<String> stalePlugins = new HashSet<>();
    private volatile boolean rebuildAll;

    private ScheduledExecutorService buildThread;
    private ExecutorService describeThreads;
    private ScheduledFuture<?> pending;

    private record Built(ModuleEntry entry, List<Operation> operations) {
    }

    public CatalogService(ModuleDiscovery discovery, List<SpecSource> sources, ProductAdapter product,
                          EventPublisher eventPublisher, Supplier<String> ownVersion) {
        this.discovery = requireNonNull(discovery);
        this.sources = List.copyOf(sources);
        this.product = requireNonNull(product);
        this.eventPublisher = eventPublisher;
        this.ownVersion = requireNonNull(ownVersion);
    }

    @Override
    public void afterPropertiesSet() {
        buildThread = Executors.newSingleThreadScheduledExecutor(daemon("rest-api-browser-catalog"));
        describeThreads = Executors.newCachedThreadPool(daemon("rest-api-browser-describe"));
        if (eventPublisher != null) {
            eventPublisher.register(this);
        }
    }

    @Override
    public void destroy() {
        if (eventPublisher != null) {
            eventPublisher.unregister(this);
        }
        buildThread.shutdownNow();
        describeThreads.shutdownNow();
        built.clear();
        current.set(null);
    }

    /** The ServletContext of a request, needed to initialize REST modules that have not started yet. */
    public ServletContext servletContext() {
        return servletContext.get();
    }

    /**
     * The current snapshot. The first call starts the build and returns a snapshot that lists every module as
     * pending.
     */
    public CatalogSnapshot current(ServletContext context) {
        if (context != null) {
            servletContext.compareAndSet(null, context);
        }
        if (started.compareAndSet(false, true)) {
            List<RestModule> modules = discovery.discover();
            List<ModuleEntry> entries = new ArrayList<>();
            for (RestModule m : modules) {
                entries.add(entry(m, null, State.pending, null, null, 0));
            }
            current.set(CatalogSnapshot.of(entries, List.of(), false, 0, modules.size(), ownVersion.get()));
            schedule(0);
        }
        return current.get();
    }

    /** Rebuilds one module, or everything when moduleId is null. */
    public void refresh(String moduleId) {
        synchronized (stalePlugins) {
            if (moduleId == null) {
                rebuildAll = true;
            } else {
                stalePlugins.add("module:" + moduleId);
            }
        }
        if (started.get()) {
            schedule(0);
        }
    }

    @EventListener
    public void onPluginEnabled(PluginEnabledEvent event) {
        stale(event.getPlugin().getKey());
    }

    @EventListener
    public void onPluginDisabled(PluginDisabledEvent event) {
        stale(event.getPlugin().getKey());
    }

    @EventListener
    public void onModuleEnabled(PluginModuleEnabledEvent event) {
        stale(event.getModule().getPluginKey());
    }

    @EventListener
    public void onModuleDisabled(PluginModuleDisabledEvent event) {
        stale(event.getModule().getPluginKey());
    }

    private void stale(String pluginKey) {
        if (!started.get()) {
            return; // nothing built yet: the first use discovers everything anyway
        }
        synchronized (stalePlugins) {
            stalePlugins.add(pluginKey);
        }
        schedule(DEBOUNCE_MS);
    }

    private synchronized void schedule(long delayMs) {
        if (buildThread == null || buildThread.isShutdown()) {
            return;
        }
        if (pending != null && !pending.isDone()) {
            pending.cancel(false);
        }
        pending = buildThread.schedule(this::build, delayMs, TimeUnit.MILLISECONDS);
    }

    /** Runs on the build thread only. */
    void build() {
        Set<String> stale;
        boolean all;
        synchronized (stalePlugins) {
            stale = new HashSet<>(stalePlugins);
            stalePlugins.clear();
            all = rebuildAll;
            rebuildAll = false;
        }
        if (all) {
            built.clear();
        }
        List<RestModule> modules = discovery.discover();
        Set<String> present = new HashSet<>();
        for (RestModule m : modules) {
            present.add(m.id());
        }
        built.keySet().removeIf(id -> !present.contains(id));
        List<RestModule> todo = new ArrayList<>();
        for (RestModule m : modules) {
            Built b = built.get(m.id());
            if (b == null || stale.contains(m.pluginKey()) || stale.contains("module:" + m.id())) {
                built.remove(m.id());
                todo.add(m);
            }
        }
        long lastPublish = System.currentTimeMillis();
        int done = modules.size() - todo.size();
        publish(modules, done, todo.isEmpty());
        for (RestModule m : todo) {
            if (Thread.currentThread().isInterrupted()) {
                return;
            }
            built.put(m.id(), describe(m));
            done++;
            if (System.currentTimeMillis() - lastPublish >= PUBLISH_EVERY_MS) {
                publish(modules, done, false);
                lastPublish = System.currentTimeMillis();
            }
            pause();
        }
        publish(modules, done, true);
    }

    private Built describe(RestModule module) {
        String origin = product.origin(module.plugin());
        for (SpecSource source : sources) {
            Future<Optional<ModuleSpec>> future = describeThreads.submit(() -> source.describe(module));
            try {
                Optional<ModuleSpec> spec = future.get(MODULE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                if (spec.isPresent()) {
                    List<Operation> operations = OperationKeys.assign(module.id(), spec.get().operations());
                    return new Built(entry(module, origin, State.ok, null, null, operations.size())
                            .withSource(source.id()), operations);
                }
            } catch (TimeoutException e) {
                future.cancel(true);
                return failed(module, origin, "timeout", "No answer within " + MODULE_TIMEOUT_MS + " ms");
            } catch (ExecutionException e) {
                Throwable cause = e.getCause();
                if (cause instanceof SpecException se) {
                    LOGGER.debug("{} couldn't describe {}", source.id(), module.id(), se);
                    return failed(module, origin, se.reason(), se.getMessage());
                }
                LOGGER.debug("{} failed on {}", source.id(), module.id(), cause);
                return failed(module, origin, "error", String.valueOf(cause));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return failed(module, origin, "interrupted", "The build was stopped");
            }
        }
        return failed(module, origin, module.restV2() ? "no-source" : "rest-v1", "No source describes this module");
    }

    private Built failed(RestModule module, String origin, String reason, String error) {
        return new Built(entry(module, origin, State.failed, reason, error, 0), List.of());
    }

    private ModuleEntry entry(RestModule m, String origin, State state, String reason, String error, int opCount) {
        String o = origin != null ? origin : product.origin(m.plugin());
        return new ModuleEntry(m.id(), m.path(), o, product.stability(m, o), null, state, reason, error, opCount,
                m.pluginKey(), m.pluginName(), m.pluginVersion());
    }

    private void publish(List<RestModule> modules, int done, boolean complete) {
        List<ModuleEntry> entries = new ArrayList<>();
        List<Operation> operations = new ArrayList<>();
        for (RestModule m : modules) {
            Built b = built.get(m.id());
            if (b == null) {
                entries.add(entry(m, null, State.pending, null, null, 0));
            } else {
                entries.add(b.entry());
                operations.addAll(b.operations());
            }
        }
        current.set(CatalogSnapshot.of(entries, operations, complete, done, modules.size(), ownVersion.get()));
    }

    private static void pause() {
        try {
            Thread.sleep(PAUSE_BETWEEN_MODULES_MS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static java.util.concurrent.ThreadFactory daemon(String name) {
        return r -> {
            Thread t = new Thread(r, name);
            t.setDaemon(true);
            return t;
        };
    }
}
