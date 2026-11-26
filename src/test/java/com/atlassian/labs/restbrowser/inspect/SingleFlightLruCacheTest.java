package com.atlassian.labs.restbrowser.inspect;

import com.atlassian.labs.restbrowser.inspect.SingleFlightLruCache.CacheBusyException;
import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class SingleFlightLruCacheTest {

    @Test
    public void coalescesConcurrentMissesAndTracksHits() throws Exception {
        SingleFlightLruCache<String, String> cache = new SingleFlightLruCache<>(4, 2, 5_000);
        AtomicInteger calls = new AtomicInteger();
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);

        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            boolean[] hit1 = new boolean[1];
            boolean[] hit2 = new boolean[1];
            Future<String> f1 = pool.submit(() -> cache.getOrCompute("k1", () -> {
                calls.incrementAndGet();
                entered.countDown();
                try {
                    release.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return "v1";
            }, hit1));
            assertTrue(entered.await(5, TimeUnit.SECONDS));
            Future<String> f2 = pool.submit(() -> cache.getOrCompute("k1", () -> {
                calls.incrementAndGet();
                return "unexpected";
            }, hit2));

            Thread.sleep(50);
            release.countDown();
            assertEquals("v1", f1.get(5, TimeUnit.SECONDS));
            assertEquals("v1", f2.get(5, TimeUnit.SECONDS));
            assertEquals(1, calls.get());
            assertFalse(hit1[0]);
            assertTrue(hit2[0]);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    public void permitTimeoutThrowsCacheBusyAndWaiterRetriesWhenLeaderAborts() throws Exception {
        SingleFlightLruCache<String, String> cache = new SingleFlightLruCache<>(4, 1, 80);
        CountDownLatch holderEntered = new CountDownLatch(1);
        CountDownLatch holderRelease = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(3);
        try {
            Future<String> holder = pool.submit(() -> cache.getOrCompute("busy", () -> {
                holderEntered.countDown();
                try {
                    holderRelease.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return "done";
            }, null));
            assertTrue(holderEntered.await(5, TimeUnit.SECONDS));

            // Second key hits 1-permit limit and throws CacheBusyException quickly
            assertThrows(CacheBusyException.class, () -> cache.getOrCompute("k2", () -> "x", null));

            // Coalesced followers waiting on a key whose leader times out fail once rather than multiplying wait time
            Future<String> leader = pool.submit(() -> cache.getOrCompute("contended", () -> "never", null));
            Future<String> follower = pool.submit(() -> cache.getOrCompute("contended", () -> "never", null));
            long startNs = System.nanoTime();
            try {
                leader.get(5, TimeUnit.SECONDS);
            } catch (Exception expected) {
                assertTrue(expected.getCause() instanceof CacheBusyException);
            }
            try {
                follower.get(5, TimeUnit.SECONDS);
            } catch (Exception expected) {
                assertTrue(expected.getCause() instanceof CacheBusyException);
            }
            long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNs);
            assertTrue("Bounded wait expected near 80ms, was " + elapsedMs + "ms", elapsedMs < 400);

            holderRelease.countDown();
            assertEquals("done", holder.get(5, TimeUnit.SECONDS));

            // Interrupted leader before permit does not permanently fail coalesced waiters
            Thread.currentThread().interrupt();
            try {
                assertThrows(CacheBusyException.class, () -> cache.getOrCompute("k3", () -> "never", null));
            } finally {
                Thread.interrupted();
            }
            assertEquals("recovered", cache.getOrCompute("k3", () -> "recovered", null));
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    public void evictsOldestWhenCapacityExceeded() {
        SingleFlightLruCache<String, String> cache = new SingleFlightLruCache<>(2, 2, 1_000);
        cache.getOrCompute("a", () -> "1", null);
        cache.getOrCompute("b", () -> "2", null);
        cache.get("a"); // refresh a
        cache.getOrCompute("c", () -> "3", null); // evicts b
        assertEquals("1", cache.get("a"));
        assertEquals(null, cache.get("b"));
        assertEquals("3", cache.get("c"));
    }
}
