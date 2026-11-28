package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.Model.Param;
import com.atlassian.labs.restbrowser.inspect.TypeProxyUnwrapper;

import java.lang.annotation.Annotation;
import java.lang.reflect.AnnotatedElement;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge.annString;
import static com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge.safeAnnotations;
import static com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge.safeHasAnnotation;

/**
 * Pure reflection/annotation helpers for {@link JerseyModelSource}: access-level resolution, deprecation checks,
 * multipart parameter metadata, JAX-RS template path completion, enum options, and media-type extraction.
 */
final class JerseyAnnotationSupport {

    private static final String ATLASSIAN_MULTIPART_PARAM = "com.atlassian.plugins.rest.api.multipart.MultipartFormParam";
    private static final String JERSEY_FORM_DATA_PARAM = "org.glassfish.jersey.media.multipart.FormDataParam";

    static final Set<String> ACCESS_ANNOTATIONS = Set.of(
            "SystemAdminOnly", "AdminOnly", "LicensedOnly",
            "UnlicensedSiteAccess", "AnonymousSiteAccess", "UnrestrictedAccess", "AnonymousAllowed");

    private JerseyAnnotationSupport() {
    }

    /** Child method / locator parameters replace inherited parameters with the same (in, name). */
    static List<Param> mergeParams(List<Param> inherited, List<Param> own) {
        if (inherited.isEmpty()) {
            return own;
        }
        if (own.isEmpty()) {
            return inherited;
        }
        Map<String, Param> merged = new LinkedHashMap<>();
        for (Param p : inherited) {
            merged.put(p.in() + ":" + p.name(), p);
        }
        for (Param p : own) {
            merged.put(p.in() + ":" + p.name(), p);
        }
        return new ArrayList<>(merged.values());
    }

    static List<String> options(Class<?> c) {
        if (c == null || !c.isEnum()) {
            return List.of();
        }
        List<String> names = new ArrayList<>();
        try {
            Object[] constants = c.getEnumConstants();
            if (constants != null) {
                for (Object constant : constants) {
                    names.add(((Enum<?>) constant).name());
                }
            }
        } catch (LinkageError | RuntimeException ignored) {
            return List.of();
        }
        return List.copyOf(names);
    }

    static String access(Method def, Method handling, Class<?> handlerClass) {
        String a = accessOf(def);
        if (a == null && handling != null && !handling.equals(def)) {
            a = accessOf(handling);
        }
        if (a == null && handlerClass != null) {
            a = classHierarchyAccessOf(handlerClass);
        }
        if (a == null && handling != null) {
            a = classHierarchyAccessOf(handling.getDeclaringClass());
        }
        if (a == null && def != null && (handling == null || def.getDeclaringClass() != handling.getDeclaringClass())) {
            a = classHierarchyAccessOf(def.getDeclaringClass());
        }
        if (a == null && handlerClass != null) {
            a = accessOf(TypeProxyUnwrapper.targetClass(handlerClass).getPackage());
        }
        if (a == null && handling != null) {
            a = accessOf(handling.getDeclaringClass().getPackage());
        }
        if (a == null && def != null && (handling == null || def.getDeclaringClass() != handling.getDeclaringClass())) {
            a = accessOf(def.getDeclaringClass().getPackage());
        }
        return a;
    }

    static boolean isDeprecated(Method def, Method handling, Class<?> handlerClass) {
        return safeHasAnnotation(def, Deprecated.class)
                || safeHasAnnotation(handling, Deprecated.class)
                || isClassHierarchyDeprecated(handlerClass)
                || isClassHierarchyDeprecated(handling == null ? null : handling.getDeclaringClass())
                || isClassHierarchyDeprecated(def == null ? null : def.getDeclaringClass());
    }

    private static String classHierarchyAccessOf(Class<?> start) {
        if (start == null) {
            return null;
        }
        for (Class<?> c = TypeProxyUnwrapper.targetClass(start); c != null && c != Object.class; c = c.getSuperclass()) {
            String a = accessOf(c);
            if (a != null) {
                return a;
            }
            String iface = interfaceAccessOf(c.getInterfaces());
            if (iface != null) {
                return iface;
            }
        }
        return null;
    }

    private static String interfaceAccessOf(Class<?>[] interfaces) {
        if (interfaces == null) {
            return null;
        }
        for (Class<?> iface : interfaces) {
            String a = accessOf(iface);
            if (a != null) {
                return a;
            }
            String parent = interfaceAccessOf(iface.getInterfaces());
            if (parent != null) {
                return parent;
            }
        }
        return null;
    }

    private static boolean isClassHierarchyDeprecated(Class<?> start) {
        if (start == null) {
            return false;
        }
        for (Class<?> c = TypeProxyUnwrapper.targetClass(start); c != null && c != Object.class; c = c.getSuperclass()) {
            if (safeHasAnnotation(c, Deprecated.class) || isInterfaceDeprecated(c.getInterfaces())) {
                return true;
            }
        }
        return false;
    }

