package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.JerseyModelSource.Handler;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.labs.restbrowser.catalog.SpecSource.SpecException;
import com.atlassian.plugin.ModuleDescriptor;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginDependencies;
import com.atlassian.plugin.PluginInformation;
import org.osgi.framework.Bundle;
import org.osgi.framework.FrameworkUtil;
import org.osgi.framework.wiring.BundleCapability;
import org.osgi.framework.wiring.BundleRevision;
import org.osgi.framework.wiring.BundleWire;
import org.osgi.framework.wiring.BundleWiring;

import java.lang.annotation.Annotation;
import java.lang.reflect.AnnotatedElement;
import java.lang.reflect.GenericArrayType;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Parameter;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.lang.reflect.WildcardType;
import java.security.CodeSource;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Date;
import java.util.Dictionary;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.Consumer;
import java.util.function.Supplier;

import static java.util.Objects.requireNonNull;

/**
 * The details of one operation, for system administrators: the Java method that handles it and its class
 * (reflection), the OSGi bundle the class comes from, the plugin and the REST module. Built on demand from the live
 * objects and written as JSON at once; nothing is kept (see {@link Model}). A section that cannot be read says why
 * instead of failing the others.
 */
public class OperationDetails {

    /** The response: an HTTP status and its JSON body. */
    public record Result(int status, String json) {
    }

    static final int MAX_MODULES = 300;
    static final int MAX_PACKAGES = 500;
    static final int MAX_TEXT = 500;
    /** An annotation may carry the operation's documentation (OpenAPI's @Operation): longer than other text. */
    static final int MAX_ANNOTATION = 2000;
    /** The bundle headers worth showing; the others (Import-Package, …) are shown as wiring or not at all. */
    static final List<String> HEADERS = List.of("Bundle-Name", "Bundle-Vendor", "Bundle-Description", "Bundle-DocURL",
            "Bundle-License", "Atlassian-Plugin-Key", "Atlassian-Build-Date", "Spring-Context", "Bundle-ClassPath",
            "DynamicImport-Package", "Require-Capability", "Created-By", "Build-Jdk-Spec");

    private final ModuleDiscovery discovery;
    private final Supplier<JerseyModelSource> jersey;
    private final ProductAdapter product;

    public OperationDetails(ModuleDiscovery discovery, Supplier<JerseyModelSource> jersey, ProductAdapter product) {
        this.discovery = requireNonNull(discovery);
        this.jersey = requireNonNull(jersey);
        this.product = requireNonNull(product);
    }

    public Result describe(String key) {
        if (key == null || key.isBlank()) {
            return error(400, "missing-op");
        }
        RestModule module = moduleOf(discovery.discover(), key);
        if (module == null) {
            return error(404, "unknown-module");
        }
        JerseyModelSource source = jersey.get();
        if (source == null || !module.restV2()) {
            return error(404, "not-described");
        }
        Optional<Handler> handler;
        try {
            handler = source.handler(module, key);
        } catch (SpecException e) {
            return error(503, e.reason());
        }
        if (handler.isEmpty() || handler.get().handling() == null) {
            return error(404, "unknown-operation");
        }
        return new Result(200, json(key, module, handler.get()));
    }

    /** The module an operation key belongs to: the longest module id the key starts with, followed by ":". */
    static RestModule moduleOf(List<RestModule> modules, String key) {
        RestModule best = null;
        for (RestModule m : modules) {
            if (key.startsWith(m.id() + ":") && (best == null || m.id().length() > best.id().length())) {
                best = m;
            }
        }
        return best;
    }

    String json(String key, RestModule module, Handler h) {
        Method m = h.handling();
        Class<?> type = h.handlerClass() != null ? h.handlerClass() : m.getDeclaringClass();
        Json j = new Json().beginObject().field("format", 1).field("key", key);
        section(j, "method", s -> method(s, m));
        if (h.definition() != null && !h.definition().equals(m)) {
            section(j, "definition", s -> method(s, h.definition()));
        }
        section(j, "locators", s -> {
            s.beginArray();
            for (Method l : h.locators()) {
                method(s, l);
            }
            s.endArray();
        });
        section(j, "resourceClass", s -> type(s, type));
        if (m.getDeclaringClass() != type) {
            section(j, "declaringClass", s -> type(s, m.getDeclaringClass()));
        }
        section(j, "types", s -> {
            s.beginArray();
            for (Class<?> c : signatureTypes(m)) {
                s.beginObject().field("name", c.getName()).field("from", origin(c)).endObject();
            }
            s.endArray();
        });
        section(j, "bundle", s -> bundle(s, type));
        section(j, "plugin", s -> plugin(s, module.plugin()));
        section(j, "module", s -> restModule(s, module));
        return j.endObject().toString();
    }

    // ---- reflection

