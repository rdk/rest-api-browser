package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.Model.ModuleSpec;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.OperationSpec;
import com.atlassian.labs.restbrowser.catalog.Model.Param;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.plugin.servlet.ServletModuleManager;
import com.atlassian.plugin.servlet.filter.FilterLocation;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.FilterConfig;
import jakarta.servlet.ServletContext;
import org.slf4j.Logger;

import java.lang.annotation.Annotation;
import java.lang.reflect.AnnotatedElement;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Enumeration;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Supplier;

import static org.slf4j.LoggerFactory.getLogger;

/**
 * Reads a REST v2 module's Jersey runtime resource model: the model Jersey routes requests with and generates the
 * WADL from, so it describes exactly what is served, and needs no JAXB.
 * <p>
 * The path to it is not public API: the REST v2 descriptor's filter (RestDelegatingServletFilter) holds the Jersey
 * servlet container in a private field; the container's ApplicationHandler gives the injection manager, which gives
 * ExtendedResourceContext and its ResourceModel. Everything is reached by reflection, so this class compiles
 * against no Jersey or REST plugin classes, and every value is copied into plain records at once.
 * <p>
 * The product initializes a REST module's filter on its first request. For a module that has not had one yet, the
 * source asks the ServletModuleManager for the filters of the module's path, which initializes them exactly as a
 * request would.
 */
public class JerseyModelSource implements SpecSource {

    private static final Logger LOGGER = getLogger(JerseyModelSource.class);
    private static final int MAX_LOCATOR_DEPTH = 4;

    private final Supplier<ServletModuleManager> servletModuleManager;
    private final Supplier<ServletContext> servletContext;

    public JerseyModelSource(Supplier<ServletModuleManager> servletModuleManager,
                             Supplier<ServletContext> servletContext) {
        this.servletModuleManager = servletModuleManager;
        this.servletContext = servletContext;
    }

    @Override
    public String id() {
        return "jersey";
    }

    @Override
    public Optional<ModuleSpec> describe(RestModule module) throws SpecException {
        if (!module.restV2()) {
            return Optional.empty(); // REST v1 runs Jersey 1, a different model
        }
        List<OperationSpec> operations = new ArrayList<>();
        walk(module, operations, null);
        return Optional.of(new ModuleSpec(id(), operations));
    }

    /**
     * The Java behind one operation: what handles it and the sub-resource locators on the way. For the details of
     * one operation, on demand; the caller turns it into strings at once and keeps nothing of it.
     *
     * @param definition the method the JAX-RS annotations are on (an interface's, sometimes)
     * @param handling   the method that runs
     * @param handlerClass the class Jersey instantiates, when it says so
     * @param locators   the sub-resource locator methods from the root resource down, empty for most operations
     */
    public record Handler(Method definition, Method handling, Class<?> handlerClass, List<Method> locators) {
    }

    /** The handler of the operation with this catalog key in this module; empty when the module has no such operation. */
    public Optional<Handler> handler(RestModule module, String key) throws SpecException {
        if (!module.restV2()) {
            return Optional.empty();
        }
        List<OperationSpec> operations = new ArrayList<>();
        Map<OperationSpec, Handler> handlers = new IdentityHashMap<>();
        walk(module, operations, handlers);
        // the same keys as the catalog's: OperationKeys keeps the spec instances, so identity finds the handler
        for (Operation op : OperationKeys.assign(module.id(), operations)) {
            if (op.key().equals(key)) {
                return Optional.ofNullable(handlers.get(op.spec()));
            }
        }
        return Optional.empty();
    }

    /** Visits the module's whole resource model; with {@code handlers}, records the handler of every operation too. */
    private void walk(RestModule module, List<OperationSpec> operations, Map<OperationSpec, Handler> handlers)
            throws SpecException {
        Object handler = applicationHandler(module);
        List<?> roots;
        try {
            Object injectionManager = call(handler, "getInjectionManager");
            Class<?> ercClass = handler.getClass().getClassLoader()
                    .loadClass("org.glassfish.jersey.server.ExtendedResourceContext");
            Object resourceContext = call(injectionManager, "getInstance", new Class<?>[]{Class.class}, ercClass);
            Object model = call(resourceContext, "getResourceModel");
            roots = (List<?>) call(model, "getRootResources");
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
            throw new SpecException("model-unavailable", "Couldn't read the resource model: " + e, e);
        }
        Map<Class<?>, Boolean> locatorClasses = new IdentityHashMap<>();
        for (Object root : roots) {
            visit(root, "", 0, operations, handlers, locatorClasses, Inherited.NONE);
        }
    }