    private static boolean isInterfaceDeprecated(Class<?>[] interfaces) {
        if (interfaces == null) {
            return false;
        }
        for (Class<?> iface : interfaces) {
            if (safeHasAnnotation(iface, Deprecated.class) || isInterfaceDeprecated(iface.getInterfaces())) {
                return true;
            }
        }
        return false;
    }

    private static String accessOf(AnnotatedElement element) {
        for (Annotation a : safeAnnotations(element)) {
            try {
                Class<? extends Annotation> type = a.annotationType();
                if (type.getName().startsWith("com.atlassian.") && ACCESS_ANNOTATIONS.contains(type.getSimpleName())) {
                    return type.getSimpleName();
                }
            } catch (RuntimeException | LinkageError ignored) {
                // skip unreadable annotation
            }
        }
        return null;
    }

    static String firstNonNull(String a, String b) {
        return a != null ? a : b;
    }

    static String multipartParamName(Annotation[] annotations) {
        if (annotations == null) {
            return null;
        }
        for (Annotation a : annotations) {
            try {
                String name = a.annotationType().getName();
                if (ATLASSIAN_MULTIPART_PARAM.equals(name) || JERSEY_FORM_DATA_PARAM.equals(name)) {
                    String v = annString(a, "value");
                    if (v != null && !v.isBlank()) {
                        return v.trim();
                    }
                }
            } catch (RuntimeException | LinkageError ignored) {
                // ignore unreadable annotation
            }
        }
        return null;
    }

    static boolean isFileType(Class<?> c) {
        if (c == null) {
            return false;
        }
        if (c == java.io.File.class || c == java.io.InputStream.class) {
            return true;
        }
        String n = c.getName();
        return n.endsWith(".FilePart") || n.endsWith(".FormDataBodyPart");
    }

    static List<Param> applyParamDocs(List<Param> params, Map<String, String> docs) {
        if (docs.isEmpty() || params.isEmpty()) {
            return params;
        }
        List<Param> out = new ArrayList<>(params.size());
        for (Param p : params) {
            if (p.description() != null) {
                out.add(p);
            } else {
                String d = docs.get(p.in() + ":" + p.name());
                if (d == null) {
                    d = docs.get(":" + p.name());
                }
                out.add(d == null ? p : p.withDescription(d));
            }
        }
        return List.copyOf(out);
    }

    static boolean isGenericResponseWrapper(Class<?> c) {
        if (c == null || c == Object.class) {
            return true;
        }
        String n = c.getName();
        return "jakarta.ws.rs.core.Response".equals(n) || "javax.ws.rs.core.Response".equals(n);
    }

    static List<Param> completePathParams(String path, List<Param> params) {
        Map<String, Param> unique = new LinkedHashMap<>();
        for (Param p : params) {
            unique.putIfAbsent(p.in() + ":" + p.name(), p);
        }
        for (String name : templateNames(path)) {
            unique.putIfAbsent("path:" + name, new Param(name, "path", "string", true, null, List.of(), false));
        }
        return List.copyOf(unique.values());
    }

    static List<String> templateNames(String path) {
        List<String> names = new ArrayList<>();
        int depth = 0;
        StringBuilder current = null;
        for (int i = 0; i < path.length(); i++) {
            char c = path.charAt(i);
            if (c == '{') {
                if (depth++ == 0) {
                    current = new StringBuilder();
                    continue;
                }
            } else if (c == '}') {
                depth = Math.max(0, depth - 1);
                if (depth == 0 && current != null) {
                    String t = current.toString();
                    int colon = t.indexOf(':');
                    String name = (colon < 0 ? t : t.substring(0, colon)).trim();
                    if (!name.isEmpty()) {
                        names.add(name);
                    }
                    current = null;
                    continue;
                }
            }
            if (depth > 0 && current != null) {
                current.append(c);
            }
        }
        return names;
    }

    static List<String> mediaTypes(Object list) {
        List<String> out = new ArrayList<>();
        if (list instanceof List<?> items) {
            for (Object m : items) {
                out.add(String.valueOf(m));
            }
        }
        return List.copyOf(out);
    }

    static String join(String prefix, String path) {
        StringBuilder sb = new StringBuilder();
        for (String part : new String[]{prefix, path}) {
            if (part == null) {
                continue;
            }
            String p = part;
            while (p.startsWith("/")) {
                p = p.substring(1);
            }
            while (p.endsWith("/")) {
                p = p.substring(0, p.length() - 1);
            }
            if (!p.isEmpty()) {
                if (sb.length() > 0) {
                    sb.append('/');
                }
                sb.append(p);
            }
        }
        return sb.toString();
    }
}
