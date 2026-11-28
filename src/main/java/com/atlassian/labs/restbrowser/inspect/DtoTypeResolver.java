package com.atlassian.labs.restbrowser.inspect;

import com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge;

import java.lang.annotation.Annotation;
import java.lang.reflect.AnnotatedElement;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.RecordComponent;
import java.lang.reflect.Type;
import java.lang.reflect.TypeVariable;
import java.lang.reflect.WildcardType;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge.annMember;
import static com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge.annString;
import static com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge.safeDeclaredAnnotations;

/**
 * Resolves Java DTO generic types, bean/record properties, Jackson/JAXB/OpenAPI/Bean Validation annotations,
 * enum constants, and polymorphic subtypes purely via {@link ReflectiveBridge}.
 */
final class DtoTypeResolver {

    record PropSpec(String jsonName, String javaName, Type genericType, Class<?> rawType,
                    boolean required, String description, String example,
                    Long min, Long max, Integer minSize, Integer maxSize,
                    String pattern, boolean nullable) {
    }

    private DtoTypeResolver() {
    }

    static String explicitSerializedName(Annotation[] annotations) {
        String xmlName = null;
        for (Annotation a : annotations) {
            String annName = annTypeName(a);
            if ("com.fasterxml.jackson.annotation.JsonProperty".equals(annName)
                    || "org.codehaus.jackson.annotate.JsonProperty".equals(annName)) {
                String v = cleanNonBlank(annString(a, "value"));
                if (v != null) {
                    return v;
                }
            } else if ("jakarta.xml.bind.annotation.XmlElement".equals(annName)
                    || "javax.xml.bind.annotation.XmlElement".equals(annName)
                    || "jakarta.xml.bind.annotation.XmlAttribute".equals(annName)
                    || "javax.xml.bind.annotation.XmlAttribute".equals(annName)) {
                String v = cleanNonBlank(annString(a, "name"));
                if (v != null && !"##default".equals(v)) {
                    xmlName = v;
                }
            }
        }
        return xmlName;
    }

    static List<PropSpec> extractProperties(Class<?> cls, Map<TypeVariable<?>, Type> scopeVars) {
        if (cls.isRecord()) {
            try {
                RecordComponent[] comps = cls.getRecordComponents();
                List<PropSpec> list = new ArrayList<>(comps.length);
                for (RecordComponent rc : comps) {
                    Annotation[] anns = safeAnnotationsMerged(rc, safeField(cls, rc.getName()), rc.getAccessor());
                    if (isIgnored(anns)) {
                        continue;
                    }
                    list.add(buildProp(rc.getName(), rc.getGenericType(), rc.getType(), anns, scopeVars));
                }
                return list;
            } catch (RuntimeException | LinkageError ignored) {
                // fall through
            }
        }

        List<Class<?>> chain = new ArrayList<>();
        Set<String> ignoredNames = new HashSet<>();
        for (Class<?> cur = cls; cur != null && cur != Object.class; cur = cur.getSuperclass()) {
            chain.add(cur);
            collectClassIgnoredProps(cur, ignoredNames);
        }

        Map<String, PropBuilder> merged = new LinkedHashMap<>();
        // Walk superclass -> subclass so inherited fields appear first naturally
        for (int ci = chain.size() - 1; ci >= 0; ci--) {
            Class<?> cur = chain.get(ci);
            Map<TypeVariable<?>, Type> classVars = typeVarsForAncestor(cls, cur, scopeVars);
            Field[] fields;
            try {
                fields = cur.getDeclaredFields();
            } catch (RuntimeException | LinkageError e) {
                fields = new Field[0];
            }
            for (Field f : fields) {
                if (f.isSynthetic() || Modifier.isStatic(f.getModifiers()) || Modifier.isTransient(f.getModifiers())) {
                    continue;
                }
                String jName = f.getName();
                if (ignoredNames.contains(jName)) {
                    continue;
                }
                PropBuilder b = merged.computeIfAbsent(jName, PropBuilder::new);
                b.addField(f, safeDeclaredAnnotations(f), classVars);
            }

            Method[] methods;
            try {
                methods = cur.getDeclaredMethods();
            } catch (RuntimeException | LinkageError e) {
                methods = new Method[0];
            }
            for (Method m : methods) {
                if (!Modifier.isPublic(m.getModifiers()) || Modifier.isStatic(m.getModifiers())
                        || m.isSynthetic() || m.isBridge() || m.getParameterCount() != 0
                        || m.getReturnType() == void.class) {
                    continue;
                }
                String propName = getterPropName(m);
                if (propName == null || ignoredNames.contains(propName)) {
                    continue;
                }
                PropBuilder b = merged.computeIfAbsent(propName, PropBuilder::new);
                b.addMethod(m, safeDeclaredAnnotations(m), classVars);
            }
        }

        List<PropSpec> result = new ArrayList<>(merged.size());
        for (PropBuilder b : merged.values()) {
            if (!b.ignored) {
                result.add(b.build());
            }
        }
        return result;
    }

