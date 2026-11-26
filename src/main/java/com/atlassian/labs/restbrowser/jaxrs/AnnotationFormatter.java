package com.atlassian.labs.restbrowser.jaxrs;

import java.lang.annotation.Annotation;
import java.lang.reflect.AnnotatedElement;
import java.lang.reflect.Array;
import java.lang.reflect.Method;
import java.lang.reflect.Parameter;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.GenericArrayType;
import java.lang.reflect.Type;
import java.lang.reflect.TypeVariable;
import java.lang.reflect.WildcardType;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * Source-style annotation formatter and referenced-type collector with recursion depth and string-length budgets
 * so huge nested OpenAPI annotations cannot exhaust memory or fail completely when an optional class is absent.
 */
public final class AnnotationFormatter {

    public static final int MAX_ANNOTATION = 8000;
    private static final int MAX_DEPTH = 6;

    private AnnotationFormatter() {
    }

    public static List<String> annotations(AnnotatedElement e) {
        List<String> out = new ArrayList<>();
        Annotation[] all;
        try {
            all = e.getDeclaredAnnotations();
        } catch (RuntimeException | LinkageError x) {
            out.add("(unreadable: " + x + ")");
            return out;
        }
        for (Annotation a : all) {
            try {
                String s = annotation(a);
                out.add(s.length() <= MAX_ANNOTATION ? s : cut(s, MAX_ANNOTATION));
            } catch (RuntimeException | LinkageError x) {
                out.add("(unreadable: " + x + ")");
            }
        }
        return out;
    }

    public static String annotation(Annotation a) {
        StringBuilder out = new StringBuilder();
        appendAnnotation(a, out, 0, MAX_ANNOTATION + 64);
        return out.length() <= MAX_ANNOTATION ? out.toString() : cut(out.toString(), MAX_ANNOTATION);
    }

    private static void appendAnnotation(Annotation a, StringBuilder out, int depth, int budget) {
        if (a == null) {
            out.append("null");
            return;
        }
        String name = "@" + a.annotationType().getName();
        out.append(name);
        if (depth >= MAX_DEPTH || out.length() >= budget) {
            return;
        }
        Method[] members = a.annotationType().getDeclaredMethods();
        Arrays.sort(members, Comparator.comparing(Method::getName));
        List<String> set = new ArrayList<>();
        boolean onlyValue = true;
        int used = out.length() + 2;
        for (int i = 0; i < members.length; i++) {
            Method m = members[i];
            if (m.getParameterCount() != 0 || m.isSynthetic()) {
                continue;
            }
            Object v;
            Object def;
            try {
                v = ReflectiveBridge.invoke(m, a);
                def = m.getDefaultValue();
            } catch (ReflectiveOperationException | RuntimeException | LinkageError x) {
                String entry = m.getName() + "=?";
                set.add(entry);
                onlyValue = false;
                used += entry.length() + 2;
                continue;
            }
            if (def != null && Objects.deepEquals(v, def)) {
                continue;
            }
            StringBuilder valSb = new StringBuilder();
            appendAnnotationValue(v, valSb, depth + 1, Math.max(256, budget - used));
            String entry = m.getName() + "=" + valSb;
            set.add(entry);
            onlyValue &= "value".equals(m.getName());
            used += entry.length() + 2;
            if (used >= budget) {
                if (i + 1 < members.length) {
                    set.add("…");
                    onlyValue = false;
                }
                break;
            }
        }
        if (set.isEmpty()) {
            return;
        }
        if (onlyValue && set.size() == 1) {
            out.append('(').append(set.get(0).substring("value=".length())).append(')');
        } else {
            out.append('(').append(String.join(", ", set)).append(')');
        }
    }

    private static void appendAnnotationValue(Object v, StringBuilder out, int depth, int budget) {
        if (out.length() >= budget) {
            out.append("…");
            return;
        }
        if (v instanceof String s) {
            out.append('"').append(escape(s, '"')).append('"');
        } else if (v instanceof Character c) {
            out.append('\'').append(escape(String.valueOf(c), '\'')).append('\'');
        } else if (v instanceof Class<?> c) {
            out.append(c.getTypeName()).append(".class");
        } else if (v instanceof Enum<?> e) {
            out.append(e.getDeclaringClass().getName()).append('.').append(e.name());
        } else if (v instanceof Annotation nested) {
            appendAnnotation(nested, out, depth, budget);
        } else if (v != null && v.getClass().isArray()) {
            int n = Array.getLength(v);
            if (n == 1) {
                appendAnnotationValue(Array.get(v, 0), out, depth, budget);
                return;
            }
            out.append('{');
            for (int i = 0; i < n; i++) {
                if (i > 0) {
                    out.append(", ");
                }
                if (out.length() >= budget) {
                    out.append("…");
                    break;
                }
                appendAnnotationValue(Array.get(v, i), out, depth, budget);
            }
            out.append('}');
        } else if (v instanceof Long l) {
            out.append(l).append('L');
        } else if (v instanceof Float f) {
            out.append(f).append('f');
        } else {
            out.append(v);
        }
    }

