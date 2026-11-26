package com.atlassian.labs.restbrowser.inspect;

import java.lang.reflect.Proxy;

/**
 * Unwraps generated proxy subclasses (Spring CGLIB {@code $$} subclasses and JDK dynamic {@link Proxy} instances)
 * back to the concrete user class or primary interface.
 */
public final class TypeProxyUnwrapper {

    private TypeProxyUnwrapper() {
    }

    /** Unwraps CGLIB {@code $$} generated subclasses to the real declaring class. */
    public static Class<?> targetClass(Class<?> cls) {
        Class<?> c = cls;
        while (c != null && c.getName().contains("$$") && c.getSuperclass() != null
                && c.getSuperclass() != Object.class) {
            c = c.getSuperclass();
        }
        return c == null ? cls : c;
    }

    /** Unwraps both CGLIB subclasses and JDK {@link Proxy} classes to an interface if applicable. */
    public static Class<?> unwrapType(Class<?> cls) {
        Class<?> c = targetClass(cls);
        if (c != null && (Proxy.isProxyClass(c) || c.getName().contains("$Proxy"))) {
            Class<?>[] ifaces = c.getInterfaces();
            if (ifaces.length > 0) {
                return ifaces[0];
            }
        }
        return c;
    }
}
