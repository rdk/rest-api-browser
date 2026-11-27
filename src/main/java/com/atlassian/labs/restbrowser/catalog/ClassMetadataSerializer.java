package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.inspect.ClassFileInspector;
import com.atlassian.labs.restbrowser.inspect.ClassFileInspector.BytecodeVersion;
import com.atlassian.labs.restbrowser.inspect.ClassFileInspector.MethodOutline;
import com.atlassian.labs.restbrowser.inspect.ClassGraphTraverser.ResolvedClassInfo;
import com.atlassian.labs.restbrowser.inspect.DtoSchemaInspector;
import com.atlassian.labs.restbrowser.inspect.DtoSchemaInspector.SchemaResult;
import com.atlassian.labs.restbrowser.inspect.TypeProxyUnwrapper;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiBundleInspector;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiClassResolver;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiImplementationFinder.ImplHit;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiImplementationFinder.OsgiServiceHit;
import com.atlassian.labs.restbrowser.jaxrs.AnnotationFormatter;
import com.atlassian.labs.restbrowser.jaxrs.OpenApiAnnotationExtractor;
import com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge;
import com.atlassian.labs.restbrowser.jaxrs.TypeFormatter;
import com.atlassian.labs.restbrowser.json.Json;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import org.osgi.framework.Bundle;

import java.lang.annotation.Annotation;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.Parameter;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.security.CodeSource;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Serializes Java reflection/bytecode metadata, OSGi service/implementation hits, and JAX-RS DTO schema parts.
 */
final class ClassMetadataSerializer {

    private static final int MAX_METHOD_SUMMARIES = 80;
    private static final int MAX_INNER_CLASSES = 40;
    private static final int MAX_FIELDS = 80;
    private static final int MAX_ENUM_CONSTANTS = 200;

    private record MethodStats(int count, List<String> summaries) {
    }

    private record FieldSummary(String name, String type, String shortType, String modifiers,
                                String serializedName, List<String> annotations) {
    }

    private ClassMetadataSerializer() {
    }

