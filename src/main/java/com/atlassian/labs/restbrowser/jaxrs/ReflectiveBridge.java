package com.atlassian.labs.restbrowser.jaxrs;

import java.lang.annotation.Annotation;
import java.lang.reflect.AnnotatedElement;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Reflection helper using {@link ClassValue} so cached {@link Method} handles never pin unloaded OSGi bundle
 * classloaders and {@code setAccessible(true)} is invoked once rather than catching {@link IllegalAccessException}
 * on every call. Uses JDK-only {@link String} cache keys so no plugin-defined key class is retained inside foreign
 * {@code ClassValueMap}s across plugin reloads. Zero Atlassian coupling.
 */
public final class ReflectiveBridge {

    private static final ClassValue<ConcurrentHashMap<String, Optional<Method>>> METHOD_CACHE = new ClassValue<>() {
        @Override
        protected ConcurrentHashMap<String, Optional<Method>> computeValue(Class<?> type) {
            return new ConcurrentHashMap<>();
        }
    };

    private ReflectiveBridge() {
    }

    public static Object field(Object target, String name) throws ReflectiveOperationException {
        for (Class<?> c = target.getClass(); c != null; c = c.getSuperclass()) {
            try {
                Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f.get(target);
            } catch (NoSuchFieldException ignored) {
                // walk superclass
            }
        }
        throw new NoSuchFieldException(target.getClass().getName() + "." + name);
    }

    public static Object call(Object target, String method) throws ReflectiveOperationException {
        return call(target, method, new Class<?>[0]);
    }

    public static Object call(Object target, String method, Class<?>[] types, Object... args)
            throws ReflectiveOperationException {
        return call(target.getClass(), target, method, types, args);
    }

    public static Object call(Class<?> type, Object target, String method, Class<?>[] types, Object... args)
            throws ReflectiveOperationException {
        Method m = findMethod(type, method, types);
        if (m == null) {
            throw new NoSuchMethodException(type.getName() + "." + method);
        }
        return target == null ? invokeStatic(m, args) : invoke(m, target, args);
    }

    public static Method findMethod(Class<?> type, String name, Class<?>[] types) {
        Class<?>[] safeTypes = types == null ? new Class<?>[0] : types;
        String key = methodKey(name, safeTypes);
        return METHOD_CACHE.get(type).computeIfAbsent(key, k -> {
            try {
                Method m = type.getMethod(name, safeTypes);
                if (!Modifier.isPublic(m.getDeclaringClass().getModifiers())) {
                    try {
                        m.setAccessible(true);
                    } catch (RuntimeException ignored) {
                        // best effort
                    }
                }
                return Optional.of(m);
            } catch (NoSuchMethodException | LinkageError | RuntimeException e) {
                return Optional.empty();
            }
        }).orElse(null);
    }

    private static String methodKey(String name, Class<?>[] types) {
        if (types.length == 0) {
            return name;
        }
        StringBuilder sb = new StringBuilder(name.length() + types.length * 24).append(name).append('#');
        for (int i = 0; i < types.length; i++) {
            if (i > 0) {
                sb.append(',');
            }
            sb.append(types[i] == null ? "null" : types[i].getName());
        }
        return sb.toString();
    }

    public static Object invoke(Method m, Object target, Object... args) throws ReflectiveOperationException {
        try {
            return m.invoke(target, args);
        } catch (IllegalAccessException e) {
            m.setAccessible(true);
            return m.invoke(target, args);
        } catch (InvocationTargetException e) {
            if (e.getCause() instanceof RuntimeException re) {
                throw re;
            }
            throw e;
        }
    }

    public static Object invokeStatic(Method m, Object... args) throws ReflectiveOperationException {
        if (!Modifier.isStatic(m.getModifiers())) {
            throw new NoSuchMethodException(m + " is not static");
        }
        return invoke(m, null, args);
    }

    public static Annotation[] safeDeclaredAnnotations(AnnotatedElement element) {
        if (element == null) {
            return new Annotation[0];
        }
        try {
            return element.getDeclaredAnnotations();
        } catch (RuntimeException | LinkageError e) {
            return new Annotation[0];
        }
    }

    public static Annotation[] safeAnnotations(AnnotatedElement element) {
        if (element == null) {
            return new Annotation[0];
        }
        try {
            return element.getAnnotations();
        } catch (RuntimeException | LinkageError e) {
            return safeDeclaredAnnotations(element);
        }
    }

    public static boolean safeHasAnnotation(AnnotatedElement element, Class<? extends Annotation> annotationType) {
        if (element == null) {
            return false;
        }
        try {
            return element.isAnnotationPresent(annotationType);
        } catch (RuntimeException | LinkageError e) {
            return false;
        }
    }

    public static Object annMember(Annotation a, String name) {
        try {
            Method m = findMethod(a.annotationType(), name, new Class<?>[0]);
            return m == null ? null : invoke(m, a);
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
            return null;
        }
    }

    public static String annString(Annotation a, String name) {
        Object v = annMember(a, name);
        return v instanceof String s ? s : null;
    }
}