    private Object applicationHandler(RestModule module) throws SpecException {
        Object container;
        try {
            Object filter = module.descriptor().getModule();
            container = field(filter, "servletContainer");
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
            throw new SpecException("container-unavailable", "Couldn't reach the Jersey container: " + e, e);
        }
        Object handler = applicationHandlerOrNull(container);
        String tried = "";
        if (handler == null) {
            tried = initialize(module);
            handler = applicationHandlerOrNull(container);
        }
        if (handler == null) {
            throw new SpecException("not-started", "The module's Jersey application is not initialized; " + tried, null);
        }
        return handler;
    }

    private static Object applicationHandlerOrNull(Object container) {
        try {
            return call(container, "getApplicationHandler");
        } catch (ReflectiveOperationException | RuntimeException e) {
            return null; // Jersey's ServletContainer throws before init
        }
    }

    /** Lets the ServletModuleManager initialize the filters of the module's path, as the first request would. */
    /** @return what was tried, for the module's error details (admins see them) */
    private String initialize(RestModule module) {
        ServletModuleManager manager = servletModuleManager.get();
        ServletContext context = servletContext.get();
        if (manager == null || context == null) {
            return "no ServletModuleManager or ServletContext to initialize it with";
        }
        FilterConfig config = new FilterConfig() {
            @Override
            public String getFilterName() {
                return "rest-api-browser";
            }

            @Override
            public ServletContext getServletContext() {
                return context;
            }

            @Override
            public String getInitParameter(String name) {
                return null;
            }

            @Override
            public Enumeration<String> getInitParameterNames() {
                return Collections.emptyEnumeration();
            }
        };
        String path = "/rest/" + module.path() + "/";
        StringBuilder tried = new StringBuilder("filters for ").append(path).append(':');
        for (FilterLocation location : FilterLocation.values()) {
            try {
                int[] count = {0};
                manager.getFilters(location, path, config, DispatcherType.REQUEST).forEach(f -> count[0]++);
                if (count[0] > 0) {
                    tried.append(' ').append(location).append('=').append(count[0]);
                }
            } catch (RuntimeException | LinkageError e) {
                LOGGER.debug("Couldn't initialize the filters of {}", path, e);
                tried.append(' ').append(location).append(" failed: ").append(e);
            }
        }
        return tried.toString();
    }

    /** What a sub-resource locator passes down to the operations below it; the locators only for the details. */
    private record Inherited(List<Param> params, String access, boolean deprecated, List<Method> locators) {
        static final Inherited NONE = new Inherited(List.of(), null, false, List.of());
    }

    private void visit(Object resource, String prefix, int depth, List<OperationSpec> out,
                       Map<OperationSpec, Handler> handlers, Map<Class<?>, Boolean> locatorClasses,
                       Inherited inherited) {
        try {
            if (Boolean.TRUE.equals(call(resource, "isExtended"))) {
                return; // Jersey's own additions, such as application.wadl
            }
            String path = join(prefix, (String) call(resource, "getPath"));
            for (Object method : (List<?>) call(resource, "getResourceMethods")) {
                if (!Boolean.TRUE.equals(call(method, "isExtended"))) {
                    out.add(operation(method, path, inherited, handlers));
                }
            }
            Object locator = call(resource, "getResourceLocator");
            if (locator != null && depth < MAX_LOCATOR_DEPTH) {
                visitLocator(resource, locator, path, depth, out, handlers, locatorClasses, inherited);
            }
            for (Object child : (List<?>) call(resource, "getChildResources")) {
                visit(child, path, depth, out, handlers, locatorClasses, inherited);
            }
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
            LOGGER.debug("Skipped part of the resource model below {}", prefix, e);
        }
    }

