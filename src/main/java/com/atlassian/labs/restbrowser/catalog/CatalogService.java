package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.event.api.EventListener;
import com.atlassian.event.api.EventPublisher;
import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.ModuleSpec;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.State;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.labs.restbrowser.catalog.SpecSource.SpecException;
import com.atlassian.labs.restbrowser.spring.ServletContextHolder;
import com.atlassian.plugin.event.events.PluginDisabledEvent;
import com.atlassian.plugin.event.events.PluginEnabledEvent;
import com.atlassian.plugin.event.events.PluginModuleDisabledEvent;
import com.atlassian.plugin.event.events.PluginModuleEnabledEvent;
import jakarta.servlet.ServletContext;
import org.slf4j.Logger;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.InitializingBean;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.Semaphore;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

import static java.util.Objects.requireNonNull;
import static org.slf4j.LoggerFactory.getLogger;

/**
 * Builds and holds the catalog of this node's REST API.
 * <p>
 * Built on first use, never holding {@link RestModule} / {@code Plugin} / {@code ModuleDescriptor} references beyond a
 * single build or single-module read so uninstalled/reloaded plugin classloaders can be garbage-collected freely.
 */
public class CatalogService implements InitializingBean, DisposableBean {

    private static final Logger LOGGER = getLogger(CatalogService.class);

    static final long PUBLISH_EVERY_MS = 3_000;
    static final long PAUSE_BETWEEN_MODULES_MS = 10;
    static final long MODULE_TIMEOUT_MS = 30_000;
    static final long DEBOUNCE_MS = 3_000;
    private static final int MAX_DESCRIBE_THREADS = 8;
    private static final int TASK_PENDING = 0;
    private static final int TASK_RUNNING = 1;
    private static final int TASK_DONE = 2;
    private static final int TASK_CANCELLED = 3;

    private final ModuleDiscovery discovery;
    private final List<SpecSource> sources;
    private final ProductAdapter product;
    private final EventPublisher eventPublisher;
    private final Supplier<String> ownVersion;
    private final ServletContextHolder contextHolder;

    private final AtomicReference<CatalogSnapshot> current = new AtomicReference<>();
    private volatile boolean started;
    /** Results per module id; only touched by the build thread. Pre-serialized ops prevent O(N^2) rebuild churn. */
    private final Map<String, Built> built = new LinkedHashMap<>();
    /** Flagged calls that timed out while running; pruned alongside {@link #built}. */
    private final Map<String, AtomicInteger> stuck = new HashMap<>();
    private final Set<String> stalePlugins = new HashSet<>();
    private boolean rebuildAll;

    private volatile ScheduledExecutorService buildThread;
    private volatile ExecutorService describeThreads;
    private ScheduledFuture<?> pending;
    private boolean pendingImmediate;
    private volatile long debounceMs = DEBOUNCE_MS;
    private volatile long pauseBetweenModulesMs = PAUSE_BETWEEN_MODULES_MS;

    void setTimingForTests(long debounceMs, long pauseBetweenModulesMs) {
        this.debounceMs = Math.max(0L, debounceMs);
        this.pauseBetweenModulesMs = Math.max(0L, pauseBetweenModulesMs);
    }

    private record BuiltOp(Operation op, String json) {
    }

    private record Built(ModuleEntry entry, List<BuiltOp> operations) {
    }

    public enum StartOutcome {
        READ,
        STILL_NOT_STARTED,
        QUEUED,
        UNKNOWN,
        FAILED
    }

    public record Started(StartOutcome outcome, ModuleEntry entry) {
    }

    private final Map<String, Future<ModuleEntry>> startedReads = new ConcurrentHashMap<>();
    private final Semaphore startWaiters = new Semaphore(4);

    public CatalogService(ModuleDiscovery discovery, List<SpecSource> sources, ProductAdapter product,
                          EventPublisher eventPublisher, Supplier<String> ownVersion) {
        this(discovery, sources, product, eventPublisher, ownVersion, new ServletContextHolder());
    }

