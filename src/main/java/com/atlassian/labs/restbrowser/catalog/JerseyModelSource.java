package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.Model.ModuleSpec;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.OperationSpec;
import com.atlassian.labs.restbrowser.catalog.Model.Param;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.labs.restbrowser.inspect.TypeProxyUnwrapper;
import com.atlassian.labs.restbrowser.jaxrs.OpenApiAnnotationExtractor;
import com.atlassian.labs.restbrowser.jaxrs.TypeFormatter;
import com.atlassian.plugin.servlet.ServletModuleManager;
import com.atlassian.plugin.servlet.filter.FilterLocation;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.FilterConfig;
import jakarta.servlet.ServletContext;
import org.slf4j.Logger;

import java.lang.annotation.Annotation;
import java.lang.reflect.Method;
import java.lang.reflect.Type;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Enumeration;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Supplier;

import static com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge.call;
import static com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge.field;
import static com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge.findMethod;
import static com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge.invoke;
import static org.slf4j.LoggerFactory.getLogger;

/**
 * Reads a REST v2 module's Jersey runtime resource model via reflection, isolating individual method/resource errors,
 * guarding recursive {@code @BeanParam} graphs, and delegating type/OpenAPI introspection to {@code jaxrs/}.
 */
public class JerseyModelSource implements SpecSource {

    private static final Logger LOGGER = getLogger(JerseyModelSource.class);
    private static final int MAX_LOCATOR_DEPTH = 4;
    private static final int MAX_BEAN_DEPTH = 6;
    static final int MAX_SUMMARY = OpenApiAnnotationExtractor.MAX_SUMMARY;
    static final int MAX_DESCRIPTION = OpenApiAnnotationExtractor.MAX_DESCRIPTION;
    static final int MAX_PARAM_DESCRIPTION = OpenApiAnnotationExtractor.MAX_PARAM_DESCRIPTION;

    public static final Set<String> ACCESS_ANNOTATIONS = JerseyAnnotationSupport.ACCESS_ANNOTATIONS;

    private final Supplier<ServletModuleManager> servletModuleManager;
    private final Supplier<ServletContext> servletContext;

    public JerseyModelSource(Supplier<ServletModuleManager> servletModuleManager,
                             Supplier<ServletContext> servletContext) {
        this.servletModuleManager = servletModuleManager;
        this.servletContext = servletContext;
    }

    public static final String NOT_STARTED = "not-started";
    public static final String NOT_STARTABLE = "not-startable";

    @Override
    public String id() {
        return "jersey";
    }

    public boolean started(RestModule module) {
        if (!module.restV2()) {
            return false;
        }
        try {
            return applicationHandlerOrNull(field(module.descriptor().getModule(), "servletContainer")) != null;
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
            return false;
        }
    }

    @Override
    public Optional<ModuleSpec> describe(RestModule module) throws SpecException {
        if (!module.restV2()) {
            return Optional.empty();
        }
        List<OperationSpec> operations = new ArrayList<>();
        walk(module, operations, null);
        return Optional.of(new ModuleSpec(id(), operations));
    }

    public record Handler(Method definition, Method handling, Class<?> handlerClass, List<Method> locators) {
    }

    public Optional<Handler> handler(RestModule module, String key) throws SpecException {
        if (!module.restV2()) {
            return Optional.empty();
        }
        List<OperationSpec> operations = new ArrayList<>();
        Map<OperationSpec, Handler> handlers = new IdentityHashMap<>();
        walk(module, operations, handlers);
        for (Operation op : OperationKeys.assign(module.id(), operations)) {
            if (op.key().equals(key)) {
                return Optional.ofNullable(handlers.get(op.spec()));
            }
        }
        return Optional.empty();
    }

    /** Returns all assigned operation keys in {@code module} in a single resource walk. */
    public List<String> operationKeys(RestModule module) throws SpecException {
        if (module == null || !module.restV2()) {
            return List.of();
        }
        List<OperationSpec> operations = new ArrayList<>();
        walk(module, operations, null);
        return OperationKeys.assign(module.id(), operations).stream().map(Operation::key).toList();
    }

