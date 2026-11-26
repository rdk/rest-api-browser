package com.atlassian.labs.restbrowser.jaxrs;

import com.atlassian.labs.restbrowser.inspect.TypeProxyUnwrapper;

import java.lang.reflect.GenericArrayType;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.lang.reflect.TypeVariable;
import java.lang.reflect.WildcardType;
import java.util.Collection;
import java.util.regex.Pattern;

/**
 * Deterministic structural Java {@link Type} formatter (unwrapping proxies, avoiding identity-hash fallbacks,
 * precompiling display shortening patterns, and unwrapping {@code Collection}/array/wildcard element classes).
 */
public final class TypeFormatter {

    private static final Pattern PKG_PREFIX = Pattern.compile("\\b(?:[a-z_][\\w]*\\.)+(?=[A-Z_$])");
    private static final Pattern INNER_DOLLAR = Pattern.compile("(\\w)\\$(?=[A-Z])");

    private TypeFormatter() {
    }

    public static String stableTypeName(Type type, Class<?> raw) {
        String formatted = formatType(type, 0);
        if (formatted != null) {
            return formatted;
        }
        return raw == null ? null : formatType(raw, 0);
    }

    private static String formatType(Type type, int depth) {
        if (type == null || depth > 8) {
            return null;
        }
        if (type instanceof Class<?> c) {
            if (c.isArray()) {
                String comp = formatType(c.getComponentType(), depth + 1);
                return comp == null ? null : comp + "[]";
            }
            return TypeProxyUnwrapper.unwrapType(c).getName();
        }
        if (type instanceof ParameterizedType pt) {
            String raw = formatType(pt.getRawType(), depth + 1);
            if (raw == null) {
                return null;
            }
            Type[] args = pt.getActualTypeArguments();
            if (args == null || args.length == 0) {
                return raw;
            }
            StringBuilder sb = new StringBuilder(raw).append('<');
            for (int i = 0; i < args.length; i++) {
                if (i > 0) {
                    sb.append(", ");
                }
                String arg = formatType(args[i], depth + 1);
                sb.append(arg == null ? "?" : arg);
            }
            return sb.append('>').toString();
        }
        if (type instanceof GenericArrayType ga) {
            String comp = formatType(ga.getGenericComponentType(), depth + 1);
            return comp == null ? null : comp + "[]";
        }
        if (type instanceof WildcardType wt) {
            Type[] lower = wt.getLowerBounds();
            if (lower != null && lower.length > 0) {
                String b = formatType(lower[0], depth + 1);
                return b == null ? "?" : "? super " + b;
            }
            Type[] upper = wt.getUpperBounds();
            if (upper != null && upper.length > 0 && upper[0] != Object.class) {
                String b = formatType(upper[0], depth + 1);
                return b == null ? "?" : "? extends " + b;
            }
            return "?";
        }
        if (type instanceof TypeVariable<?> tv) {
            return tv.getName();
        }
        return null;
    }

    public static String shortTypeName(Type type) {
        return type == null ? null : shortTypeName(stableTypeName(type, null));
    }

    public static String shortTypeName(String full) {
        if (full == null) {
            return null;
        }
        return INNER_DOLLAR.matcher(PKG_PREFIX.matcher(full).replaceAll("")).replaceAll("$1.");
    }

    /**
     * Resolves the element {@link Class} of a repeating {@link Collection} (including custom subclasses and
     * bounded wildcards like {@code List<? extends MyEnum>}) or array ({@code MyEnum[]}).
     */
    public static Class<?> elementClass(Type type, Class<?> raw) {
        if (raw != null && raw.isArray()) {
            return raw.getComponentType();
        }
        if (type instanceof GenericArrayType ga) {
            Type comp = ga.getGenericComponentType();
            return comp instanceof Class<?> c ? c : String.class;
        }
        Type resolved = extractCollectionArg(type);
        if (resolved == null && raw != null && Collection.class.isAssignableFrom(raw)) {
            resolved = findSuperCollectionArg(raw);
        }
        if (resolved instanceof Class<?> c) {
            return c;
        }
        if (resolved instanceof ParameterizedType innerPt && innerPt.getRawType() instanceof Class<?> c) {
            return c;
        }
        if (resolved instanceof WildcardType wt) {
            Type[] upper = wt.getUpperBounds();
            if (upper != null && upper.length > 0 && upper[0] instanceof Class<?> c && c != Object.class) {
                return c;
            }
        }
        return String.class;
    }

    private static Type extractCollectionArg(Type type) {
        if (type instanceof ParameterizedType pt && pt.getActualTypeArguments().length == 1) {
            return pt.getActualTypeArguments()[0];
        }
        return null;
    }

    private static Type findSuperCollectionArg(Class<?> cls) {
        for (Class<?> cur = cls; cur != null && Collection.class.isAssignableFrom(cur); cur = cur.getSuperclass()) {
            Type sup = cur.getGenericSuperclass();
            if (sup instanceof ParameterizedType pt && pt.getActualTypeArguments().length == 1) {
                return pt.getActualTypeArguments()[0];
            }
        }
        return null;
    }

    public static String typeName(Class<?> c) {
        if (c == null) {
            return "string";
        }
        if (c == String.class || c.isEnum() || c == Character.class || c == char.class) {
            return "string";
        }
        if (c == Integer.class || c == int.class || c == Short.class || c == short.class) {
            return "int";
        }
        if (c == Long.class || c == long.class) {
            return "long";
        }
        if (c == Boolean.class || c == boolean.class) {
            return "boolean";
        }
        if (c == Double.class || c == double.class || c == Float.class || c == float.class) {
            return "number";
        }
        return c.getSimpleName();
    }
}
