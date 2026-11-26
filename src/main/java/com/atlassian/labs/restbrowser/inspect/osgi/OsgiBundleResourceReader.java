package com.atlassian.labs.restbrowser.inspect.osgi;

import org.osgi.framework.Bundle;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Safe read-only OSGi bundle resource enumerator and UTF-8 content reader (zero host filesystem access, strictly
 * scoped via {@link Bundle#getEntry(String)} / {@link Bundle#findEntries(String, String, boolean)}). Zero Atlassian coupling.
 */
public final class OsgiBundleResourceReader {

    public static final int MAX_RESOURCE_BYTES = 262_144;
    public static final int MAX_LIST_ENTRIES = 300;
    public static final int MAX_PATH_LEN = 500;

    private static final Set<String> BINARY_EXTENSIONS = Set.of(
            ".class", ".jar", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
            ".woff", ".woff2", ".ttf", ".eot", ".pdf", ".so", ".dll", ".exe", ".bin", ".gz"
    );

    public record ResourceEntry(String path, String kind) {
    }

    public record ResourceList(List<ResourceEntry> entries, boolean truncated) {
    }

    public record ResourceContent(String path, String content, int bytes, boolean truncated,
                                  String errorCode, String hint) {
        public boolean ok() {
            return errorCode == null;
        }
    }

    private OsgiBundleResourceReader() {
    }

    /**
     * Validates and normalizes an archive-relative resource path, returning {@code null} on blank, traversal
     * ({@code ..}), backslash, control character, colon, or overlong paths.
     */
    public static String sanitizePath(String rawPath) {
        if (rawPath == null || rawPath.isBlank() || rawPath.length() > MAX_PATH_LEN) {
            return null;
        }
        for (int i = 0; i < rawPath.length(); i++) {
            char c = rawPath.charAt(i);
            if (c < 0x20 || c == '\\' || c == ':') {
                return null;
            }
        }
        String trimmed = rawPath.trim();
        while (trimmed.startsWith("/")) {
            trimmed = trimmed.substring(1);
        }
        if (trimmed.isEmpty() || trimmed.equals("..") || trimmed.contains("../") || trimmed.contains("/..")
                || trimmed.endsWith("/")) {
            return null;
        }
        return trimmed;
    }

    /** Classifies a bundle entry path into a concise agent-friendly resource kind. */
    public static String classifyKind(String path) {
        String low = path.toLowerCase(Locale.ROOT);
        if ("atlassian-plugin.xml".equals(low) || "meta-inf/manifest.mf".equals(low)
                || low.startsWith("meta-inf/spring/")) {
            return "descriptor";
        }
        if (low.endsWith(".vm") || low.endsWith(".soy") || low.endsWith(".ftl") || low.endsWith(".jsp")
                || low.endsWith(".html") || low.endsWith(".htm")) {
            return "template";
        }
        if (low.endsWith(".properties")) {
            return "i18n";
        }
        if (low.endsWith(".js") || low.endsWith(".mjs") || low.endsWith(".css") || low.endsWith(".svg")) {
            return "web";
        }
        if (low.endsWith(".xml") || low.endsWith(".json") || low.endsWith(".yaml") || low.endsWith(".yml")) {
            return "config";
        }
        return "other";
    }

    public static ResourceList listResources(Bundle bundle, String prefix, int rawLimit) {
        if (bundle == null) {
            return new ResourceList(List.of(), false);
        }
        int limit = Math.max(1, Math.min(MAX_LIST_ENTRIES, rawLimit <= 0 ? 100 : rawLimit));
        String normPrefix = prefix == null ? "" : prefix.trim();
        while (normPrefix.startsWith("/")) {
            normPrefix = normPrefix.substring(1);
        }
        if (normPrefix.contains("..") || normPrefix.contains("\\")) {
            return new ResourceList(List.of(), false);
        }

        List<String> paths = new ArrayList<>();
        try {
            Enumeration<URL> entries = bundle.findEntries("/", "*", true);
            if (entries != null) {
                while (entries.hasMoreElements()) {
                    URL url = entries.nextElement();
                    String p = url == null ? null : url.getPath();
                    if (p == null) {
                        continue;
                    }
                    while (p.startsWith("/")) {
                        p = p.substring(1);
                    }
                    if (p.isEmpty() || p.endsWith("/") || p.endsWith(".class")) {
                        continue;
                    }
                    if (!normPrefix.isEmpty() && !p.startsWith(normPrefix)) {
                        continue;
                    }
                    paths.add(p);
                }
            }
        } catch (RuntimeException | LinkageError ignored) {
            // bundle transitioned concurrently
        }

        paths.sort(Comparator.naturalOrder());
        boolean truncated = paths.size() > limit;
        List<ResourceEntry> out = new ArrayList<>(Math.min(paths.size(), limit));
        for (int i = 0; i < Math.min(paths.size(), limit); i++) {
            String p = paths.get(i);
            out.add(new ResourceEntry(p, classifyKind(p)));
        }
        return new ResourceList(List.copyOf(out), truncated);
    }

    public static ResourceContent readResource(Bundle bundle, String rawPath, int rawMaxBytes) {
        String cleanPath = sanitizePath(rawPath);
        if (cleanPath == null) {
            return new ResourceContent(rawPath, null, 0, false, "invalid-path",
                    "Pass a clean archive-relative path without '..', backslashes, or colons.");
        }
        String low = cleanPath.toLowerCase(Locale.ROOT);
        if (low.endsWith(".class")) {
            return new ResourceContent(cleanPath, null, 0, false, "binary-resource",
                    "Use /rest/restbrowser/1/code/source to decompile .class files.");
        }
        for (String ext : BINARY_EXTENSIONS) {
            if (low.endsWith(ext)) {
                return new ResourceContent(cleanPath, null, 0, false, "binary-resource",
                        "Binary resource (" + ext + ") cannot be rendered as UTF-8 text.");
            }
        }
        if (bundle == null) {
            return new ResourceContent(cleanPath, null, 0, false, "bundle-not-found", null);
        }
        URL entry;
        try {
            entry = bundle.getEntry(cleanPath);
        } catch (RuntimeException | LinkageError e) {
            return new ResourceContent(cleanPath, null, 0, false, "bundle-not-found", null);
        }
        if (entry == null) {
            return new ResourceContent(cleanPath, null, 0, false, "resource-not-found",
                    "Omit &path= to list available text entries in bundle #" + bundle.getBundleId() + ".");
        }
        int maxBytes = Math.max(1, Math.min(MAX_RESOURCE_BYTES, rawMaxBytes <= 0 ? MAX_RESOURCE_BYTES : rawMaxBytes));
        try (InputStream in = entry.openStream()) {
            return readStream(cleanPath, in, maxBytes);
        } catch (IOException | RuntimeException e) {
            return new ResourceContent(cleanPath, null, 0, false, "read-failed", null);
        }
    }

    /** Reads a bounded UTF-8 stream, rejecting NUL-containing binary payloads. */
    public static ResourceContent readStream(String cleanPath, InputStream in, int rawMaxBytes) throws IOException {
        if (in == null) {
            return new ResourceContent(cleanPath, null, 0, false, "resource-not-found", null);
        }
        int maxBytes = Math.max(1, Math.min(MAX_RESOURCE_BYTES, rawMaxBytes <= 0 ? MAX_RESOURCE_BYTES : rawMaxBytes));
        ByteArrayOutputStream out = new ByteArrayOutputStream(Math.min(maxBytes, 8192));
        byte[] buf = new byte[4096];
        int total = 0;
        boolean truncated = false;
        int n;
        while ((n = in.read(buf)) >= 0) {
            if (n == 0) {
                continue;
            }
            if (total < 4096) {
                int sniffEnd = Math.min(n, 4096 - total);
                for (int i = 0; i < sniffEnd; i++) {
                    if (buf[i] == 0) {
                        return new ResourceContent(cleanPath, null, 0, false, "binary-resource",
                                "Binary NUL bytes detected; cannot render as text.");
                    }
                }
            }
            int remaining = maxBytes - total;
            if (remaining <= 0) {
                truncated = true;
                break;
            }
            int keep = Math.min(n, remaining);
            out.write(buf, 0, keep);
            total += keep;
            if (n > remaining) {
                truncated = true;
                break;
            }
        }
        return new ResourceContent(cleanPath, out.toString(StandardCharsets.UTF_8), total, truncated, null, null);
    }
}
