package com.atlassian.labs.restbrowser.inspect.osgi;

import com.atlassian.labs.restbrowser.inspect.BytecodeReader;
import com.atlassian.labs.restbrowser.inspect.ClassFileInspector;
import com.atlassian.labs.restbrowser.inspect.ClassGraphTraverser.ResolvedClassInfo;
import com.atlassian.labs.restbrowser.inspect.TypeProxyUnwrapper;
import org.osgi.framework.Bundle;
import org.osgi.framework.BundleContext;
import org.osgi.framework.FrameworkUtil;
import org.osgi.framework.wiring.BundleRevision;
import org.osgi.framework.wiring.BundleWire;
import org.osgi.framework.wiring.BundleWiring;

import java.net.URL;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Resolves Java classes and their bytecode across OSGi bundle wirings, context classloaders, bundle archives
 * (both root and {@code WEB-INF/classes/}), and JDK bootstrap libraries. Zero Atlassian coupling.
 */
public final class OsgiClassResolver {

    private static final int MAX_CANDIDATES = 12;

    private OsgiClassResolver() {
    }

    public static List<String> parseCandidates(String raw) {
        if (raw == null) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (String part : raw.split(",")) {
            String name = part.trim();
            if (name.isEmpty() || name.contains("..") || !ClassFileInspector.SAFE_CLASS_NAME.matcher(name).matches()) {
                continue;
            }
            out.add(name);
            if (out.size() >= MAX_CANDIDATES) {
                break;
            }
        }
        return out;
    }

    /** Generates nested-class variants: "a.b.Outer.Inner" -> ["a.b.Outer.Inner", "a.b.Outer$Inner", ...]. */
    public static List<String> nestedVariants(String name) {
        List<String> out = new ArrayList<>();
        out.add(name);
        String cur = name;
        for (int i = 0; i < 3; i++) {
            int dot = cur.lastIndexOf('.');
            if (dot <= 0) {
                break;
            }
            cur = cur.substring(0, dot) + '$' + cur.substring(dot + 1);
            out.add(cur);
        }
        return out;
    }

    public static List<ClassLoader> buildContextLoaders(long fromBundleId, Class<?> handlerClass, Class<?> anchorClass) {
        Set<ClassLoader> loaders = new LinkedHashSet<>();
        if (fromBundleId >= 0) {
            ClassLoader bLoader = bundleClassLoader(fromBundleId);
            if (bLoader != null) {
                loaders.add(bLoader);
            }
        }
        if (handlerClass != null) {
            ClassLoader l = TypeProxyUnwrapper.targetClass(handlerClass).getClassLoader();
            if (l != null) {
                loaders.add(l);
            }
        }
        ClassLoader tccl = Thread.currentThread().getContextClassLoader();
        if (tccl != null) {
            loaders.add(tccl);
        }
        if (anchorClass != null && anchorClass.getClassLoader() != null) {
            loaders.add(anchorClass.getClassLoader());
        }
        return new ArrayList<>(loaders);
    }

    public static ClassLoader bundleClassLoader(long bundleId) {
        try {
            Bundle self = FrameworkUtil.getBundle(OsgiClassResolver.class);
            BundleContext ctx = self == null ? null : self.getBundleContext();
            Bundle b = ctx == null ? null : ctx.getBundle(bundleId);
            BundleWiring wiring = b == null ? null : b.adapt(BundleWiring.class);
            return wiring == null ? null : wiring.getClassLoader();
        } catch (RuntimeException | LinkageError e) {
            return null;
        }
    }

    public static Bundle bundleByIdOrClass(long bundleId, Class<?> c) {
        try {
            if (c != null) {
                Bundle b = FrameworkUtil.getBundle(c);
                if (b != null) {
                    return b;
                }
            }
            if (bundleId >= 0) {
                Bundle self = FrameworkUtil.getBundle(OsgiClassResolver.class);
                BundleContext ctx = self == null ? null : self.getBundleContext();
                if (ctx != null) {
                    return ctx.getBundle(bundleId);
                }
            }
        } catch (RuntimeException | LinkageError ignored) {
            // outside OSGi
        }
        return null;
    }

    private static boolean bundleContainsEntry(Bundle b, String path) {
        try {
            return b.getEntry(path) != null || b.getEntry("WEB-INF/classes/" + path) != null;
        } catch (IllegalStateException e) {
            return false;
        }
    }

    private static boolean isImportedFromOtherBundle(Bundle b, String className) {
        int dot = className.lastIndexOf('.');
        if (dot <= 0) {
            return false;
        }
        String pkg = className.substring(0, dot);
        try {
            BundleWiring wiring = b.adapt(BundleWiring.class);
            if (wiring == null) {
                return false;
            }
            List<BundleWire> wires = wiring.getRequiredWires(BundleRevision.PACKAGE_NAMESPACE);
            if (wires == null) {
                return false;
            }
            for (BundleWire wire : wires) {
                Object capPkg = wire.getCapability().getAttributes().get(BundleRevision.PACKAGE_NAMESPACE);
                if (pkg.equals(capPkg)) {
                    BundleWiring provider = wire.getProviderWiring();
                    Bundle providerBundle = provider == null ? null : provider.getBundle();
                    return providerBundle != null && providerBundle.getBundleId() != b.getBundleId();
                }
            }
        } catch (RuntimeException | LinkageError ignored) {
            // outside OSGi or uninstalled bundle
        }
        return false;
    }