    /**
     * Follows a sub-resource locator into the resource class it returns. The locator's own parameters (its path
     * parameters, typically), access and deprecation apply to everything below it. A class already on the way down
     * is not entered again (recursive locators).
     */
    private void visitLocator(Object resource, Object locator, String path, int depth, List<OperationSpec> out,
                              Map<OperationSpec, Handler> handlers, Map<Class<?>, Boolean> locatorClasses,
                              Inherited inherited)
            throws ReflectiveOperationException {
        Object invocable = call(locator, "getInvocable");
        Class<?> type = (Class<?>) call(invocable, "getRawResponseType");
        if (type == null || type == Object.class || type.isInterface() || locatorClasses.put(type, true) != null) {
            return;
        }
        try {
            Object sub = call(resource.getClass(), null, "from", new Class<?>[]{Class.class}, type);
            if (sub == null) {
                return;
            }
            List<Param> params = new ArrayList<>(inherited.params());
            String[] ignoredBody = new String[1];
            for (Object p : (List<?>) call(invocable, "getParameters")) {
                param(p, params, ignoredBody);
            }
            Method handling = (Method) call(invocable, "getHandlingMethod");
            String access = inherited.access();
            boolean deprecated = inherited.deprecated();
            List<Method> locators = inherited.locators();
            if (handling != null) {
                access = firstNonNull(access(handling), access);
                deprecated |= handling.isAnnotationPresent(Deprecated.class)
                        || handling.getDeclaringClass().isAnnotationPresent(Deprecated.class);
                if (handlers != null) {
                    List<Method> chain = new ArrayList<>(locators);
                    chain.add(handling);
                    locators = List.copyOf(chain);
                }
            }
            visit(sub, path, depth + 1, out, handlers, locatorClasses,
                    new Inherited(List.copyOf(params), access, deprecated, locators));
        } finally {
            locatorClasses.remove(type);
        }
    }

    private OperationSpec operation(Object method, String path, Inherited inherited, Map<OperationSpec, Handler> handlers)
            throws ReflectiveOperationException {
        String httpMethod = (String) call(method, "getHttpMethod");
        List<String> consumes = mediaTypes(call(method, "getConsumedTypes"));
        List<String> produces = mediaTypes(call(method, "getProducedTypes"));
        Object invocable = call(method, "getInvocable");
        Method handling = (Method) call(invocable, "getHandlingMethod");
        List<Param> params = new ArrayList<>(inherited.params());
        String[] bodyType = new String[1];
        for (Object p : (List<?>) call(invocable, "getParameters")) {
            param(p, params, bodyType);
        }
        String access = inherited.access();
        boolean deprecated = inherited.deprecated();
        if (handling != null) {
            access = firstNonNull(access(handling), access);
            deprecated |= handling.isAnnotationPresent(Deprecated.class)
                    || handling.getDeclaringClass().isAnnotationPresent(Deprecated.class);
        }
        OperationSpec spec = new OperationSpec(httpMethod, path, consumes, produces, completePathParams(path, params),
                access, deprecated, bodyType[0]);
        if (handlers != null) {
            handlers.put(spec, new Handler(definitionMethod(invocable, handling), handling, handlerClass(invocable),
                    inherited.locators()));
        }
        return spec;
    }

    private static Method definitionMethod(Object invocable, Method handling) {
        try {
            Object m = call(invocable, "getDefinitionMethod");
            return m instanceof Method d ? d : handling;
        } catch (ReflectiveOperationException | RuntimeException e) {
            return handling;
        }
    }

    private static Class<?> handlerClass(Object invocable) {
        try {
            Object h = call(invocable, "getHandler");
            return h == null ? null : (Class<?>) call(h, "getHandlerClass");
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
            return null;
        }
    }

    private static void param(Object p, List<Param> out, String[] bodyType) throws ReflectiveOperationException {
        String source = String.valueOf(call(p, "getSource"));
        Class<?> raw = (Class<?>) call(p, "getRawType");
        Type type = (Type) call(p, "getType");
        switch (source) {
            case "PATH", "QUERY", "HEADER", "MATRIX", "FORM" -> {
                String name = (String) call(p, "getSourceName");
                if (name == null || name.isEmpty()) {
                    return;
                }
                boolean repeating = raw != null && Collection.class.isAssignableFrom(raw);
                Class<?> element = repeating ? elementClass(type) : raw;
                out.add(new Param(name, source.toLowerCase(), typeName(element), "PATH".equals(source),
                        (String) call(p, "getDefaultValue"), options(element), repeating));
            }
            case "ENTITY" -> bodyType[0] = raw == null ? null : raw.getSimpleName();
            case "BEAN_PARAM" -> {
                // Jersey's BeanParameter lists the parameters of the bean's fields
                Method m = findMethod(p.getClass(), "getParameters", new Class<?>[0]);
                if (m != null) {
                    for (Object inner : (Collection<?>) invoke(m, p)) {
                        param(inner, out, bodyType);
                    }
                }
            }
            default -> { } // context, cookie, suspended: not something a user fills in
        }
    }

    private static Class<?> elementClass(Type type) {
        if (type instanceof ParameterizedType pt && pt.getActualTypeArguments().length == 1
                && pt.getActualTypeArguments()[0] instanceof Class<?> c) {
            return c;
        }
        return String.class;
    }

