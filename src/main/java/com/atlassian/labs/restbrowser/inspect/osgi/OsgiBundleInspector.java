package com.atlassian.labs.restbrowser.inspect.osgi;

import com.atlassian.labs.restbrowser.json.Json;
import org.osgi.framework.Bundle;
import org.osgi.framework.BundleContext;
import org.osgi.framework.FrameworkUtil;
import org.osgi.framework.wiring.BundleCapability;
import org.osgi.framework.wiring.BundleRevision;
import org.osgi.framework.wiring.BundleWire;
import org.osgi.framework.wiring.BundleWiring;

import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Dictionary;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/**
 * Shared OSGi bundle inspection and JSON serializer. Uses unlocalized {@link Bundle#getHeaders(String) b.getHeaders("")}
 * to avoid bundle manifest localization overhead and safely handles null dictionaries/wirings during live refreshes.
 */
public final class OsgiBundleInspector {

    public static final int MAX_PACKAGES = 500;
    public static final int MAX_TEXT = 500;

    public static final List<String> HEADERS = List.of(
            "Bundle-Name", "Bundle-Vendor", "Bundle-Description", "Bundle-DocURL",
            "Bundle-License", "Atlassian-Plugin-Key", "Atlassian-Build-Date", "Spring-Context", "Bundle-ClassPath",
            "DynamicImport-Package", "Require-Capability", "Created-By", "Build-Jdk-Spec");

    private OsgiBundleInspector() {
    }

    public static Bundle bundleOf(Class<?> c) {
        try {
            return c == null ? null : FrameworkUtil.getBundle(c);
        } catch (RuntimeException | LinkageError e) {
            return null;
        }
    }

    public static Bundle bundleForPluginKey(String pluginKey, String symbolicNameFallback) {
        if (pluginKey == null || pluginKey.isBlank()) {
            return null;
        }
        try {
            Bundle self = FrameworkUtil.getBundle(OsgiBundleInspector.class);
            BundleContext ctx = self == null ? null : self.getBundleContext();
            if (ctx == null) {
                return null;
            }
            for (Bundle b : ctx.getBundles()) {
                try {
                    Dictionary<String, String> headers = rawHeaders(b);
                    String key = headers == null ? null : headers.get("Atlassian-Plugin-Key");
                    if (pluginKey.equals(key == null ? null : key.trim())
                            || (symbolicNameFallback != null && symbolicNameFallback.equals(b.getSymbolicName()))) {
                        return b;
                    }
                } catch (RuntimeException | LinkageError ignored) {
                    // bundle transitioned to UNINSTALLED concurrently
                }
            }
        } catch (RuntimeException | LinkageError ignored) {
            // outside OSGi
        }
        return null;
    }

    /** Returns true when {@code b} is active, resolved, or starting. */
    public static boolean isScannableState(Bundle b) {
        if (b == null) {
            return false;
        }
        int st = b.getState();
        return st == Bundle.ACTIVE || st == Bundle.RESOLVED || st == Bundle.STARTING;
    }

    /** Returns a compact label {@code symbolicName version} for a bundle. */
    public static String bundleLabel(Bundle b) {
        return b == null ? null : b.getSymbolicName() + " " + b.getVersion();
    }

    /** Resolves plugin key from {@code pluginKeyForBundle} or the {@code Atlassian-Plugin-Key} manifest header. */
    public static String pluginKey(Bundle b, Function<Bundle, String> pluginKeyForBundle) {
        if (b == null) {
            return null;
        }
        if (pluginKeyForBundle != null) {
            String key = pluginKeyForBundle.apply(b);
            if (key != null && !key.isBlank()) {
                return key;
            }
        }
        Dictionary<String, String> headers = rawHeaders(b);
        String headerKey = headers == null ? null : headers.get("Atlassian-Plugin-Key");
        return headerKey != null && !headerKey.isBlank() ? headerKey.trim() : null;
    }

    /** Resolves OSGi candidate bundles matching {@code bundleIdFilter} or {@code pluginKeyFilter}, else all scannable. */
    public static List<Bundle> selectBundles(Long bundleIdFilter, String pluginKeyFilter,
                                             Function<Bundle, String> pluginKeyForBundle) {
        try {
            Bundle self = FrameworkUtil.getBundle(OsgiBundleInspector.class);
            BundleContext ctx = self == null ? null : self.getBundleContext();
            if (ctx == null) {
                return List.of();
            }
            if (bundleIdFilter != null && bundleIdFilter >= 0) {
                Bundle b = ctx.getBundle(bundleIdFilter);
                return isScannableState(b) ? List.of(b) : List.of();
            }
            Bundle[] all = ctx.getBundles();
            if (all == null) {
                return List.of();
            }
            String wantedPlugin = pluginKeyFilter == null ? null : pluginKeyFilter.trim();
            List<Bundle> out = new ArrayList<>();
            for (Bundle b : all) {
                try {
                    if (!isScannableState(b)) {
                        continue;
                    }
                    if (wantedPlugin != null && !wantedPlugin.isEmpty()) {
                        String key = pluginKey(b, pluginKeyForBundle);
                        if (!wantedPlugin.equalsIgnoreCase(key)
                                && !wantedPlugin.equalsIgnoreCase(b.getSymbolicName())) {
                            continue;
                        }
                    }
                    out.add(b);
                } catch (RuntimeException | LinkageError ignored) {
                    // bundle transitioned concurrently
                }
            }
            return out;
        } catch (RuntimeException | LinkageError ignored) {
            return List.of();
        }
    }

