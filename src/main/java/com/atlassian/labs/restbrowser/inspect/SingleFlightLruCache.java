package com.atlassian.labs.restbrowser.inspect;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;

/**
 * Bounded LRU cache with per-key single-flight request coalescing and bounded compute concurrency.
 * <p>
 * Eliminates cache stampedes when concurrent callers request the same un-cached decompilation or inspection,
 * and caps simultaneous expensive computations to protect servlet container worker pools.
 */
public final class SingleFlightLruCache<K, V> {

    public static final class CacheBusyException extends IllegalStateException {
        public CacheBusyException(String message) {
            super(message);
        }

        public CacheBusyException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    private static final class LeaderAbortedException extends RuntimeException {
        LeaderAbortedException(Throwable cause) {
            super(cause);
        }
    }

    private final Map<K, V> cache;
    private final ConcurrentHashMap<K, CompletableFuture<V>> inflight = new ConcurrentHashMap<>();
    private final Semaphore permits;
    private final long acquireTimeoutMs;

    public SingleFlightLruCache(int maxEntries, int maxConcurrentComputes, long acquireTimeoutMs) {
        this.cache = Collections.synchronizedMap(new LinkedHashMap<>(maxEntries, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<K, V> eldest) {
                return size() > maxEntries;
            }
        });
        this.permits = maxConcurrentComputes > 0 ? new Semaphore(maxConcurrentComputes) : null;
        this.acquireTimeoutMs = acquireTimeoutMs;
    }

    public V get(K key) {
        return cache.get(key);
    }

    /**
     * Returns the cached value if present; otherwise joins an active computation for {@code key} or runs
     * {@code loader} under the concurrency permit. {@code hitOut[0]} is set to {@code true} when served from cache.
     */
    public V getOrCompute(K key, Supplier<V> loader, boolean[] hitOut) {
        final long deadlineNanos = acquireTimeoutMs > 0
                ? System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(acquireTimeoutMs)
                : 0L;
        while (true) {
            V cached = cache.get(key);
            if (cached != null) {
                setHit(hitOut, true);
                return cached;
            }
            CompletableFuture<V> created = new CompletableFuture<>();
            CompletableFuture<V> existing = inflight.putIfAbsent(key, created);
            if (existing != null) {
                try {
                    V result;
                    if (acquireTimeoutMs > 0) {
                        long remMs = Math.max(0L, TimeUnit.NANOSECONDS.toMillis(deadlineNanos - System.nanoTime()));
                        result = existing.get(remMs, TimeUnit.MILLISECONDS);
                    } else {
                        result = existing.get();
                    }
                    setHit(hitOut, result != null);
                    return result;
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new CacheBusyException("Interrupted while waiting for slot", e);
                } catch (TimeoutException e) {
                    throw new CacheBusyException("Too many concurrent operations; timed out waiting for slot", e);
                } catch (ExecutionException e) {
                    Throwable cause = e.getCause();
                    if (cause instanceof LeaderAbortedException) {
                        continue;
                    }
                    throw rethrow(cause);
                }
            }
            try {
                if (permits != null) {
                    boolean acquired;
                    try {
                        if (acquireTimeoutMs > 0) {
                            long remNanos = deadlineNanos - System.nanoTime();
                            acquired = remNanos > 0L && permits.tryAcquire(remNanos, TimeUnit.NANOSECONDS);
                        } else {
                            acquired = permits.tryAcquire();
                        }
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        inflight.remove(key, created);
                        created.completeExceptionally(new LeaderAbortedException(e));
                        throw new CacheBusyException("Interrupted while waiting for slot", e);
                    }
                    if (!acquired) {
                        CacheBusyException busy = new CacheBusyException("Too many concurrent operations; timed out waiting for slot");
                        inflight.remove(key, created);
                        created.completeExceptionally(busy);
                        throw busy;
                    }
                }
                try {
                    // Re-check cache after acquiring permit in case another flight completed before us
                    V afterPermit = cache.get(key);
                    if (afterPermit != null) {
                        setHit(hitOut, true);
                        created.complete(afterPermit);
                        return afterPermit;
                    }
                    setHit(hitOut, false);
                    V computed = loader.get();
                    if (computed != null) {
                        cache.put(key, computed);
                    }
                    created.complete(computed);
                    return computed;
                } finally {
                    if (permits != null) {
                        permits.release();
                    }
                }
            } catch (RuntimeException | Error e) {
                inflight.remove(key, created);
                if (!created.isDone()) {
                    created.completeExceptionally(e);
                }
                throw e;
            } finally {
                inflight.remove(key, created);
            }
        }
    }

    private static void setHit(boolean[] hitOut, boolean value) {
        if (hitOut != null && hitOut.length > 0) {
            hitOut[0] = value;
        }
    }

    private static RuntimeException rethrow(Throwable t) {
        if (t instanceof RuntimeException re) {
            return re;
        }
        if (t instanceof Error err) {
            throw err;
        }
        return new RuntimeException(t);
    }
}