    private static String escape(String s, char quote) {
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                default -> {
                    if (c == quote) {
                        b.append('\\').append(c);
                    } else {
                        b.append(c);
                    }
                }
            }
        }
        return b.toString();
    }

    /**
     * Collects all referenced classes from return type, generic parameter types, exceptions, method annotations,
     * AND parameter annotations (e.g. {@code @Schema(implementation = ...)} on {@code @RequestBody} / {@code @Parameter}).
     */
    public static List<Class<?>> signatureTypes(Method m) {
        Set<Class<?>> out = new LinkedHashSet<>();
        Set<TypeVariable<?>> seen = new HashSet<>();
        try {
            collect(m.getGenericReturnType(), out, seen);
        } catch (RuntimeException | LinkageError ignored) {
            collect(safeClass(m::getReturnType), out, seen);
        }
        try {
            for (Type t : m.getGenericParameterTypes()) {
                collect(t, out, seen);
            }
        } catch (RuntimeException | LinkageError ignored) {
            try {
                for (Class<?> c : m.getParameterTypes()) {
                    collect(c, out, seen);
                }
            } catch (RuntimeException | LinkageError ignoredFallback) {
                // unreadable parameter types
            }
        }
        try {
            for (Type t : m.getGenericExceptionTypes()) {
                collect(t, out, seen);
            }
        } catch (RuntimeException | LinkageError ignored) {
            // best effort
        }
        for (Annotation a : ReflectiveBridge.safeDeclaredAnnotations(m)) {
            collectAnnotationClasses(a, out, 0);
        }
        try {
            for (Parameter p : m.getParameters()) {
                for (Annotation a : ReflectiveBridge.safeDeclaredAnnotations(p)) {
                    collectAnnotationClasses(a, out, 0);
                }
            }
        } catch (RuntimeException | LinkageError ignored) {
            // unreadable parameter annotations
        }
        return new ArrayList<>(out);
    }

    private static Class<?> safeClass(java.util.function.Supplier<Class<?>> supplier) {
        try {
            return supplier.get();
        } catch (RuntimeException | LinkageError ignored) {
            return null;
        }
    }

    private static void collectAnnotationClasses(Annotation a, Set<Class<?>> out, int depth) {
        if (a == null || depth > MAX_DEPTH) {
            return;
        }
        Method[] members;
        try {
            members = a.annotationType().getDeclaredMethods();
        } catch (RuntimeException | LinkageError ignored) {
            return;
        }
        for (Method member : members) {
            if (member.getParameterCount() != 0 || member.isSynthetic()) {
                continue;
            }
            Object v;
            Object def;
            try {
                v = ReflectiveBridge.invoke(member, a);
                def = member.getDefaultValue();
            } catch (ReflectiveOperationException | RuntimeException | LinkageError ignored) {
                continue;
            }
            if (def != null && Objects.deepEquals(v, def)) {
                continue;
            }
            collectAnnotationValueClasses(v, out, depth + 1);
        }
    }

    private static void collectAnnotationValueClasses(Object v, Set<Class<?>> out, int depth) {
        if (v == null || depth > MAX_DEPTH + 1) {
            return;
        }
        if (v instanceof Class<?> c) {
            Class<?> k = c;
            while (k.isArray()) {
                k = k.getComponentType();
            }
            if (!k.isPrimitive() && k != Void.class) {
                out.add(k);
            }
        } else if (v instanceof Annotation nested) {
            collectAnnotationClasses(nested, out, depth);
        } else if (v.getClass().isArray()) {
            int n = Array.getLength(v);
            for (int i = 0; i < n; i++) {
                collectAnnotationValueClasses(Array.get(v, i), out, depth);
            }
        }
    }

    public static void collect(Type t, Set<Class<?>> out, Set<TypeVariable<?>> seen) {
        if (t instanceof Class<?> c) {
            Class<?> k = c;
            while (k.isArray()) {
                k = k.getComponentType();
            }
            if (!k.isPrimitive()) {
                out.add(k);
            }
        } else if (t instanceof ParameterizedType p) {
            collect(p.getRawType(), out, seen);
            for (Type a : p.getActualTypeArguments()) {
                collect(a, out, seen);
            }
        } else if (t instanceof GenericArrayType g) {
            collect(g.getGenericComponentType(), out, seen);
        } else if (t instanceof WildcardType w) {
            for (Type b : w.getUpperBounds()) {
                collect(b, out, seen);
            }
            for (Type b : w.getLowerBounds()) {
                collect(b, out, seen);
            }
        } else if (t instanceof TypeVariable<?> v && seen.add(v)) {
            for (Type b : v.getBounds()) {
                collect(b, out, seen);
            }
        }
    }

    private static String cut(String s, int max) {
        int end = Character.isHighSurrogate(s.charAt(max - 1)) ? max - 1 : max;
        return s.substring(0, end) + "…";
    }
}
