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
import java.util.HashMap;
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
import java.util.concurrent.ThreadFactory;
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
    private volatile boolean started;
    /** Results per module id; only touched by the build thread. */
    private final Map<String, Built> built = new LinkedHashMap<>();
    /**
     * Source calls that timed out and may still run; the module is not described again until its call ends. A flag
     * the task clears itself, because a cancelled Future reports done at once, even while its thread still runs.
     */
    private final Map<String, AtomicBoolean> stuck = new HashMap<>();
    private final Set<String> stalePlugins = new HashSet<>();
    private boolean rebuildAll;

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
        if (buildThread != null) {
            buildThread.shutdownNow();
        }
        if (describeThreads != null) {
            describeThreads.shutdownNow();
        }
        // the build thread may still be finishing: leave its maps to the garbage collector
    }

    /** The source that reads Jersey's model, for the details of one operation; null when there is none. */
    public JerseyModelSource jersey() {
        for (SpecSource source : sources) {
            if (source instanceof JerseyModelSource j) {
                return j;
            }
        }
        return null;
    }

    /** The ServletContext of a request, needed to initialize REST modules that have not started yet. */
    public ServletContext servletContext() {
        return servletContext.get();
    }

    /**
     * The current snapshot, never null. The first call starts the build and returns a snapshot that lists every
     * module as pending; concurrent first calls wait for it.
     */
    public CatalogSnapshot current(ServletContext context) {
        if (context != null) {
            servletContext.compareAndSet(null, context);
        }
        CatalogSnapshot snapshot = current.get();
        if (snapshot != null) {
            return snapshot;
        }
        synchronized (this) {
            snapshot = current.get();
            if (snapshot == null) {
                List<RestModule> modules = discovery.discover();
                List<ModuleEntry> entries = new ArrayList<>();
                for (RestModule m : modules) {
                    entries.add(entry(m, null, State.pending, null, null, 0));
                }
                snapshot = CatalogSnapshot.of(entries, List.of(), false, 0, modules.size(), ownVersion.get());
                current.set(snapshot);
                started = true;
                schedule(0);
            }
            return snapshot;
        }
    }

    /**
     * Rebuilds one module, or everything when moduleId is null. The current snapshot is marked incomplete at once,
     * so a client that reads the catalog right after the request sees the rebuild and follows it.
     */
    public void refresh(String moduleId) {
        synchronized (stalePlugins) {
            if (moduleId == null) {
                rebuildAll = true;
            } else {
                stalePlugins.add("module:" + moduleId);
            }
        }
        if (started) {
            current.updateAndGet(s -> s == null ? null : s.incomplete(ownVersion.get()));
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
        if (!started) {
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
        try {
            buildOnce();
        } catch (RuntimeException | LinkageError e) {
            LOGGER.warn("Building the REST API catalog failed; it is retried on the next change or refresh", e);
        }
    }

    private void buildOnce() {
        Set<String> stale;
        boolean all;
        synchronized (stalePlugins) {
            stale = new HashSet<>(stalePlugins);
            stalePlugins.clear();
            all = rebuildAll;
            rebuildAll = false;
        }
        boolean changed = all || current.get() == null || !current.get().complete();
        List<RestModule> modules = discovery.discover();
        Set<String> present = new HashSet<>();
        for (RestModule m : modules) {
            present.add(m.id());
        }
        changed |= built.keySet().removeIf(id -> !present.contains(id));
        // a module being rebuilt keeps its previous operations until the new ones are ready, so they never vanish
        // from the catalog (and from an open page) in between
        List<RestModule> todo = new ArrayList<>();
        for (RestModule m : modules) {
            Built b = built.get(m.id());
            if (all || b == null || stale.contains(m.pluginKey()) || stale.contains("module:" + m.id())) {
                todo.add(m);
            }
        }
        if (todo.isEmpty() && !changed) {
            return; // an event for a plugin without REST modules: nothing to publish
        }
        long lastPublish = System.currentTimeMillis();
        int done = modules.size() - todo.size();
        if (!todo.isEmpty()) {
            publish(modules, done, false);
        }
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

    /** Asks the sources in order; the first that describes the module wins, failures fall through to the next. */
    private Built describe(RestModule module) {
        String origin = product.origin(module.plugin());
        if (product.excluded(module)) {
            return failed(module, origin, "excluded",
                    "Not described: an API for applications with Crowd application credentials, not for users");
        }
        AtomicBoolean previous = stuck.get(module.id());
        if (previous != null) {
            if (previous.get()) {
                return failed(module, origin, "busy", "An earlier attempt is still running");
            }
            stuck.remove(module.id());
        }
        String reason = module.restV2() ? "no-source" : "rest-v1";
        String error = "No source describes this module";
        for (SpecSource source : sources) {
            AtomicBoolean running = new AtomicBoolean(true);
            Future<Optional<ModuleSpec>> future = describeThreads.submit(() -> {
                try {
                    return source.describe(module);
                } finally {
                    running.set(false);
                }
            });
            try {
                Optional<ModuleSpec> spec = future.get(MODULE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                if (spec.isPresent()) {
                    List<Operation> operations = OperationKeys.assign(module.id(), spec.get().operations());
                    return new Built(entry(module, origin, State.ok, null, null, operations.size())
                            .withSource(source.id()), operations);
                }
            } catch (TimeoutException e) {
                future.cancel(true);
                stuck.put(module.id(), running);
                return failed(module, origin, "timeout", source.id() + ": no answer within " + MODULE_TIMEOUT_MS + " ms");
            } catch (ExecutionException e) {
                Throwable cause = e.getCause();
                if (cause instanceof SpecException se) {
                    LOGGER.debug("{} couldn't describe {}", source.id(), module.id(), se);
                    reason = se.reason();
                    error = source.id() + ": " + se.getMessage();
                } else {
                    LOGGER.debug("{} failed on {}", source.id(), module.id(), cause);
                    reason = "error";
                    error = source.id() + ": " + cause;
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return failed(module, origin, "interrupted", "The build was stopped");
            }
        }
        return failed(module, origin, reason, error);
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

    private static ThreadFactory daemon(String name) {
        return r -> {
            Thread t = new Thread(r, name);
            t.setDaemon(true);
            return t;
        };
    }
}