    public static ResolvedClassInfo resolveLoaded(Class<?> target) {
        if (target == null) {
            return null;
        }
        String path = target.getName().replace('.', '/') + ".class";
        ClassLoader loader = target.getClassLoader();
        long bundleId = -1;
        long modified = 0;
        Bundle b = null;
        try {
            b = FrameworkUtil.getBundle(target);
            if (b != null) {
                bundleId = b.getBundleId();
                modified = b.getLastModified();
            }
        } catch (RuntimeException | LinkageError ignored) {
            // outside OSGi
        }
        // Only fall back to system/JDK if the class wasn't loaded by a specific OSGi bundle
        byte[] bytes = b != null || loader != null
                ? readFromLoaderOrBundle(loader, b, path)
                : BytecodeReader.readSystemOrJdk(path);
        if (bytes == null && b == null) {
            bytes = BytecodeReader.readSystemOrJdk(path);
        }
        if (bytes == null) {
            return null;
        }
        return new ResolvedClassInfo(target.getName(), target, loader, bundleId, modified, bytes);
    }

    public static ResolvedClassInfo resolveFromCandidates(List<String> candidates, List<ClassLoader> loaders) {
        // 1. Try loading through context classloaders (follows OSGi package wires cleanly)
        for (String cand : candidates) {
            for (String variant : nestedVariants(cand)) {
                for (ClassLoader loader : loaders) {
                    ResolvedClassInfo r = tryLoad(loader, variant);
                    if (r != null) {
                        return r;
                    }
                }
            }
        }
        // 2. Try direct resource lookup strictly scoped to each loader (skip system/JDK until step 4!)
        for (String cand : candidates) {
            for (String variant : nestedVariants(cand)) {
                String path = variant.replace('.', '/') + ".class";
                boolean systemHas = BytecodeReader.isBootOrSystemResource(path);
                for (ClassLoader loader : loaders) {
                    if (loader == null) {
                        continue;
                    }
                    // Avoid falsely claiming a JDK/system class belongs to a child bundle classloader via delegation
                    URL direct = loader.getResource(path);
                    if (direct != null && !systemHas) {
                        Bundle b = findOwnerBundle(loader);
                        if (b != null && !bundleContainsEntry(b, path) && isImportedFromOtherBundle(b, variant)) {
                            continue;
                        }
                        byte[] bytes = BytecodeReader.readUrl(direct);
                        if (bytes != null) {
                            long bid = b == null ? -1L : b.getBundleId();
                            long bmod = b == null ? 0L : b.getLastModified();
                            return new ResolvedClassInfo(variant, null, loader, bid, bmod, bytes);
                        }
                    }
                }
            }
        }
        // 3. Scan active/resolved/starting OSGi bundles for non-wired classes (root AND WEB-INF/classes/)
        try {
            Bundle self = FrameworkUtil.getBundle(OsgiClassResolver.class);
            BundleContext ctx = self == null ? null : self.getBundleContext();
            if (ctx != null) {
                Bundle[] bundles = ctx.getBundles();
                if (bundles != null) {
                    for (String cand : candidates) {
                        for (String variant : nestedVariants(cand)) {
                            String path = variant.replace('.', '/') + ".class";
                            for (Bundle b : bundles) {
                                try {
                                    int st = b.getState();
                                    if (st != Bundle.ACTIVE && st != Bundle.RESOLVED && st != Bundle.STARTING) {
                                        continue;
                                    }
                                    URL entry = b.getEntry(path);
                                    if (entry == null) {
                                        entry = b.getEntry("WEB-INF/classes/" + path);
                                    }
                                    if (entry == null) {
                                        continue;
                                    }
                                    BundleWiring w = b.adapt(BundleWiring.class);
                                    ClassLoader cl = w == null ? null : w.getClassLoader();
                                    byte[] bytes = BytecodeReader.readUrl(entry);
                                    if (bytes != null) {
                                        Class<?> loaded = tryLoadClass(cl, variant);
                                        return new ResolvedClassInfo(variant, loaded, cl, b.getBundleId(), b.getLastModified(), bytes);
                                    }
                                } catch (RuntimeException | LinkageError ignored) {
                                    // bundle transitioned to UNINSTALLED concurrently
                                }
                            }
                        }
                    }
                }
            }
        } catch (RuntimeException | LinkageError ignored) {
            // outside OSGi
        }
        // 4. JDK / bootstrap fallback (bundleId = -1, bundleModified = 0)
        for (String cand : candidates) {
            for (String variant : nestedVariants(cand)) {
                String path = variant.replace('.', '/') + ".class";
                byte[] sys = BytecodeReader.readSystemOrJdk(path);
                if (sys != null) {
                    return new ResolvedClassInfo(variant, tryLoadClass(null, variant), null, -1, 0, sys);
                }
            }
        }
        return null;
    }

    private static byte[] readFromLoaderOrBundle(ClassLoader loader, Bundle b, String path) {
        byte[] bytes = BytecodeReader.readFromLoaderOnly(loader, path);
        if (bytes != null) {
            return bytes;
        }
        if (b != null) {
            URL entry = b.getEntry(path);
            if (entry == null) {
                entry = b.getEntry("WEB-INF/classes/" + path);
            }
            return BytecodeReader.readUrl(entry);
        }
        return null;
    }

    private static Bundle findOwnerBundle(ClassLoader loader) {
        if (loader instanceof org.osgi.framework.BundleReference ref) {
            return ref.getBundle();
        }
        return null;
    }

    public static Class<?> tryLoadClass(ClassLoader loader, String name) {
        try {
            return Class.forName(name, false, loader);
        } catch (ClassNotFoundException | LinkageError | RuntimeException e) {
            return null;
        }
    }

    private static ResolvedClassInfo tryLoad(ClassLoader loader, String name) {
        try {
            Class<?> c = Class.forName(name, false, loader);
            return resolveLoaded(TypeProxyUnwrapper.targetClass(c));
        } catch (ClassNotFoundException | LinkageError | RuntimeException e) {
            return null;
        }
    }
}