    private static final class PropBuilder {
        final String javaName;
        Type genericType;
        Class<?> rawType;
        Map<TypeVariable<?>, Type> ownerVars = Map.of();
        final List<Annotation> annotations = new ArrayList<>();
        boolean ignored;

        PropBuilder(String javaName) {
            this.javaName = javaName;
        }

        void addField(Field f, Annotation[] anns, Map<TypeVariable<?>, Type> vars) {
            if (isIgnored(anns)) {
                ignored = true;
            }
            if (this.genericType == null) {
                try {
                    this.genericType = f.getGenericType();
                } catch (RuntimeException | LinkageError e) {
                    this.genericType = f.getType();
                }
                this.rawType = f.getType();
                this.ownerVars = vars;
            }
            Collections.addAll(annotations, anns);
        }

        void addMethod(Method m, Annotation[] anns, Map<TypeVariable<?>, Type> vars) {
            if (isIgnored(anns)) {
                ignored = true;
            }
            if (this.genericType == null) {
                try {
                    this.genericType = m.getGenericReturnType();
                } catch (RuntimeException | LinkageError e) {
                    this.genericType = m.getReturnType();
                }
                this.rawType = m.getReturnType();
                this.ownerVars = vars;
            }
            Collections.addAll(annotations, anns);
        }

        PropSpec build() {
            return buildProp(javaName, genericType, rawType, annotations.toArray(new Annotation[0]), ownerVars);
        }
    }

    private static PropSpec buildProp(String javaName, Type genericType, Class<?> rawType, Annotation[] anns,
                                      Map<TypeVariable<?>, Type> vars) {
        String customName = explicitSerializedName(anns);
        String jsonName = customName != null ? customName : javaName;
        boolean required = false;
        String description = null;
        String example = null;
        Long min = null;
        Long max = null;
        Integer minSize = null;
        Integer maxSize = null;
        String pattern = null;
        boolean nullable = false;
        Type effectiveType = substitute(genericType, vars);
        Class<?> effectiveRaw = rawType;

        for (Annotation a : anns) {
            String n = annTypeName(a);
            if (n == null) {
                continue;
            }
            if (n.endsWith(".NotNull") || n.endsWith(".NotBlank") || n.endsWith(".NotEmpty")) {
                required = true;
                if (n.endsWith(".NotBlank") || n.endsWith(".NotEmpty")) {
                    minSize = minSize == null ? 1 : Math.max(minSize, 1);
                }
            } else if ("com.fasterxml.jackson.annotation.JsonProperty".equals(n)
                    || "jakarta.xml.bind.annotation.XmlElement".equals(n)
                    || "javax.xml.bind.annotation.XmlElement".equals(n)
                    || "jakarta.xml.bind.annotation.XmlAttribute".equals(n)
                    || "javax.xml.bind.annotation.XmlAttribute".equals(n)) {
                if (Boolean.TRUE.equals(annMember(a, "required"))) {
                    required = true;
                }
            } else if (n.endsWith(".Size")) {
                Object mn = annMember(a, "min");
                Object mx = annMember(a, "max");
                if (mn instanceof Integer i && i > 0) {
                    minSize = i;
                }
                if (mx instanceof Integer i && i < Integer.MAX_VALUE) {
                    maxSize = i;
                }
            } else if (n.endsWith(".Min")) {
                Object v = annMember(a, "value");
                if (v instanceof Long l) {
                    min = l;
                }
            } else if (n.endsWith(".Max")) {
                Object v = annMember(a, "value");
                if (v instanceof Long l) {
                    max = l;
                }
            } else if (n.endsWith(".Pattern")) {
                String p = cleanNonBlank(annString(a, "regexp"));
                if (p != null) {
                    pattern = p;
                }
            } else if ("io.swagger.v3.oas.annotations.media.Schema".equals(n)) {
                if (description == null) {
                    description = cleanNonBlank(annString(a, "description"));
                }
                if (example == null) {
                    example = cleanNonBlank(annString(a, "example"));
                }
                if (Boolean.TRUE.equals(annMember(a, "required"))) {
                    required = true;
                }
                if (Boolean.TRUE.equals(annMember(a, "nullable"))) {
                    nullable = true;
                }
                Object impl = annMember(a, "implementation");
                if (impl instanceof Class<?> c && c != Void.class && c != void.class && c != Object.class) {
                    effectiveType = c;
                    effectiveRaw = c;
                }
            } else if ("com.fasterxml.jackson.databind.annotation.JsonDeserialize".equals(n)
                    || "com.fasterxml.jackson.databind.annotation.JsonSerialize".equals(n)) {
                Object as = annMember(a, "as");
                if (as instanceof Class<?> c && c != Void.class && c != Object.class) {
                    effectiveType = c;
                    effectiveRaw = c;
                }
            }
        }
        return new PropSpec(jsonName, javaName, effectiveType, effectiveRaw, required, description, example,
                min, max, minSize, maxSize, pattern, nullable);
    }