    /** Returns every assigned operation key mapped to its Jersey {@link Handler} in a single resource walk. */
    public Map<String, Handler> handlers(RestModule module) throws SpecException {
        if (module == null || !module.restV2()) {
            return Map.of();
        }
        List<OperationSpec> operations = new ArrayList<>();
        Map<OperationSpec, Handler> raw = new IdentityHashMap<>();
        walk(module, operations, raw);
        Map<String, Handler> byKey = new LinkedHashMap<>();
        for (Operation op : OperationKeys.assign(module.id(), operations)) {
            Handler h = raw.get(op.spec());
            if (h != null) {
                byKey.put(op.key(), h);
            }
        }
        return byKey;
    }

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
        if (roots != null) {
            for (Object root : roots) {
                visit(root, "", 0, operations, handlers, locatorClasses, Inherited.NONE);
            }
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
            tried = initialize(module, container);
            handler = applicationHandlerOrNull(container);
        }
        if (handler == null) {
            throw new SpecException(NOT_STARTED, "The module's Jersey application is not initialized; " + tried, null);
        }
        return handler;
    }

    private static Object applicationHandlerOrNull(Object container) {
        try {
            return container == null ? null : call(container, "getApplicationHandler");
        } catch (ReflectiveOperationException | RuntimeException e) {
            return null;
        }
    }

    private String initialize(RestModule module, Object container) {
        ServletModuleManager manager = servletModuleManager.get();
        ServletContext context = servletContext.get();
        if (manager == null || context == null) {
            return "no ServletModuleManager or ServletContext to initialize it with";
        }
        FilterConfig config = new FilterConfig() {
            @Override public String getFilterName() { return "rest-api-browser"; }
            @Override public ServletContext getServletContext() { return context; }
            @Override public String getInitParameter(String name) { return null; }
            @Override public Enumeration<String> getInitParameterNames() { return Collections.emptyEnumeration(); }
        };
        String modPath = module.path() == null ? "" : module.path().replaceAll("^/+|/+$", "");
        String path = modPath.isEmpty() ? "/rest/" : "/rest/" + modPath + "/";
        StringBuilder tried = new StringBuilder("filters for ").append(path).append(':');
        for (FilterLocation location : FilterLocation.values()) {
            try {
                int[] count = {0};
                manager.getFilters(location, path, config, DispatcherType.REQUEST).forEach(f -> count[0]++);
                if (count[0] > 0) {
                    tried.append(' ').append(location).append('=').append(count[0]);
                }
                // Stop touching unrelated FilterLocations once this module's servlet container has started
                if (applicationHandlerOrNull(container) != null) {
                    break;
                }
            } catch (RuntimeException | LinkageError e) {
                LOGGER.debug("Couldn't initialize the filters of {}", path, e);
                tried.append(' ').append(location).append(" failed: ").append(e);
            }
        }
        return tried.toString();
    }

    private record Inherited(List<Param> params, String access, boolean deprecated, List<Method> locators) {
        static final Inherited NONE = new Inherited(List.of(), null, false, List.of());
    }

    private void visit(Object resource, String prefix, int depth, List<OperationSpec> out,
                       Map<OperationSpec, Handler> handlers, Map<Class<?>, Boolean> locatorClasses,
                       Inherited inherited) {
        if (resource == null) {
            return;
        }
        String path;
        try {
            if (Boolean.TRUE.equals(call(resource, "isExtended"))) {
                return;
            }
            path = join(prefix, (String) call(resource, "getPath"));
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
            LOGGER.debug("Skipped uninspectable resource under {}", prefix, e);
            return;
        }
        try {
            Object rawMethods = call(resource, "getResourceMethods");
            if (rawMethods instanceof List<?> methods) {
                for (Object method : methods) {
                    try {
                        if (!Boolean.TRUE.equals(call(method, "isExtended"))) {
                            out.add(operation(method, path, inherited, handlers));
                        }
                    } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
                        // Isolate single broken method so siblings and child resources remain intact
                        LOGGER.debug("Skipped broken resource method on {}", path, e);
                    }
                }
            }
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
            LOGGER.debug("Skipped methods of {}", path, e);
        }
        try {
            Object locator = call(resource, "getResourceLocator");
            if (locator != null && depth < MAX_LOCATOR_DEPTH) {
                visitLocator(resource, locator, path, depth, out, handlers, locatorClasses, inherited);
            }
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
            LOGGER.debug("Skipped sub-resource locator on {}", path, e);
        }
        try {
            Object rawChildren = call(resource, "getChildResources");
            if (rawChildren instanceof List<?> children) {
                for (Object child : children) {
                    visit(child, path, depth, out, handlers, locatorClasses, inherited);
                }
            }
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
            LOGGER.debug("Skipped child resources of {}", path, e);
        }
    }

    private void visitLocator(Object resource, Object locator, String path, int depth, List<OperationSpec> out,
                              Map<OperationSpec, Handler> handlers, Map<Class<?>, Boolean> locatorClasses,
                              Inherited inherited)
            throws ReflectiveOperationException {
        Object invocable = call(locator, "getInvocable");
        Class<?> type = (Class<?>) call(invocable, "getRawResponseType");
        if (type == null || type == Object.class || type.isPrimitive() || locatorClasses.put(type, true) != null) {
            return;
        }
        try {
            Object sub = call(resource.getClass(), null, "from", new Class<?>[]{Class.class}, type);
            if (sub == null) {
                return;
            }
            List<Param> ownParams = new ArrayList<>();
            String[] ignoredBody = new String[2];
            Set<Class<?>> visitedBeans = Collections.newSetFromMap(new IdentityHashMap<>());
            for (Object p : (List<?>) call(invocable, "getParameters")) {
                param(p, ownParams, ignoredBody, visitedBeans, 0);
            }
            List<Param> params = JerseyAnnotationSupport.mergeParams(inherited.params(), ownParams);
            Method handling = (Method) call(invocable, "getHandlingMethod");
            Method def = definitionMethod(invocable, handling);
            Class<?> locatorCls = handlerClass(invocable);
            String access = inherited.access();
            boolean deprecated = inherited.deprecated();
            List<Method> locators = inherited.locators();
            if (handling != null || def != null) {
                access = JerseyAnnotationSupport.firstNonNull(access(def, handling, locatorCls), access);
                deprecated |= isDeprecated(def, handling, locatorCls);
                Method recorded = handling != null ? handling : def;
                if (handlers != null && recorded != null) {
                    List<Method> chain = new ArrayList<>(locators);
                    chain.add(recorded);
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
        List<String> consumes = JerseyAnnotationSupport.mediaTypes(call(method, "getConsumedTypes"));
        List<String> produces = JerseyAnnotationSupport.mediaTypes(call(method, "getProducedTypes"));
        Object invocable = call(method, "getInvocable");
        Method handling = (Method) call(invocable, "getHandlingMethod");
        Method def = definitionMethod(invocable, handling);
        Class<?> handlerCls = handlerClass(invocable);

        List<Param> ownParams = new ArrayList<>();
        String[] bodyType = new String[2];
        Set<Class<?>> visitedBeans = Collections.newSetFromMap(new IdentityHashMap<>());
        for (Object p : (List<?>) call(invocable, "getParameters")) {
            param(p, ownParams, bodyType, visitedBeans, 0);
        }
        List<Param> params = JerseyAnnotationSupport.mergeParams(inherited.params(), ownParams);

        String access = JerseyAnnotationSupport.firstNonNull(access(def, handling, handlerCls), inherited.access());
        boolean deprecated = inherited.deprecated() || isDeprecated(def, handling, handlerCls);

        String returnType = null;
        String returnJavaType = null;
        if (handling != null) {
            Class<?> rawRet = handling.getReturnType();
            if (rawRet != void.class && rawRet != Void.class) {
                Type genericRet = safeGenericReturnType(handling, rawRet);
                String annotatedRet = JerseyAnnotationSupport.isGenericResponseWrapper(rawRet)
                        ? annotatedReturnJavaType(def, handling) : null;
                returnJavaType = annotatedRet != null ? annotatedRet : TypeFormatter.stableTypeName(genericRet, rawRet);
                returnType = TypeFormatter.shortTypeName(returnJavaType);
            }
        }
        OpDoc doc = opDoc(def, handling);
        deprecated |= doc.deprecated();
        List<Param> completed = applyParamDocs(completePathParams(path, params), paramDocs(def, handling));
        OperationSpec spec = new OperationSpec(httpMethod, path, consumes, produces, completed,
                access, deprecated, bodyType[0], doc.summary(), doc.description(), bodyType[1],
                returnType, returnJavaType);
        if (handlers != null) {
            handlers.put(spec, new Handler(def, handling, handlerCls, inherited.locators()));
        }
        return spec;
    }

    private static Type safeGenericReturnType(Method handling, Class<?> rawRet) {
        try {
            return handling.getGenericReturnType();
        } catch (RuntimeException | LinkageError e) {
            return rawRet;
        }
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

    private static void param(Object p, List<Param> out, String[] bodyType,
                              Set<Class<?>> visitedBeans, int beanDepth) throws ReflectiveOperationException {
        String source = String.valueOf(call(p, "getSource"));
        Class<?> raw = (Class<?>) call(p, "getRawType");
        Type type = (Type) call(p, "getType");
        String javaType = TypeFormatter.stableTypeName(type, raw);
        switch (source) {
            case "PATH", "QUERY", "HEADER", "MATRIX", "FORM" -> {
                String name = (String) call(p, "getSourceName");
                if (name == null || name.isEmpty()) {
                    return;
                }
                boolean repeating = (raw != null && (Collection.class.isAssignableFrom(raw) || raw.isArray()))
                        || (type instanceof java.lang.reflect.GenericArrayType);
                Class<?> element = repeating ? TypeFormatter.elementClass(type, raw) : raw;
                String desc = OpenApiAnnotationExtractor.paramDoc(parameterAnnotations(p));
                out.add(new Param(name, source.toLowerCase(Locale.ROOT), typeName(element), "PATH".equals(source),
                        (String) call(p, "getDefaultValue"), JerseyAnnotationSupport.options(element),
                        repeating, desc, javaType));
            }
            case "ENTITY" -> {
                bodyType[0] = javaType != null ? shortTypeName(javaType) : (raw == null ? null : raw.getSimpleName());
                bodyType[1] = javaType;
            }
            case "BEAN_PARAM" -> {
                if (beanDepth >= MAX_BEAN_DEPTH) {
                    return;
                }
                Class<?> beanCls = raw != null ? TypeProxyUnwrapper.targetClass(raw) : null;
                if (beanCls != null && !visitedBeans.add(beanCls)) {
                    return; // break cyclic @BeanParam self-references safely
                }
                try {
                    Method m = findMethod(p.getClass(), "getParameters", new Class<?>[0]);
                    if (m != null) {
                        Object innerList = invoke(m, p);
                        if (innerList instanceof Collection<?> items) {
                            for (Object inner : items) {
                                param(inner, out, bodyType, visitedBeans, beanDepth + 1);
                            }
                        }
                    }
                } finally {
                    if (beanCls != null) {
                        visitedBeans.remove(beanCls);
                    }
                }
            }
            default -> {
                Annotation[] anns = parameterAnnotations(p);
                String mpName = multipartParamName(anns);
                if (mpName != null) {
                    boolean repeating = (raw != null && (Collection.class.isAssignableFrom(raw) || raw.isArray()))
                            || (type instanceof java.lang.reflect.GenericArrayType);
                    Class<?> element = repeating ? TypeFormatter.elementClass(type, raw) : raw;
                    String tName = isFileType(element) ? "File" : typeName(element);
                    out.add(new Param(mpName, "form", tName, false,
                            (String) call(p, "getDefaultValue"), JerseyAnnotationSupport.options(element),
                            repeating, OpenApiAnnotationExtractor.paramDoc(anns), javaType));
                }
            }
        }
    }

    private static Annotation[] parameterAnnotations(Object p) {
        try {
            Object a = call(p, "getAnnotations");
            return a instanceof Annotation[] array ? array : null;
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
            return null;
        }
    }

    // ---- delegating helpers (preserving existing package-private test hooks)

    static String stableTypeName(Type type, Class<?> raw) {
        return TypeFormatter.stableTypeName(type, raw);
    }

    static String shortTypeName(Type type) {
        return TypeFormatter.shortTypeName(type);
    }

    static String shortTypeName(String full) {
        return TypeFormatter.shortTypeName(full);
    }

    static String typeName(Class<?> c) {
        return TypeFormatter.typeName(c);
    }

    static String access(Method handling) {
        return access(handling, handling, null);
    }

    static String access(Method def, Method handling, Class<?> handlerClass) {
        return JerseyAnnotationSupport.access(def, handling, handlerClass);
    }

    static boolean isDeprecated(Method def, Method handling, Class<?> handlerClass) {
        return JerseyAnnotationSupport.isDeprecated(def, handling, handlerClass);
    }

    record OpDoc(String summary, String description, boolean deprecated) {
        static final OpDoc EMPTY = new OpDoc(null, null, false);
    }

    static OpDoc opDoc(Method definition, Method handling) {
        OpenApiAnnotationExtractor.OpDoc doc = OpenApiAnnotationExtractor.opDoc(definition, handling);
        return doc.isEmpty() ? OpDoc.EMPTY : new OpDoc(doc.summary(), doc.description(), doc.deprecated());
    }

    static String annotatedReturnJavaType(Method definition, Method handling) {
        return OpenApiAnnotationExtractor.annotatedReturnJavaType(definition, handling);
    }

    static String multipartParamName(Annotation[] annotations) {
        return JerseyAnnotationSupport.multipartParamName(annotations);
    }

    static boolean isFileType(Class<?> c) {
        return JerseyAnnotationSupport.isFileType(c);
    }

    static Map<String, String> paramDocs(Method definition, Method handling) {
        return OpenApiAnnotationExtractor.paramDocs(definition, handling);
    }

    static String paramDoc(Annotation[] annotations) {
        return OpenApiAnnotationExtractor.paramDoc(annotations);
    }

    static List<Param> applyParamDocs(List<Param> params, Map<String, String> docs) {
        return JerseyAnnotationSupport.applyParamDocs(params, docs);
    }

    static String cleanDoc(String s, int max) {
        return OpenApiAnnotationExtractor.cleanDoc(s, max);
    }

    static List<Param> completePathParams(String path, List<Param> params) {
        return JerseyAnnotationSupport.completePathParams(path, params);
    }

    static List<String> templateNames(String path) {
        return JerseyAnnotationSupport.templateNames(path);
    }

    static String join(String prefix, String path) {
        return JerseyAnnotationSupport.join(prefix, path);
    }
}