    /** Returns active/resolved bundles wired to import {@code pkg} from {@code provider} (plus {@code provider}). */
    public static List<Bundle> bundlesUsingPackage(Bundle provider, String pkg) {
        Set<Bundle> result = new LinkedHashSet<>();
        if (isScannableState(provider)) {
            result.add(provider);
        }
        if (provider == null || pkg == null || pkg.isEmpty()) {
            return new ArrayList<>(result);
        }
        try {
            BundleWiring wiring = provider.adapt(BundleWiring.class);
            if (wiring == null) {
                return new ArrayList<>(result);
            }
            List<BundleWire> wires = wiring.getProvidedWires(BundleRevision.PACKAGE_NAMESPACE);
            if (wires != null) {
                for (BundleWire w : wires) {
                    Object capPkg = w.getCapability().getAttributes().get(BundleRevision.PACKAGE_NAMESPACE);
                    if (pkg.equals(capPkg)) {
                        BundleWiring req = w.getRequirerWiring();
                        Bundle consumer = req == null ? null : req.getBundle();
                        if (isScannableState(consumer)) {
                            result.add(consumer);
                        }
                    }
                }
            }
        } catch (RuntimeException | LinkageError ignored) {
            // outside OSGi or uninstalled
        }
        return new ArrayList<>(result);
    }

    /** Raw headers without localization overhead (falls back safely if mocked {@code getHeaders("")} returns null). */
    public static Dictionary<String, String> rawHeaders(Bundle b) {
        if (b == null) {
            return null;
        }
        Dictionary<String, String> raw = b.getHeaders("");
        return raw != null ? raw : b.getHeaders();
    }

    public static String origin(Class<?> c) {
        if (c == null) {
            return "unknown";
        }
        Bundle b = bundleOf(c);
        if (b != null) {
            return b.getSymbolicName() + " " + b.getVersion();
        }
        ClassLoader loader = c.getClassLoader();
        if (loader == null || loader == ClassLoader.getPlatformClassLoader() || c.getName().startsWith("java.")) {
            return "JDK";
        }
        return "the product (" + loader.getClass().getSimpleName() + ")";
    }

    /** Full bundle details JSON (including imported/exported packages and wire counts) for OperationDetails. */
    public static void writeFullBundle(Json j, Class<?> c) {
        Bundle b = bundleOf(c);
        if (b == null) {
            j.beginObject().field("none", origin(c)).endObject();
            return;
        }
        Map<String, String> headers = selectedHeaders(b);
        j.beginObject()
                .field("id", b.getBundleId())
                .field("symbolicName", b.getSymbolicName())
                .field("version", String.valueOf(b.getVersion()))
                .field("state", state(b.getState()))
                .field("location", clip(b.getLocation()))
                .field("lastModified", b.getLastModified())
                .stringMap("headers", headers);
        BundleWiring wiring = b.adapt(BundleWiring.class);
        if (wiring == null || !wiring.isInUse()) {
            j.field("wiring", false).endObject();
            return;
        }
        List<String[]> imports = new ArrayList<>();
        for (BundleWire w : orEmpty(wiring.getRequiredWires(BundleRevision.PACKAGE_NAMESPACE))) {
            Map<String, Object> attrs = w.getCapability().getAttributes();
            Bundle provider = w.getProviderWiring() == null ? null : w.getProviderWiring().getBundle();
            imports.add(new String[]{
                    String.valueOf(attrs.get(BundleRevision.PACKAGE_NAMESPACE)),
                    version(attrs),
                    provider == null ? "?" : provider.getSymbolicName() + " " + provider.getVersion(),
                    provider == null ? "" : String.valueOf(provider.getBundleId())});
        }
        imports.sort(Comparator.comparing((String[] a) -> a[0]));
        j.field("importCount", imports.size()).name("imports").beginArray();
        for (String[] i : imports.subList(0, Math.min(imports.size(), MAX_PACKAGES))) {
            j.beginObject().field("package", i[0]).field("version", i[1])
                    .field("from", i[2]).field("fromId", i[3]).endObject();
        }
        j.endArray();
        Map<BundleCapability, Integer> users = new HashMap<>();
        for (BundleWire w : orEmpty(wiring.getProvidedWires(BundleRevision.PACKAGE_NAMESPACE))) {
            users.merge(w.getCapability(), 1, Integer::sum);
        }
        List<BundleCapability> exports = new ArrayList<>(orEmpty(wiring.getCapabilities(BundleRevision.PACKAGE_NAMESPACE)));
        exports.sort(Comparator.comparing(cap -> String.valueOf(cap.getAttributes().get(BundleRevision.PACKAGE_NAMESPACE))));
        j.field("exportCount", exports.size()).name("exports").beginArray();
        for (BundleCapability cap : exports.subList(0, Math.min(exports.size(), MAX_PACKAGES))) {
            j.beginObject()
                    .field("package", String.valueOf(cap.getAttributes().get(BundleRevision.PACKAGE_NAMESPACE)))
                    .field("version", version(cap.getAttributes()))
                    .field("users", users.getOrDefault(cap, 0))
                    .endObject();
        }
        j.endArray().endObject();
    }