    static void method(Json j, Method m) {
        j.beginObject()
                .field("class", m.getDeclaringClass().getName())
                .field("name", m.getName())
                .field("signature", m.toGenericString())
                .field("modifiers", Modifier.toString(m.getModifiers() & Modifier.methodModifiers()))
                .field("returns", m.getGenericReturnType().getTypeName());
        List<String> thrown = new ArrayList<>();
        for (Type t : m.getGenericExceptionTypes()) {
            thrown.add(t.getTypeName());
        }
        j.strings("throws", thrown).strings("annotations", annotations(m)).name("parameters").beginArray();
        for (Parameter p : m.getParameters()) {
            j.beginObject()
                    .field("name", p.isNamePresent() ? p.getName() : null)
                    .field("type", p.getParameterizedType().getTypeName())
                    .strings("annotations", annotations(p))
                    .endObject();
        }
        j.endArray().field("deprecated", m.isAnnotationPresent(Deprecated.class)).endObject();
    }

    static void type(Json j, Class<?> c) {
        List<String> supers = new ArrayList<>();
        Set<String> interfaces = new LinkedHashSet<>();
        for (Class<?> k = c; k != null && k != Object.class; k = k.getSuperclass()) {
            if (k != c) {
                supers.add(k.getName());
            }
            for (Type t : k.getGenericInterfaces()) {
                interfaces.add(t.getTypeName());
            }
        }
        int modifiers = c.getModifiers() & (c.isInterface() ? Modifier.interfaceModifiers() : Modifier.classModifiers());
        j.beginObject()
                .field("name", c.getName())
                .field("kind", c.isAnnotation() ? "annotation" : c.isInterface() ? "interface" : c.isEnum() ? "enum"
                        : c.isRecord() ? "record" : "class")
                .field("modifiers", Modifier.toString(modifiers))
                .strings("superclasses", supers)
                .strings("interfaces", interfaces)
                .strings("annotations", annotations(c))
                .field("package", c.getPackageName())
                .strings("packageAnnotations", c.getPackage() == null ? List.of() : annotations(c.getPackage()))
                .field("codeSource", codeSource(c))
                .field("classLoader", clip(String.valueOf(c.getClassLoader())))
                .endObject();
    }

    /** The annotations as source code would write them; one whose class cannot be loaded is reported as such. */
    static List<String> annotations(AnnotatedElement e) {
        List<String> out = new ArrayList<>();
        try {
            for (Annotation a : e.getDeclaredAnnotations()) {
                String s = annotation(a);
                out.add(s.length() <= MAX_ANNOTATION ? s : s.substring(0, MAX_ANNOTATION) + "…");
            }
        } catch (RuntimeException | LinkageError x) {
            out.add("(unreadable: " + x + ")");
        }
        return out;
    }

    /**
     * An annotation with only the members that differ from their defaults, as written in source: Java's own
     * toString lists every member, and OpenAPI's annotations have dozens of empty ones.
     */
    static String annotation(Annotation a) {
        Class<? extends Annotation> type = a.annotationType();
        Method[] members = type.getDeclaredMethods();
        java.util.Arrays.sort(members, Comparator.comparing(Method::getName));
        List<String> set = new ArrayList<>();
        boolean onlyValue = true;
        for (Method m : members) {
            if (m.getParameterCount() != 0 || m.isSynthetic()) {
                continue;
            }
            Object v;
            try {
                m.setAccessible(true);
                v = m.invoke(a);
            } catch (ReflectiveOperationException | RuntimeException | LinkageError x) {
                set.add(m.getName() + "=?");
                onlyValue = false;
                continue;
            }
            Object def = m.getDefaultValue();
            if (def != null && java.util.Objects.deepEquals(v, def)) {
                continue;
            }
            set.add(m.getName() + "=" + annotationValue(v));
            onlyValue &= "value".equals(m.getName());
        }
        String name = "@" + type.getName();
        if (set.isEmpty()) {
            return name;
        }
        if (onlyValue && set.size() == 1) {
            return name + "(" + set.get(0).substring("value=".length()) + ")";
        }
        return name + "(" + String.join(", ", set) + ")";
    }