    public CatalogService(ModuleDiscovery discovery, List<SpecSource> sources, ProductAdapter product,
                          EventPublisher eventPublisher, Supplier<String> ownVersion,
                          ServletContextHolder contextHolder) {
        this.discovery = requireNonNull(discovery);
        this.sources = List.copyOf(sources);
        this.product = requireNonNull(product);
        this.eventPublisher = eventPublisher;
        this.ownVersion = requireNonNull(ownVersion);
        this.contextHolder = requireNonNull(contextHolder);
    }

    @Override
    public void afterPropertiesSet() {
        buildThread = Executors.newSingleThreadScheduledExecutor(daemon("rest-api-browser-catalog"));
        describeThreads = new ThreadPoolExecutor(
                0, MAX_DESCRIBE_THREADS, 30L, TimeUnit.SECONDS,
                new SynchronousQueue<>(), numberedDaemon("rest-api-browser-describe"));
        if (eventPublisher != null) {
            eventPublisher.register(this);
        }
    }

    @Override
    public synchronized void destroy() {
        if (eventPublisher != null) {
            eventPublisher.unregister(this);
        }
        ScheduledExecutorService bt = buildThread;
        if (bt != null) {
            bt.shutdownNow();
        }
        startedReads.values().forEach(read -> read.cancel(false));
        ExecutorService dt = describeThreads;
        if (dt != null) {
            dt.shutdownNow();
        }
    }

    public JerseyModelSource jersey() {
        for (SpecSource source : sources) {
            if (source instanceof JerseyModelSource j) {
                return j;
            }
        }
        return null;
    }

    public ServletContext servletContext() {
        return contextHolder.get();
    }

    /** Returns the latest snapshot if a build has already started, or {@code null} without triggering one. */
    public CatalogSnapshot peek() {
        return current.get();
    }