    /** Compact bundle summary JSON for /code/class and /code/plugin. */
    public static void writeBundleSummary(Json j, Bundle b, String pkg) {
        Dictionary<String, String> all = rawHeaders(b);
        Map<String, String> headers = selectedHeadersFromDict(all);
        boolean fragment = all != null && all.get("Fragment-Host") != null;
        long modified = b.getLastModified();
        j.beginObject()
                .field("id", b.getBundleId())
                .field("symbolicName", b.getSymbolicName())
                .field("version", String.valueOf(b.getVersion()))
                .field("state", state(b.getState()))
                .field("location", clip(b.getLocation()))
                .field("lastModified", modified)
                .optional("lastModifiedIso", modified > 0 ? DateTimeFormatter.ISO_INSTANT.format(Instant.ofEpochMilli(modified)) : null)
                .field("fragment", fragment)
                .stringMap("headers", headers);
        BundleWiring wiring = b.adapt(BundleWiring.class);
        if (wiring != null && wiring.isInUse()) {
            List<BundleWire> reqs = wiring.getRequiredWires(BundleRevision.PACKAGE_NAMESPACE);
            List<BundleCapability> caps = wiring.getCapabilities(BundleRevision.PACKAGE_NAMESPACE);
            List<BundleWire> provs = wiring.getProvidedWires(BundleRevision.PACKAGE_NAMESPACE);
            j.field("importCount", reqs == null ? 0 : reqs.size());
            j.field("exportCount", caps == null ? 0 : caps.size());
            boolean pkgExported = false;
            int pkgUsers = 0;
            if (caps != null && pkg != null && !pkg.isEmpty()) {
                for (BundleCapability cap : caps) {
                    if (pkg.equals(cap.getAttributes().get(BundleRevision.PACKAGE_NAMESPACE))) {
                        pkgExported = true;
                        if (provs != null) {
                            for (BundleWire w : provs) {
                                if (cap.equals(w.getCapability())) {
                                    pkgUsers++;
                                }
                            }
                        }
                        break;
                    }
                }
            }
            j.field("packageExported", pkgExported);
            j.field("packageExportUsers", pkgUsers);
        }
        j.endObject();
    }

    private static Map<String, String> selectedHeaders(Bundle b) {
        return selectedHeadersFromDict(rawHeaders(b));
    }

    private static Map<String, String> selectedHeadersFromDict(Dictionary<String, String> all) {
        Map<String, String> headers = new LinkedHashMap<>();
        if (all == null) {
            return headers;
        }
        for (String name : HEADERS) {
            String v = all.get(name);
            if (v != null) {
                headers.put(name, clip(v));
            }
        }
        return headers;
    }

    private static <T> List<T> orEmpty(List<T> list) {
        return list == null ? List.of() : list;
    }

    public static String version(Map<String, Object> attributes) {
        Object v = attributes.get("version");
        return v == null ? "" : String.valueOf(v);
    }

    public static String state(int state) {
        return switch (state) {
            case Bundle.UNINSTALLED -> "UNINSTALLED";
            case Bundle.INSTALLED -> "INSTALLED";
            case Bundle.RESOLVED -> "RESOLVED";
            case Bundle.STARTING -> "STARTING";
            case Bundle.STOPPING -> "STOPPING";
            case Bundle.ACTIVE -> "ACTIVE";
            default -> String.valueOf(state);
        };
    }

    public static String clip(String s) {
        return s == null || s.length() <= MAX_TEXT ? s : cut(s, MAX_TEXT);
    }

    /** Cuts at {@code max} characters without splitting a surrogate pair, appending "…". */
    public static String cut(String s, int max) {
        int end = Character.isHighSurrogate(s.charAt(max - 1)) ? max - 1 : max;
        return s.substring(0, end) + "…";
    }
}