    static String typeName(Class<?> c) {
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

    private static List<String> options(Class<?> c) {
        if (c == null || !c.isEnum()) {
            return List.of();
        }
        List<String> names = new ArrayList<>();
        for (Object constant : c.getEnumConstants()) {
            names.add(((Enum<?>) constant).name());
        }
        return List.copyOf(names);
    }

    /** Access levels, by annotation simple name (com.atlassian.annotations.security, REST v2 and REST v1). */
    static final Set<String> ACCESS_ANNOTATIONS = Set.of("SystemAdminOnly", "AdminOnly", "LicensedOnly",
            "UnlicensedSiteAccess", "AnonymousSiteAccess", "UnrestrictedAccess", "AnonymousAllowed");

    /** The handler's access level: from the method, else its class, else the package of the class. */
    static String access(Method handling) {
        String a = accessOf(handling);
        if (a == null) {
            a = accessOf(handling.getDeclaringClass());
        }
        if (a == null && handling.getDeclaringClass().getPackage() != null) {
            a = accessOf(handling.getDeclaringClass().getPackage());
        }
        return a;
    }

    private static String accessOf(AnnotatedElement element) {
        for (Annotation a : element.getAnnotations()) {
            Class<? extends Annotation> type = a.annotationType();
            if (type.getName().startsWith("com.atlassian.") && ACCESS_ANNOTATIONS.contains(type.getSimpleName())) {
                return type.getSimpleName();
            }
        }
        return null;
    }

    private static String firstNonNull(String a, String b) {
        return a != null ? a : b;
    }

    /**
     * Drops duplicate parameters (a locator one and the method one) and adds a required string path parameter for
     * every path template that no parameter declares, such as one injected into a field: the request form needs an
     * input for each of them.
     */
    static List<Param> completePathParams(String path, List<Param> params) {
        Map<String, Param> unique = new java.util.LinkedHashMap<>();
        for (Param p : params) {
            unique.putIfAbsent(p.in() + ":" + p.name(), p);
        }
        for (String name : templateNames(path)) {
            unique.putIfAbsent("path:" + name, new Param(name, "path", "string", true, null, List.of(), false));
        }
        return List.copyOf(unique.values());
    }

    /** The names of the templates of a path: "{issueIdOrKey}" and "{id: [0-9]+}" give issueIdOrKey and id. */
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

    private static List<String> mediaTypes(Object list) {
        List<String> out = new ArrayList<>();
        for (Object m : (List<?>) list) {
            out.add(String.valueOf(m));
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

    // ---- reflection helpers: the classes belong to other bundles and may be non-public implementations

    private static Object field(Object target, String name) throws ReflectiveOperationException {
        for (Class<?> c = target.getClass(); c != null; c = c.getSuperclass()) {
            try {
                Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f.get(target);
            } catch (NoSuchFieldException e) {
                // try the superclass
            }
        }
        throw new NoSuchFieldException(target.getClass().getName() + "." + name);
    }

    private static Object call(Object target, String method) throws ReflectiveOperationException {
        return call(target, method, new Class<?>[0]);
    }

    private static Object call(Object target, String method, Class<?>[] types, Object... args)
            throws ReflectiveOperationException {
        return call(target.getClass(), target, method, types, args);
    }

    /** Calls a public method, static when target is null. */
    private static Object call(Class<?> type, Object target, String method, Class<?>[] types, Object... args)
            throws ReflectiveOperationException {
        Method m = findMethod(type, method, types);
        if (m == null) {
            throw new NoSuchMethodException(type.getName() + "." + method);
        }
        return target == null ? invokeStatic(m, args) : invoke(m, target, args);
    }

    private static Method findMethod(Class<?> type, String name, Class<?>[] types) {
        try {
            return type.getMethod(name, types);
        } catch (NoSuchMethodException e) {
            return null;
        }
    }

    private static Object invoke(Method m, Object target, Object... args) throws ReflectiveOperationException {
        try {
            return m.invoke(target, args);
        } catch (IllegalAccessException e) {
            // a public method declared by a non-public class
            m.setAccessible(true);
            return m.invoke(target, args);
        } catch (InvocationTargetException e) {
            if (e.getCause() instanceof RuntimeException re) {
                throw re;
            }
            throw e;
        }
    }

    private static Object invokeStatic(Method m, Object... args) throws ReflectiveOperationException {
        if (!Modifier.isStatic(m.getModifiers())) {
            throw new NoSuchMethodException(m + " is not static");
        }
        return invoke(m, null, args);
    }
}