    public CatalogSnapshot current(ServletContext context) {
        contextHolder.setIfAbsent(context);
        CatalogSnapshot snapshot = current.get();
        if (snapshot != null) {
            return snapshot;
        }
        synchronized (this) {
            snapshot = current.get();
            if (snapshot == null) {
                List<RestModule> modules = discovery.discover();
                List<ModuleEntry> entries = new ArrayList<>(modules.size());
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

    public void refresh(String moduleId) {
        synchronized (stalePlugins) {
            if (moduleId == null) {
                rebuildAll = true;
            } else {
                stalePlugins.add("module:" + moduleId);
            }
            if (started) {
                current.updateAndGet(s -> s == null ? null : s.incomplete(ownVersion.get()));
            }
        }
        if (started) {
            schedule(0);
        }
    }

    public Started readStarted(String moduleId, long waitMs) {
        if (moduleId == null || moduleId.isBlank()) {
            return new Started(StartOutcome.UNKNOWN, null);
        }
        RestModule module = findModule(discovery.discover(), moduleId);
        if (module == null) {
            return new Started(StartOutcome.UNKNOWN, null);
        }
        JerseyModelSource jersey = jersey();
        if (jersey != null && !jersey.started(module)) {
            return new Started(StartOutcome.STILL_NOT_STARTED, null);
        }
        ScheduledExecutorService thread = buildThread;
        if (thread == null || thread.isShutdown()) {
            return new Started(StartOutcome.FAILED, null);
        }
        Future<ModuleEntry> read;
        try {
            read = startedReads.computeIfAbsent(moduleId, id -> thread.submit(() -> readOne(id)));
        } catch (RejectedExecutionException e) {
            return new Started(StartOutcome.FAILED, null);
        }
        if (!startWaiters.tryAcquire()) {
            return new Started(StartOutcome.QUEUED, null);
        }
        try {
            ModuleEntry entry = read.get(waitMs, TimeUnit.MILLISECONDS);
            return entry == null ? new Started(StartOutcome.UNKNOWN, null) : new Started(StartOutcome.READ, entry);
        } catch (CancellationException e) {
            return new Started(StartOutcome.FAILED, null);
        } catch (TimeoutException e) {
            return new Started(StartOutcome.QUEUED, null);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return new Started(StartOutcome.QUEUED, null);
        } catch (ExecutionException e) {
            LOGGER.warn("Reading the started module {} failed", moduleId, e.getCause());
            return new Started(StartOutcome.FAILED, null);
        } finally {
            startWaiters.release();
        }
    }

    /**
     * Runs on the build thread only. Always removes {@code moduleId} from {@link #startedReads} inside
     * {@code finally} — even if discovery or describe throws — so {@link #moreQueued()} can never stay stuck true.
     */
    private ModuleEntry readOne(String moduleId) {
        List<RestModule> modules = null;
        boolean needRediscover = false;
        try {
            modules = discovery.discover();
            RestModule fresh = findModule(modules, moduleId);
            Built previous = built.get(moduleId);
            if (fresh == null || (previous != null && !waitingToStart(previous.entry()))) {
                return fresh == null ? null : previous.entry();
            }
            Built b = describe(fresh);
            if (Thread.currentThread().isInterrupted()) {
                return previous == null ? null : previous.entry();
            }
            needRediscover = true;
            built.put(moduleId, b);
            return b.entry();
        } finally {
            startedReads.remove(moduleId);
            if (!Thread.currentThread().isInterrupted()) {
                try {
                    CatalogSnapshot snap = current.get();
                    if (needRediscover || snap == null || !snap.complete()) {
                        List<RestModule> publishModules = needRediscover || modules == null ? discovery.discover() : modules;
                        publishDone(publishModules);
                    }
                } catch (RuntimeException | LinkageError e) {
                    LOGGER.warn("Publishing snapshot after reading started module {} failed", moduleId, e);
                }
            }
        }
    }

    private static RestModule findModule(List<RestModule> modules, String id) {
        for (RestModule m : modules) {
            if (m.id().equals(id)) {
                return m;
            }
        }
        return null;
    }

    private static boolean waitingToStart(ModuleEntry e) {
        return e.state() == State.failed && JerseyModelSource.NOT_STARTED.equals(e.reason());
    }

    private void publishDone(List<RestModule> modules) {
        int done = 0;
        for (RestModule m : modules) {
            if (built.containsKey(m.id())) {
                done++;
            }
        }
        boolean all = done == modules.size();
        CatalogSnapshot snapshot = snapshotOf(modules, done, all);
        synchronized (stalePlugins) {
            if (!all || !moreQueued()) {
                current.set(snapshot);
                return;
            }
        }
        publish(modules, done, false);
    }

    private boolean moreQueued() {
        synchronized (stalePlugins) {
            return rebuildAll || !stalePlugins.isEmpty() || !startedReads.isEmpty();
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
        if (!started || pluginKey == null) {
            return;
        }
        synchronized (stalePlugins) {
            stalePlugins.add(pluginKey);
        }
        schedule(debounceMs);
    }

    private synchronized void schedule(long delayMs) {
        ScheduledExecutorService bt = buildThread;
        if (bt == null || bt.isShutdown()) {
            return;
        }
        if (pending != null && !pending.isDone()) {
            if (delayMs > 0 && pendingImmediate) {
                return;
            }
            pending.cancel(false);
        }
        try {
            pendingImmediate = delayMs <= 0;
            pending = bt.schedule(this::build, delayMs, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException ignored) {
            pendingImmediate = false;
            // concurrent shutdown between check and schedule
        }
    }

    /** Runs on the build thread only. */
    void build() {
        synchronized (this) {
            pending = null;
            pendingImmediate = false;
        }
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
        CatalogSnapshot curSnap = current.get();
        boolean changed = all || curSnap == null || !curSnap.complete();
        List<RestModule> modules = discovery.discover();
        Set<String> present = new HashSet<>(modules.size() * 2);
        for (RestModule m : modules) {
            present.add(m.id());
        }
        changed |= built.keySet().removeIf(id -> !present.contains(id));
        stuck.keySet().removeIf(id -> !present.contains(id));

        List<RestModule> todo = new ArrayList<>();
        for (RestModule m : modules) {
            Built b = built.get(m.id());
            if (all || b == null || stale.contains(m.pluginKey()) || stale.contains("module:" + m.id())) {
                todo.add(m);
            }
        }
        if (todo.isEmpty() && !changed) {
            return;
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
            Built b = describe(m);
            if (Thread.currentThread().isInterrupted()) {
                return;
            }
            built.put(m.id(), b);
            done++;
            if (System.currentTimeMillis() - lastPublish >= PUBLISH_EVERY_MS) {
                publish(modules, done, false);
                lastPublish = System.currentTimeMillis();
            }
            pause();
        }
        if (Thread.currentThread().isInterrupted()) {
            return;
        }
        publishDone(modules);
    }

    private Built describe(RestModule module) {
        String origin = product.origin(module.plugin());
        if (product.excluded(module)) {
            return failed(module, origin, "excluded",
                    "Not described: an API for applications with Crowd application credentials, not for users");
        }
        AtomicInteger previous = stuck.get(module.id());
        if (previous != null) {
            if (previous.get() == TASK_RUNNING) {
                return failed(module, origin, "busy", "An earlier attempt is still running");
            }
            stuck.remove(module.id());
        }
        ExecutorService executor = describeThreads;
        if (executor == null || executor.isShutdown()) {
            return failed(module, origin, "interrupted", "The build was stopped");
        }
        String reason = module.restV2() ? "no-source" : "rest-v1";
        String error = "No source describes this module";
        for (SpecSource source : sources) {
            AtomicInteger state = new AtomicInteger(TASK_PENDING);
            Future<Optional<ModuleSpec>> future;
            try {
                future = executor.submit(() -> {
                    if (!state.compareAndSet(TASK_PENDING, TASK_RUNNING)) {
                        return Optional.empty();
                    }
                    try {
                        return source.describe(module);
                    } finally {
                        state.set(TASK_DONE);
                    }
                });
            } catch (RejectedExecutionException e) {
                if (executor.isShutdown()) {
                    return failed(module, origin, "interrupted", "The build was stopped");
                }
                return failed(module, origin, "busy", "Too many modules are currently timing out");
            }
            try {
                Optional<ModuleSpec> spec = future.get(MODULE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
                if (spec.isPresent()) {
                    List<Operation> ops = OperationKeys.assign(module.id(), spec.get().operations());
                    List<BuiltOp> serialized = new ArrayList<>(ops.size());
                    for (Operation op : ops) {
                        serialized.add(new BuiltOp(op, CatalogSnapshot.serializeOperation(op)));
                    }
                    return new Built(entry(module, origin, State.ok, null, null, ops.size())
                            .withSource(source.id()), serialized);
                }
            } catch (TimeoutException e) {
                future.cancel(true);
                if (!state.compareAndSet(TASK_PENDING, TASK_CANCELLED) && state.get() == TASK_RUNNING) {
                    stuck.put(module.id(), state);
                }
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
                future.cancel(true);
                state.compareAndSet(TASK_PENDING, TASK_CANCELLED);
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
        current.set(snapshotOf(modules, done, complete));
    }

    private CatalogSnapshot snapshotOf(List<RestModule> modules, int done, boolean complete) {
        List<ModuleEntry> entries = new ArrayList<>(modules.size());
        List<BuiltOp> allOps = new ArrayList<>();
        for (RestModule m : modules) {
            Built b = built.get(m.id());
            if (b == null) {
                entries.add(entry(m, null, State.pending, null, null, 0));
            } else {
                entries.add(b.entry());
                allOps.addAll(b.operations());
            }
        }
        allOps.sort(Comparator.comparing(bo -> bo.op().key()));
        List<Operation> opsList = new ArrayList<>(allOps.size());
        List<String> jsonList = new ArrayList<>(allOps.size());
        for (BuiltOp bo : allOps) {
            opsList.add(bo.op());
            jsonList.add(bo.json());
        }
        return CatalogSnapshot.ofPreserialized(entries, opsList, jsonList, complete, done, modules.size(), ownVersion.get());
    }

    private void pause() {
        long ms = pauseBetweenModulesMs;
        if (ms <= 0) {
            return;
        }
        try {
            Thread.sleep(ms);
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

    private static ThreadFactory numberedDaemon(String prefix) {
        AtomicInteger seq = new AtomicInteger(1);
        return r -> {
            Thread t = new Thread(r, prefix + "-" + seq.getAndIncrement());
            t.setDaemon(true);
            return t;
        };
    }
}
