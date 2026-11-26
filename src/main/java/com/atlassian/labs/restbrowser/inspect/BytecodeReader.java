package com.atlassian.labs.restbrowser.inspect;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.util.Objects;

/**
 * Bounded, loader-isolated class bytecode reader.
 * <p>
 * Unlike {@link ClassLoader#getResourceAsStream(String)} combined with an implicit system fallback,
 * {@link #readFromLoaderOnly(ClassLoader, String)} checks only the supplied loader so JDK/system classes are never
 * misattributed to an unrelated plugin bundle classloader.
 */
public final class BytecodeReader {

    /** Hard cap per single {@code .class} file to guard against memory exhaustion. */
    public static final int MAX_CLASS_BYTES = 4 * 1024 * 1024;

    private BytecodeReader() {
    }

    /** Returns true when {@code resourcePath} exists on {@code loader} (falling back to system/JDK only if loader is null). */
    public static boolean exists(ClassLoader loader, String resourcePath) {
        if (resourcePath == null) {
            return false;
        }
        if (loader != null) {
            if (loader.getResource(resourcePath) != null) {
                return true;
            }
        }
        return ClassLoader.getSystemResource(resourcePath) != null
                || Object.class.getResource("/" + resourcePath) != null;
    }

    /**
     * Reads bytes using the given loader if present, otherwise falling back to the system/platform/JDK bootstrap
     * resources (suitable for decompiler library lookups, never for bundle ownership attribution).
     */
    public static byte[] readWithFallback(ClassLoader loader, String resourcePath) {
        byte[] direct = readFromLoaderOnly(loader, resourcePath);
        return direct != null ? direct : readSystemOrJdk(resourcePath);
    }

    /** Reads bytes strictly from {@code loader}; never falls back to system or boot classloaders. */
    public static byte[] readFromLoaderOnly(ClassLoader loader, String resourcePath) {
        if (loader == null || resourcePath == null) {
            return null;
        }
        // Only treat the resource as owned by this loader if the loader resolves a URL (parent delegation may still
        // find bootstrap resources, so callers that care about bundle attribution check Class<?> / bundle first).
        try (InputStream in = loader.getResourceAsStream(resourcePath)) {
            return in == null ? null : readCapped(in, MAX_CLASS_BYTES);
        } catch (IOException e) {
            return null;
        }
    }

    /** Reads bytes directly from a resolved {@link URL} (such as an OSGi bundle entry). */
    public static byte[] readUrl(URL url) {
        if (url == null) {
            return null;
        }
        try (InputStream in = url.openStream()) {
            return readCapped(in, MAX_CLASS_BYTES);
        } catch (IOException e) {
            return null;
        }
    }

    /** Reads bytes strictly from system/JDK bootstrap classloaders. */
    public static byte[] readSystemOrJdk(String resourcePath) {
        if (resourcePath == null) {
            return null;
        }
        try (InputStream sys = ClassLoader.getSystemResourceAsStream(resourcePath)) {
            if (sys != null) {
                return readCapped(sys, MAX_CLASS_BYTES);
            }
        } catch (IOException ignored) {
            // fall through
        }
        try (InputStream jdk = Object.class.getResourceAsStream("/" + resourcePath)) {
            return jdk == null ? null : readCapped(jdk, MAX_CLASS_BYTES);
        } catch (IOException e) {
            return null;
        }
    }

    /** Checks whether {@code resourcePath} resolves directly via system/JDK rather than a child loader's parent delegation. */
    public static boolean isBootOrSystemResource(String resourcePath) {
        return ClassLoader.getSystemResource(resourcePath) != null
                || Object.class.getResource("/" + resourcePath) != null;
    }

    static byte[] readCapped(InputStream in, int maxBytes) throws IOException {
        Objects.requireNonNull(in, "in");
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int total = 0;
        int n;
        while ((n = in.read(buf)) >= 0) {
            total += n;
            if (total > maxBytes) {
                throw new IOException("Class bytecode exceeds cap of " + maxBytes + " bytes");
            }
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }
}