    private static String annotationValue(Object v) {
        if (v instanceof String s) {
            return '"' + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + '"';
        }
        if (v instanceof Character c) {
            return "'" + c + "'";
        }
        if (v instanceof Class<?> c) {
            return c.getName() + ".class";
        }
        if (v instanceof Enum<?> e) {
            return e.getDeclaringClass().getName() + "." + e.name();
        }
        if (v instanceof Annotation a) {
            return annotation(a);
        }
        if (v != null && v.getClass().isArray()) {
            int n = java.lang.reflect.Array.getLength(v);
            List<String> items = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                items.add(annotationValue(java.lang.reflect.Array.get(v, i)));
            }
            return n == 1 ? items.get(0) : "{" + String.join(", ", items) + "}";
        }
        if (v instanceof Long l) {
            return l + "L";
        }
        if (v instanceof Float f) {
            return f + "f";
        }
        return String.valueOf(v);
    }

    /** The classes a method's signature names (return, parameters, type arguments, exceptions), JDK ones included. */
    static List<Class<?>> signatureTypes(Method m) {
        Set<Class<?>> out = new LinkedHashSet<>();
        collect(m.getGenericReturnType(), out);
        for (Type t : m.getGenericParameterTypes()) {
            collect(t, out);
        }
        for (Type t : m.getGenericExceptionTypes()) {
            collect(t, out);
        }
        return new ArrayList<>(out);
    }

    private static void collect(Type t, Set<Class<?>> out) {
        if (t instanceof Class<?> c) {
            Class<?> k = c;
            while (k.isArray()) {
                k = k.getComponentType();
            }
            if (!k.isPrimitive()) {
                out.add(k);
            }
        } else if (t instanceof ParameterizedType p) {
            collect(p.getRawType(), out);
            for (Type a : p.getActualTypeArguments()) {
                collect(a, out);
            }
        } else if (t instanceof GenericArrayType g) {
            collect(g.getGenericComponentType(), out);
        } else if (t instanceof WildcardType w) {
            for (Type b : w.getUpperBounds()) {
                collect(b, out);
            }
            for (Type b : w.getLowerBounds()) {
                collect(b, out);
            }
        }
    }

    /** Where a class comes from: its bundle, the JDK, or the product's own class loader. */
    static String origin(Class<?> c) {
        Bundle b = bundleOf(c);
        if (b != null) {
            return b.getSymbolicName() + " " + b.getVersion();
        }
        ClassLoader loader = c.getClassLoader();
        if (loader == null || c.getName().startsWith("java.") || c.getName().startsWith("javax.")) {
            return "JDK";
        }
        return "the product (" + loader.getClass().getSimpleName() + ")";
    }

    private static String codeSource(Class<?> c) {
        try {
            CodeSource cs = c.getProtectionDomain().getCodeSource();
            return cs == null || cs.getLocation() == null ? null : cs.getLocation().toString();
        } catch (RuntimeException e) {
            return null;
        }
    }

    // ---- OSGi

    private static Bundle bundleOf(Class<?> c) {
        try {
            return FrameworkUtil.getBundle(c);
        } catch (RuntimeException | LinkageError e) {
            return null; // not in an OSGi framework (tests), or the framework is going away
        }
    }

    static void bundle(Json j, Class<?> c) {
        Bundle b = bundleOf(c);
        if (b == null) {
            j.beginObject().field("none", origin(c)).endObject();
            return;
        }
        Map<String, String> headers = new LinkedHashMap<>();
        Dictionary<String, String> all = b.getHeaders();
        for (String name : HEADERS) {
            String v = all.get(name);
            if (v != null) {
                headers.put(name, clip(v));
            }
        }
        j.beginObject()
                .field("id", b.getBundleId())
                .field("symbolicName", b.getSymbolicName())
                .field("version", String.valueOf(b.getVersion()))
                .field("state", state(b.getState()))
                .field("location", clip(b.getLocation()))
                .field("lastModified", b.getLastModified())
                .stringMap("headers", headers);
        BundleWiring wiring = b.adapt(BundleWiring.class);
        if (wiring == null) {
            j.field("wiring", false).endObject();
            return;
        }
        // imports: the package, the version the provider offers, and the provider
        List<String[]> imports = new ArrayList<>();
        for (BundleWire w : wiring.getRequiredWires(BundleRevision.PACKAGE_NAMESPACE)) {
            Map<String, Object> attrs = w.getCapability().getAttributes();
            Bundle provider = w.getProviderWiring() == null ? null : w.getProviderWiring().getBundle();
            imports.add(new String[]{String.valueOf(attrs.get(BundleRevision.PACKAGE_NAMESPACE)),
                    String.valueOf(attrs.get("version")),
                    provider == null ? "?" : provider.getSymbolicName() + " " + provider.getVersion(),
                    provider == null ? "" : String.valueOf(provider.getBundleId())});
        }
        imports.sort(Comparator.comparing((String[] a) -> a[0]));
        j.field("importCount", imports.size()).name("imports").beginArray();
        for (String[] i : imports.subList(0, Math.min(imports.size(), MAX_PACKAGES))) {
            j.beginObject().field("package", i[0]).field("version", i[1]).field("from", i[2]).field("fromId", i[3]).endObject();
        }
        j.endArray();
        // exports: the package, its version, and how many bundles are wired to it
        Map<BundleCapability, Integer> users = new IdentityHashMap<>();
        for (BundleWire w : wiring.getProvidedWires(BundleRevision.PACKAGE_NAMESPACE)) {
            users.merge(w.getCapability(), 1, Integer::sum);
        }
        List<BundleCapability> exports = new ArrayList<>(wiring.getCapabilities(BundleRevision.PACKAGE_NAMESPACE));
        exports.sort(Comparator.comparing(cap -> String.valueOf(cap.getAttributes().get(BundleRevision.PACKAGE_NAMESPACE))));
        j.field("exportCount", exports.size()).name("exports").beginArray();
        for (BundleCapability cap : exports.subList(0, Math.min(exports.size(), MAX_PACKAGES))) {
            j.beginObject()
                    .field("package", String.valueOf(cap.getAttributes().get(BundleRevision.PACKAGE_NAMESPACE)))
                    .field("version", String.valueOf(cap.getAttributes().get("version")))
                    .field("users", users.getOrDefault(cap, 0))
                    .endObject();
        }
        j.endArray().endObject();
    }

    static String state(int state) {
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

    // ---- the plugin and its REST module

    void plugin(Json j, Plugin p) {
        if (p == null) {
            j.value((String) null);
            return;
        }
        PluginInformation info = p.getPluginInformation();
        j.beginObject()
                .field("key", p.getKey())
                .field("name", p.getName())
                .optional("version", info == null ? null : info.getVersion())
                .optional("vendor", info == null ? null : info.getVendorName())
                .optional("vendorUrl", info == null ? null : info.getVendorUrl())
                .optional("description", info == null ? null : clip(info.getDescription()))
                .field("origin", product.origin(p))
                .field("state", String.valueOf(p.getPluginState()))
                .field("pluginsVersion", p.getPluginsVersion())
                .optional("artifact", p.getPluginArtifact() == null ? null : p.getPluginArtifact().getName())
                .optional("installed", iso(p.getDateInstalled()))
                .optional("loaded", iso(p.getDateLoaded()))
                .optional("enabled", iso(p.getDateEnabled()));
        Set<String> mandatory = new TreeSet<>();
        Set<String> optional = new TreeSet<>();
        try {
            PluginDependencies deps = p.getDependencies();
            if (deps != null) {
                mandatory.addAll(deps.getMandatory());
                optional.addAll(deps.getOptional());
                optional.addAll(deps.getDynamic());
            }
        } catch (RuntimeException | LinkageError e) {
            // older plugin types do not know their dependencies
        }
        j.strings("dependsOn", mandatory).strings("optionallyDependsOn", optional);
        List<ModuleDescriptor<?>> modules = new ArrayList<>(p.getModuleDescriptors());
        modules.sort(Comparator.comparing(ModuleDescriptor::getKey, Comparator.nullsFirst(Comparator.naturalOrder())));
        j.field("moduleCount", modules.size()).name("modules").beginArray();
        for (ModuleDescriptor<?> md : modules.subList(0, Math.min(modules.size(), MAX_MODULES))) {
            j.beginObject()
                    .field("key", md.getKey())
                    .field("type", moduleType(md))
                    .optional("name", md.getName())
                    .field("enabled", md.isEnabled())
                    .endObject();
        }
        j.endArray().endObject();
    }

    /** "RestServletFilterModuleDescriptor" gives "RestServletFilter"; the descriptor's class says what it is. */
    static String moduleType(ModuleDescriptor<?> md) {
        String name = md.getClass().getSimpleName();
        return name.endsWith("ModuleDescriptor") && name.length() > "ModuleDescriptor".length()
                ? name.substring(0, name.length() - "ModuleDescriptor".length()) : name;
    }

    static void restModule(Json j, RestModule m) {
        j.beginObject()
                .field("key", m.id())
                .field("path", m.path())
                .field("basePath", m.basePath())
                .field("version", m.version())
                .field("rest", m.restV2() ? "REST v2 (Jersey 2)" : "REST v1 (Jersey 1)")
                .optional("description", clip(m.description()))
                .optional("descriptor", m.descriptor() == null ? null : m.descriptor().getClass().getName())
                .endObject();
    }

    // ---- helpers

    private static void section(Json j, String name, Consumer<Json> body) {
        String part;
        try {
            Json s = new Json();
            body.accept(s);
            part = s.toString();
        } catch (RuntimeException | LinkageError e) {
            part = new Json().beginObject().field("error", clip(String.valueOf(e))).endObject().toString();
        }
        j.name(name).raw(part);
    }

    private static Result error(int status, String reason) {
        return new Result(status, new Json().beginObject().field("error", reason).endObject().toString());
    }

    private static String iso(Date d) {
        return d == null ? null : DateTimeFormatter.ISO_INSTANT.format(d.toInstant());
    }

    static String clip(String s) {
        return s == null || s.length() <= MAX_TEXT ? s : s.substring(0, MAX_TEXT) + "…";
    }
}