    static String buildClassInfoUncached(ResolvedClassInfo resolved, List<String> precomputedRefs,
                                         boolean compact, boolean outline,
                                         PluginAccessor pluginAccessor, ProductAdapter product) {
        Class<?> c = resolved.loaded();
        if (c == null) {
            c = OsgiClassResolver.tryLoadClass(resolved.loader(), resolved.name());
        }
        List<String> refs = precomputedRefs != null
                ? precomputedRefs
                : ClassFileInspector.collectReferencedClasses(resolved.loader(), resolved.name(), resolved.bytes());
        String pkg = OperationTargetResolver.packageOf(resolved.name());
        String simple = OperationTargetResolver.simpleNameOf(resolved.name());
        BytecodeVersion bv = ClassFileInspector.readBytecodeVersion(resolved.bytes());

        Json j = new Json().beginObject()
                .field("format", 1)
                .field("name", resolved.name())
                .field("simpleName", simple)
                .field("package", pkg);

        if (c != null) {
            String kind = c.isAnnotation() ? "annotation" : c.isInterface() ? "interface"
                    : c.isEnum() ? "enum" : c.isRecord() ? "record" : "class";
            int modBits = c.getModifiers() & (c.isInterface() ? Modifier.interfaceModifiers() : Modifier.classModifiers());
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
                } catch (LinkageError | RuntimeException e) {
                    for (Class<?> iface : k.getInterfaces()) {
                        interfaces.add(iface.getName());
                    }
                }
            }
            MethodStats stats = inspectDeclaredMethods(c);
            List<FieldSummary> fields = inspectDeclaredFields(c);
            j.field("kind", kind)
                    .field("modifiers", Modifier.toString(modBits))
                    .field("deprecated", ReflectiveBridge.safeHasAnnotation(c, Deprecated.class))
                    .optional("superclass", supers.isEmpty() ? null : supers.get(0))
                    .strings("superclasses", supers)
                    .strings("interfaces", interfaces);
            if (!compact) {
                j.strings("annotations", AnnotationFormatter.annotations(c));
            }
            if (c.isEnum()) {
                j.strings("enumConstants", inspectEnumConstants(c));
            }
            Class<?> enclosing = safeEnclosing(c);
            j.optional("enclosingClass", enclosing == null ? null : enclosing.getName());
            if (!compact) {
                j.strings("innerClasses", safeInnerClasses(c));
            }
            j.field("fieldCount", fields.size());
            writeFieldSummaries(j, fields, !compact);
            j.field("constructorCount", safeConstructorCount(c))
                    .field("methodCount", stats.count)
                    .strings("methods", stats.summaries)
                    .field("codeSource", codeSource(c))
                    .field("classLoader", OsgiBundleInspector.clip(String.valueOf(c.getClassLoader())))
                    .field("origin", OsgiBundleInspector.origin(c));
        } else {
            j.field("kind", "class")
                    .field("modifiers", "")
                    .field("deprecated", false)
                    .strings("superclasses", List.of())
                    .strings("interfaces", List.of());
            if (!compact) {
                j.strings("annotations", List.of())
                        .strings("innerClasses", List.of());
            }
            j.field("fieldCount", 0)
                    .name("fields").beginArray().endArray()
                    .field("constructorCount", 0)
                    .field("methodCount", 0)
                    .strings("methods", List.of())
                    .field("codeSource", (String) null)
                    .field("classLoader", OsgiBundleInspector.clip(String.valueOf(resolved.loader())))
                    .field("origin", resolved.loader() == null ? "JDK" : resolved.loader().getClass().getSimpleName());
        }

        if (bv != null) {
            j.field("bytecodeVersion", bv.label());
            j.field("bytecodeMajor", bv.major());
        }
        j.field("bytecodeBytes", resolved.bytes() == null ? 0 : resolved.bytes().length);
        j.field("bundleId", resolved.bundleId());

        Bundle bundle = OsgiClassResolver.bundleByIdOrClass(resolved.bundleId(), c);
        if (bundle != null) {
            j.name("bundle");
            if (compact) {
                j.beginObject()
                        .field("id", bundle.getBundleId())
                        .field("symbolicName", bundle.getSymbolicName())
                        .field("version", String.valueOf(bundle.getVersion()))
                        .field("state", OsgiBundleInspector.state(bundle.getState()))
                        .endObject();
            } else {
                OsgiBundleInspector.writeBundleSummary(j, bundle, pkg);
            }
            Plugin owner = AtlassianPluginInspector.pluginForBundle(pluginAccessor, bundle);
            if (owner != null) {
                j.name("plugin");
                AtlassianPluginInspector.writePluginSummary(j, owner, product);
            }
        }
        j.field("refCount", refs.size());
        if (!compact) {
            j.strings("refs", refs);
        }
        if (outline) {
            List<MethodOutline> outlines = ClassFileInspector.readMethodOutlines(resolved.bytes());
            j.name("outline").beginArray();
            for (MethodOutline mo : outlines) {
                j.beginObject()
                        .field("name", mo.name())
                        .field("signature", mo.signature())
                        .field("startLine", mo.startLine())
                        .field("endLine", mo.endLine())
                        .endObject();
            }
            j.endArray();
        }
        j.endObject();
        return j.toString();
    }

    static String serializeServices(List<OsgiServiceHit> hits) {
        Json j = new Json().beginArray();
        for (OsgiServiceHit s : hits) {
            j.beginObject()
                    .field("serviceId", s.serviceId())
                    .field("bundleId", s.bundleId())
                    .optional("bundle", s.bundleLabel())
                    .optional("plugin", s.pluginKey())
                    .optional("beanName", s.beanName())
                    .field("ranking", s.ranking())
                    .strings("objectClass", s.objectClass())
                    .endObject();
        }
        return j.endArray().toString();
    }

    static String serializeImplHits(List<ImplHit> hits) {
        Json j = new Json().beginArray();
        for (ImplHit h : hits) {
            j.beginObject()
                    .field("class", h.fqcn())
                    .field("simpleName", h.simpleName())
                    .field("kind", h.kind())
                    .field("via", h.via())
                    .field("bundleId", h.bundleId())
                    .optional("bundle", h.bundleLabel())
                    .optional("plugin", h.pluginKey())
                    .endObject();
        }
        return j.endArray().toString();
    }

    static SchemaResult inspectTypeSchema(Type type, List<ClassLoader> loaders, int depth) {
        Class<?> raw = type instanceof Class<?> c ? c
                : (type instanceof ParameterizedType pt && pt.getRawType() instanceof Class<?> rc ? rc : null);
        if (raw == null) {
            String tn = TypeFormatter.stableTypeName(type, null);
            if (tn != null) {
                int lt = tn.indexOf('<');
                String base = (lt > 0 ? tn.substring(0, lt) : tn).replace("[]", "").trim();
                ResolvedClassInfo r = OsgiClassResolver.resolveFromCandidates(List.of(base), loaders);
                raw = r == null ? null : ensureLoadedClass(r);
            }
        }
        if (raw == null && !(type instanceof ParameterizedType)) {
            return null;
        }
        return DtoSchemaInspector.inspect(type, raw, depth, true);
    }

    static void writeOperationSchemaPart(Json j, Type type, List<ClassLoader> loaders,
                                         int depth, boolean includeExample) {
        Class<?> raw = type instanceof Class<?> c ? c
                : (type instanceof ParameterizedType pt && pt.getRawType() instanceof Class<?> rc ? rc : null);
        if (raw == null && type != null) {
            String tn = TypeFormatter.stableTypeName(type, null);
            if (tn != null) {
                int lt = tn.indexOf('<');
                String base = (lt > 0 ? tn.substring(0, lt) : tn).replace("[]", "").trim();
                ResolvedClassInfo r = OsgiClassResolver.resolveFromCandidates(List.of(base), loaders);
                raw = r == null ? null : ensureLoadedClass(r);
            }
        }
        if (raw == null && type == null) {
            j.beginObject().field("error", "unresolvable-type").endObject();
            return;
        }
        SchemaResult sr = DtoSchemaInspector.inspect(type != null ? type : raw, raw, depth, includeExample);
        j.beginObject()
                .field("javaType", sr.javaType())
                .field("typesVisited", sr.typesVisited())
                .field("truncated", sr.truncated())
                .name("schema").raw(sr.schemaJson());
        if (sr.exampleJson() != null) {
            j.name("example").raw(sr.exampleJson());
        }
        j.endObject();
    }

    static Type findEntityParameterType(Method handling, Method def) {
        if (handling == null) {
            return null;
        }
        Parameter[] hParams = handling.getParameters();
        Parameter[] dParams = def != null && def.getParameterCount() == hParams.length ? def.getParameters() : null;
        for (int i = 0; i < hParams.length; i++) {
            Parameter hp = hParams[i];
            Parameter dp = dParams == null ? null : dParams[i];
            if (hasJaxRsBindingAnnotation(hp) || (dp != null && hasJaxRsBindingAnnotation(dp))) {
                continue;
            }
            Class<?> raw = hp.getType();
            if (raw.getName().startsWith("jakarta.servlet.") || raw.getName().startsWith("javax.servlet.")
                    || raw.getName().startsWith("jakarta.ws.rs.core.") || raw.getName().startsWith("javax.ws.rs.core.")) {
                continue;
            }
            Type generic;
            try {
                generic = hp.getParameterizedType();
            } catch (RuntimeException | LinkageError e) {
                generic = raw;
            }
            return TypeProxyUnwrapper.targetClass(raw) != raw ? TypeProxyUnwrapper.targetClass(raw) : generic;
        }
        return null;
    }

    static Type resolveOperationReturnType(Method handling, Method def, List<ClassLoader> loaders) {
        if (handling == null) {
            return null;
        }
        Class<?> raw = handling.getReturnType();
        if (raw == void.class || raw == Void.class) {
            return null;
        }
        String rawName = raw.getName();
        boolean isWrapper = rawName.equals("jakarta.ws.rs.core.Response")
                || rawName.equals("javax.ws.rs.core.Response")
                || raw == Object.class;
        if (isWrapper) {
            String annotated = OpenApiAnnotationExtractor.annotatedReturnJavaType(def, handling);
            if (annotated != null && !annotated.isBlank()) {
                int lt = annotated.indexOf('<');
                String base = (lt > 0 ? annotated.substring(0, lt) : annotated).replace("[]", "").trim();
                ResolvedClassInfo r = OsgiClassResolver.resolveFromCandidates(List.of(base), loaders);
                Class<?> resolvedCls = r == null ? null : ensureLoadedClass(r);
                if (resolvedCls != null) {
                    return resolvedCls;
                }
            }
        }
        try {
            return handling.getGenericReturnType();
        } catch (RuntimeException | LinkageError e) {
            return raw;
        }
    }

    static Class<?> ensureLoadedClass(ResolvedClassInfo resolved) {
        if (resolved.loaded() != null) {
            return resolved.loaded();
        }
        return OsgiClassResolver.tryLoadClass(resolved.loader(), resolved.name());
    }

    static int safeMethodCount(Class<?> c) {
        if (c == null) {
            return 0;
        }
        try {
            int count = 0;
            for (Method m : c.getDeclaredMethods()) {
                if (!m.isSynthetic() && !m.isBridge()) {
                    count++;
                }
            }
            return count;
        } catch (LinkageError | RuntimeException e) {
            return 0;
        }
    }

    private static boolean hasJaxRsBindingAnnotation(Parameter p) {
        for (Annotation a : ReflectiveBridge.safeDeclaredAnnotations(p)) {
            String n = a.annotationType().getName();
            if (n.endsWith("Param") || n.endsWith(".Context") || n.endsWith(".Suspended")
                    || n.endsWith(".BeanParam") || n.endsWith(".MultipartFormParam") || n.endsWith(".FormDataParam")) {
                return true;
            }
        }
        return false;
    }

    private static MethodStats inspectDeclaredMethods(Class<?> c) {
        try {
            Method[] methods = c.getDeclaredMethods();
            Arrays.sort(methods, Comparator.comparing(Method::getName).thenComparingInt(Method::getParameterCount));
            int count = 0;
            List<String> summaries = new ArrayList<>();
            for (Method m : methods) {
                if (m.isSynthetic() || m.isBridge()) {
                    continue;
                }
                count++;
                if (summaries.size() < MAX_METHOD_SUMMARIES) {
                    StringBuilder sb = new StringBuilder();
                    String mods = Modifier.toString(m.getModifiers() & Modifier.methodModifiers());
                    if (!mods.isEmpty()) {
                        sb.append(mods).append(' ');
                    }
                    sb.append(TypeFormatter.shortTypeName(safeGenericReturnType(m))).append(' ')
                            .append(m.getName()).append('(');
                    Type[] pts = safeGenericParameterTypes(m);
                    for (int i = 0; i < pts.length; i++) {
                        if (i > 0) {
                            sb.append(", ");
                        }
                        sb.append(TypeFormatter.shortTypeName(pts[i]));
                    }
                    sb.append(')');
                    summaries.add(sb.toString());
                }
            }
            return new MethodStats(count, summaries);
        } catch (LinkageError | RuntimeException e) {
            return new MethodStats(0, List.of());
        }
    }

    private static Type safeGenericReturnType(Method m) {
        try {
            return m.getGenericReturnType();
        } catch (RuntimeException | LinkageError e) {
            return m.getReturnType();
        }
    }

    private static Type[] safeGenericParameterTypes(Method m) {
        try {
            return m.getGenericParameterTypes();
        } catch (RuntimeException | LinkageError e) {
            return m.getParameterTypes();
        }
    }

    private static Class<?> safeEnclosing(Class<?> c) {
        try {
            return c.getEnclosingClass();
        } catch (LinkageError | RuntimeException e) {
            return null;
        }
    }

    private static List<String> safeInnerClasses(Class<?> c) {
        try {
            Class<?>[] declared = c.getDeclaredClasses();
            List<String> out = new ArrayList<>(Math.min(declared.length, MAX_INNER_CLASSES));
            for (int i = 0; i < declared.length && out.size() < MAX_INNER_CLASSES; i++) {
                out.add(declared[i].getName());
            }
            return out;
        } catch (LinkageError | RuntimeException e) {
            return List.of();
        }
    }

    private static List<FieldSummary> inspectDeclaredFields(Class<?> c) {
        Field[] raw;
        try {
            raw = c.getDeclaredFields();
        } catch (LinkageError | RuntimeException e) {
            return List.of();
        }
        List<FieldSummary> out = new ArrayList<>();
        for (Field f : raw) {
            if (f.isSynthetic()) {
                continue;
            }
            if (out.size() >= MAX_FIELDS) {
                break;
            }
            Type gType;
            try {
                gType = f.getGenericType();
            } catch (RuntimeException | LinkageError e) {
                gType = f.getType();
            }
            String fullType = TypeFormatter.stableTypeName(gType, f.getType());
            String shortType = TypeFormatter.shortTypeName(fullType);
            String mods = Modifier.toString(f.getModifiers());
            String serialized = DtoSchemaInspector.serializedFieldName(f);
            List<String> anns = AnnotationFormatter.annotations(f);
            out.add(new FieldSummary(f.getName(), fullType, shortType, mods, serialized, anns));
        }
        return out;
    }

    private static void writeFieldSummaries(Json j, List<FieldSummary> fields, boolean includeAnnotations) {
        j.name("fields").beginArray();
        for (FieldSummary f : fields) {
            j.beginObject()
                    .field("name", f.name())
                    .optional("type", f.type())
                    .optional("shortType", f.shortType())
                    .field("modifiers", f.modifiers())
                    .optional("serializedName", f.serializedName());
            if (includeAnnotations && !f.annotations().isEmpty()) {
                j.strings("annotations", f.annotations());
            }
            j.endObject();
        }
        j.endArray();
    }

    private static List<String> inspectEnumConstants(Class<?> c) {
        try {
            Object[] all = c.getEnumConstants();
            if (all == null) {
                return List.of();
            }
            List<String> names = new ArrayList<>(Math.min(all.length, MAX_ENUM_CONSTANTS));
            for (Object item : all) {
                if (names.size() >= MAX_ENUM_CONSTANTS) {
                    break;
                }
                names.add(((Enum<?>) item).name());
            }
            return names;
        } catch (RuntimeException | LinkageError e) {
            return List.of();
        }
    }

    private static int safeConstructorCount(Class<?> c) {
        try {
            Constructor<?>[] cs = c.getDeclaredConstructors();
            return cs.length;
        } catch (LinkageError | RuntimeException e) {
            return 0;
        }
    }

    private static String codeSource(Class<?> c) {
        try {
            CodeSource cs = c.getProtectionDomain().getCodeSource();
            return cs == null || cs.getLocation() == null ? null : OsgiBundleInspector.clip(cs.getLocation().toString());
        } catch (RuntimeException e) {
            return null;
        }
    }
}