    private static boolean isIgnored(Annotation[] anns) {
        for (Annotation a : anns) {
            String n = annTypeName(a);
            if ("com.fasterxml.jackson.annotation.JsonIgnore".equals(n)
                    || "org.codehaus.jackson.annotate.JsonIgnore".equals(n)) {
                return !Boolean.FALSE.equals(annMember(a, "value"));
            }
            if ("jakarta.xml.bind.annotation.XmlTransient".equals(n)
                    || "javax.xml.bind.annotation.XmlTransient".equals(n)) {
                return true;
            }
        }
        return false;
    }

    private static void collectClassIgnoredProps(Class<?> c, Set<String> ignored) {
        for (Annotation a : safeDeclaredAnnotations(c)) {
            String n = annTypeName(a);
            if ("com.fasterxml.jackson.annotation.JsonIgnoreProperties".equals(n)
                    || "org.codehaus.jackson.annotate.JsonIgnoreProperties".equals(n)) {
                Object v = annMember(a, "value");
                if (v instanceof String[] arr) {
                    for (String s : arr) {
                        if (s != null && !s.isBlank()) {
                            ignored.add(s.trim());
                        }
                    }
                }
            }
        }
    }

    static List<String> polymorphicSubtypes(Class<?> c) {
        List<String> out = new ArrayList<>();
        for (Annotation a : safeDeclaredAnnotations(c)) {
            String n = annTypeName(a);
            if ("com.fasterxml.jackson.annotation.JsonSubTypes".equals(n)
                    || "org.codehaus.jackson.annotate.JsonSubTypes".equals(n)) {
                Object v = annMember(a, "value");
                if (v instanceof Annotation[] arr) {
                    for (Annotation sub : arr) {
                        Object t = annMember(sub, "value");
                        if (t instanceof Class<?> subCls) {
                            out.add(subCls.getName());
                        }
                    }
                }
            }
        }
        return out;
    }

    private static String getterPropName(Method m) {
        String name = m.getName();
        if (name.startsWith("get") && name.length() > 3 && !"getClass".equals(name)) {
            return decapitalize(name.substring(3));
        }
        if (name.startsWith("is") && name.length() > 2
                && (m.getReturnType() == boolean.class || m.getReturnType() == Boolean.class)) {
            return decapitalize(name.substring(2));
        }
        return null;
    }

    private static String decapitalize(String s) {
        if (s == null || s.isEmpty()) {
            return s;
        }
        if (s.length() > 1 && Character.isUpperCase(s.charAt(1)) && Character.isUpperCase(s.charAt(0))) {
            return s;
        }
        char[] c = s.toCharArray();
        c[0] = Character.toLowerCase(c[0]);
        return new String(c);
    }

    static boolean isOpaqueLibraryType(Class<?> c) {
        if (c == null || c.isPrimitive()) {
            return false;
        }
        String n = c.getName();
        return n.startsWith("java.") || n.startsWith("javax.") || n.startsWith("jakarta.")
                || n.startsWith("jdk.") || n.startsWith("sun.") || n.startsWith("org.osgi.");
    }

    static Type substitute(Type t, Map<TypeVariable<?>, Type> vars) {
        if (t instanceof TypeVariable<?> tv && vars.containsKey(tv)) {
            return vars.get(tv);
        }
        if (t instanceof ParameterizedType pt && !vars.isEmpty()) {
            Type[] orig = pt.getActualTypeArguments();
            Type[] replaced = new Type[orig.length];
            boolean changed = false;
            for (int i = 0; i < orig.length; i++) {
                replaced[i] = substitute(orig[i], vars);
                if (replaced[i] != orig[i]) {
                    changed = true;
                }
            }
            if (changed) {
                return new ResolvedParameterizedType(pt.getRawType(), pt.getOwnerType(), replaced);
            }
        }
        if (t instanceof WildcardType wt) {
            Type[] upper = wt.getUpperBounds();
            if (upper != null && upper.length > 0 && upper[0] != Object.class) {
                return substitute(upper[0], vars);
            }
            return Object.class;
        }
        return t;
    }

