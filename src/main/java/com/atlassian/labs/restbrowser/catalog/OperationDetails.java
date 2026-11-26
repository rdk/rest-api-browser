package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.JerseyModelSource.Handler;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.labs.restbrowser.catalog.SpecSource.SpecException;
import com.atlassian.labs.restbrowser.inspect.TypeProxyUnwrapper;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiBundleInspector;
import com.atlassian.labs.restbrowser.jaxrs.AnnotationFormatter;
import com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge;
import com.atlassian.labs.restbrowser.json.Json;
import com.atlassian.plugin.ModuleDescriptor;
import com.atlassian.plugin.Plugin;

import java.lang.reflect.AnnotatedElement;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Parameter;
import java.lang.reflect.Type;
import java.security.CodeSource;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.Supplier;

import static java.util.Objects.requireNonNull;

/**
 * Reflection, OSGi bundle, plugin, and REST module details for one operation (system administrators only).
 * Delegates annotation formatting and OSGi inspection to {@link AnnotationFormatter} and {@link OsgiBundleInspector}.
 */
public class OperationDetails {

    public record Result(int status, String json) {
    }

    static final int MAX_MODULES = AtlassianPluginInspector.MAX_MODULES;
    static final int MAX_PACKAGES = OsgiBundleInspector.MAX_PACKAGES;
    static final int MAX_TEXT = OsgiBundleInspector.MAX_TEXT;
    static final int MAX_ANNOTATION = AnnotationFormatter.MAX_ANNOTATION;
    static final List<String> HEADERS = OsgiBundleInspector.HEADERS;

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

    /** Overload allowing {@link OperationSource#operationBundle} to reuse an already resolved module + handler. */
    Result describeHandler(String key, RestModule module, Handler handler) {
        if (handler == null || handler.handling() == null) {
            return error(404, "unknown-operation");
        }
        return new Result(200, json(key, module, handler));
    }

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
        Class<?> rawType = h.handlerClass() != null ? h.handlerClass() : m.getDeclaringClass();
        Class<?> type = TypeProxyUnwrapper.targetClass(rawType);
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
        Class<?> declaring = TypeProxyUnwrapper.targetClass(m.getDeclaringClass());
        if (declaring != type) {
            section(j, "declaringClass", s -> type(s, declaring));
        }
        section(j, "types", s -> {
            LinkedHashSet<Class<?>> allTypes = new LinkedHashSet<>(signatureTypes(m));
            if (h.definition() != null && !h.definition().equals(m)) {
                allTypes.addAll(signatureTypes(h.definition()));
            }
            s.beginArray();
            for (Class<?> c : allTypes) {
                s.beginObject().field("name", c.getName()).field("from", origin(c)).endObject();
            }
            s.endArray();
        });
        section(j, "bundle", s -> bundle(s, type));
        section(j, "plugin", s -> plugin(s, module.plugin()));
        section(j, "module", s -> AtlassianPluginInspector.writeRestModule(s, module));
        return j.endObject().toString();
    }

    // ---- reflection (guarded against missing optional generic types / proxies)

    static void method(Json j, Method m) {
        String sig;
        try {
            sig = m.toGenericString();
        } catch (RuntimeException | LinkageError e) {
            sig = m.toString();
        }
        String returns;
        try {
            returns = m.getGenericReturnType().getTypeName();
        } catch (RuntimeException | LinkageError e) {
            returns = m.getReturnType().getTypeName();
        }
        List<String> thrown = new ArrayList<>();
        try {
            for (Type t : m.getGenericExceptionTypes()) {
                thrown.add(t.getTypeName());
            }
        } catch (RuntimeException | LinkageError e) {
            for (Class<?> c : m.getExceptionTypes()) {
                thrown.add(c.getTypeName());
            }
        }
        j.beginObject()
                .field("class", TypeProxyUnwrapper.targetClass(m.getDeclaringClass()).getName())
                .field("name", m.getName())
                .field("signature", sig)
                .field("modifiers", Modifier.toString(m.getModifiers() & Modifier.methodModifiers()))
                .field("returns", returns)
                .strings("throws", thrown)
                .strings("annotations", annotations(m))
                .name("parameters").beginArray();
        for (Parameter p : m.getParameters()) {
            String pType;
            try {
                pType = p.getParameterizedType().getTypeName();
            } catch (RuntimeException | LinkageError e) {
                pType = p.getType().getTypeName();
            }
            j.beginObject()
                    .field("name", p.isNamePresent() ? p.getName() : null)
                    .field("type", pType)
                    .strings("annotations", annotations(p))
                    .endObject();
        }
        j.endArray().field("deprecated", ReflectiveBridge.safeHasAnnotation(m, Deprecated.class)).endObject();
    }

    static void type(Json j, Class<?> rawClass) {
        Class<?> c = TypeProxyUnwrapper.targetClass(rawClass);
        List<String> supers = new ArrayList<>();
        Set<String> interfaces = new LinkedHashSet<>();
        for (Class<?> k = c; k != null && k != Object.class; k = k.getSuperclass()) {
            if (k != c) {
                supers.add(k.getName());
            }
            try {
                for (Type t : k.getGenericInterfaces()) {
                    interfaces.add(t.getTypeName());
                }
            } catch (RuntimeException | LinkageError e) {
                for (Class<?> iface : k.getInterfaces()) {
                    interfaces.add(iface.getName());
                }
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

    static List<String> annotations(AnnotatedElement e) {
        return AnnotationFormatter.annotations(e);
    }

    static String annotation(java.lang.annotation.Annotation a) {
        return AnnotationFormatter.annotation(a);
    }

    static List<Class<?>> signatureTypes(Method m) {
        return AnnotationFormatter.signatureTypes(m);
    }

    static String origin(Class<?> c) {
        return OsgiBundleInspector.origin(c);
    }

    private static String codeSource(Class<?> c) {
        try {
            CodeSource cs = c.getProtectionDomain().getCodeSource();
            return cs == null || cs.getLocation() == null ? null : clip(cs.getLocation().toString());
        } catch (RuntimeException e) {
            return null;
        }
    }

    static void bundle(Json j, Class<?> c) {
        OsgiBundleInspector.writeFullBundle(j, c);
    }

    static String state(int state) {
        return OsgiBundleInspector.state(state);
    }

    void plugin(Json j, Plugin p) {
        AtlassianPluginInspector.writePluginFull(j, p, product);
    }

    static String moduleType(ModuleDescriptor<?> md) {
        return AtlassianPluginInspector.moduleType(md);
    }

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

    static String clip(String s) {
        return OsgiBundleInspector.clip(s);
    }

    static String cut(String s, int max) {
        return OsgiBundleInspector.cut(s, max);
    }
}