    private record ResolvedParameterizedType(Type rawType, Type ownerType, Type[] actualTypeArguments)
            implements ParameterizedType {
        @Override public Type[] getActualTypeArguments() { return actualTypeArguments; }
        @Override public Type getRawType() { return rawType; }
        @Override public Type getOwnerType() { return ownerType; }
    }

    static Map<TypeVariable<?>, Type> bindTypeArgs(Class<?> raw, Type type, Map<TypeVariable<?>, Type> outerVars) {
        if (!(type instanceof ParameterizedType pt)) {
            return outerVars;
        }
        TypeVariable<?>[] params = raw.getTypeParameters();
        Type[] args = pt.getActualTypeArguments();
        if (params.length == 0 || args.length == 0) {
            return outerVars;
        }
        Map<TypeVariable<?>, Type> next = new HashMap<>(outerVars);
        for (int i = 0; i < Math.min(params.length, args.length); i++) {
            next.put(params[i], substitute(args[i], outerVars));
        }
        return next;
    }

    private static Map<TypeVariable<?>, Type> typeVarsForAncestor(Class<?> leaf, Class<?> target,
                                                                    Map<TypeVariable<?>, Type> leafVars) {
        if (leaf == target) {
            return leafVars;
        }
        Map<TypeVariable<?>, Type> vars = new HashMap<>(leafVars);
        for (Class<?> cur = leaf; cur != null && cur != target && cur != Object.class; cur = cur.getSuperclass()) {
            Type sup;
            try {
                sup = cur.getGenericSuperclass();
            } catch (RuntimeException | LinkageError e) {
                break;
            }
            if (sup instanceof ParameterizedType pt && cur.getSuperclass() != null) {
                vars = bindTypeArgs(cur.getSuperclass(), pt, vars);
            }
        }
        return vars;
    }

    static Class<?> rawClassOf(Type t, Class<?> fallback) {
        if (t instanceof Class<?> c) {
            return c;
        }
        if (t instanceof ParameterizedType pt && pt.getRawType() instanceof Class<?> c) {
            return c;
        }
        return fallback;
    }

    static Type firstTypeArg(Type t) {
        Type[] args = typeArgs(t);
        return args.length > 0 ? args[0] : null;
    }

    static Type[] typeArgs(Type t) {
        if (t instanceof ParameterizedType pt) {
            return pt.getActualTypeArguments();
        }
        return new Type[0];
    }

    static List<String> enumConstants(Class<?> c, int limit) {
        List<String> out = new ArrayList<>();
        try {
            Object[] all = c.getEnumConstants();
            if (all != null) {
                for (Object o : all) {
                    if (out.size() >= limit) {
                        break;
                    }
                    out.add(((Enum<?>) o).name());
                }
            }
        } catch (RuntimeException | LinkageError ignored) {
            // unreadable enum
        }
        return out;
    }

    static PropSpec withNullable(PropSpec meta, boolean nullable) {
        if (meta == null) {
            return new PropSpec("", "", Object.class, Object.class, false, null, null, null, null, null, null, null, nullable);
        }
        return new PropSpec(meta.jsonName(), meta.javaName(), meta.genericType(), meta.rawType(), meta.required(),
                meta.description(), meta.example(), meta.min(), meta.max(), meta.minSize(), meta.maxSize(),
                meta.pattern(), meta.nullable() || nullable);
    }

    private static Annotation[] safeAnnotationsMerged(AnnotatedElement... els) {
        Set<Annotation> seen = Collections.newSetFromMap(new IdentityHashMap<>());
        List<Annotation> out = new ArrayList<>();
        for (AnnotatedElement e : els) {
            for (Annotation a : safeDeclaredAnnotations(e)) {
                if (seen.add(a)) {
                    out.add(a);
                }
            }
        }
        return out.toArray(new Annotation[0]);
    }

    private static Field safeField(Class<?> cls, String name) {
        try {
            return cls.getDeclaredField(name);
        } catch (NoSuchFieldException | RuntimeException | LinkageError e) {
            return null;
        }
    }

    private static String annTypeName(Annotation a) {
        try {
            return a == null ? null : a.annotationType().getName();
        } catch (RuntimeException | LinkageError e) {
            return null;
        }
    }

    private static String cleanNonBlank(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }
}
