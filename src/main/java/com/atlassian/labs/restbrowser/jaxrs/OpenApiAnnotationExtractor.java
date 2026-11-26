package com.atlassian.labs.restbrowser.jaxrs;

import java.lang.annotation.Annotation;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import static com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge.annMember;
import static com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge.annString;
import static com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge.safeDeclaredAnnotations;

/**
 * Extracts documentation and concrete response types from OpenAPI v3, Swagger v2, and optional extension
 * annotations (such as {@code @ResponseType}/{@code @ResponseTypes} and {@code @PathParamDoc}).
 * <p>
 * Compiled with zero compile-time dependencies on OpenAPI, Swagger, or Atlassian annotations.
 */
public final class OpenApiAnnotationExtractor {

    public static final int MAX_SUMMARY = 300;
    public static final int MAX_DESCRIPTION = 2000;
    public static final int MAX_PARAM_DESCRIPTION = 500;

    public static final String OAS_OPERATION = "io.swagger.v3.oas.annotations.Operation";
    public static final String OAS_PARAMETER = "io.swagger.v3.oas.annotations.Parameter";
    public static final String OAS_PARAMETERS = "io.swagger.v3.oas.annotations.Parameters";
    public static final String OAS_API_RESPONSE = "io.swagger.v3.oas.annotations.responses.ApiResponse";
    public static final String OAS_API_RESPONSES = "io.swagger.v3.oas.annotations.responses.ApiResponses";
    public static final String SWAGGER_OPERATION = "io.swagger.annotations.ApiOperation";
    public static final String SWAGGER_API_RESPONSE = "io.swagger.annotations.ApiResponse";
    public static final String SWAGGER_API_RESPONSES = "io.swagger.annotations.ApiResponses";
    public static final String SWAGGER_PARAM = "io.swagger.annotations.ApiParam";
    public static final String SWAGGER_IMPLICIT_PARAM = "io.swagger.annotations.ApiImplicitParam";
    public static final String SWAGGER_IMPLICIT_PARAMS = "io.swagger.annotations.ApiImplicitParams";
    public static final String PATH_PARAM_DOC = "com.atlassian.dc.swagger.annotations.PathParamDoc";
    public static final String PATH_PARAM_DOCS = "com.atlassian.dc.swagger.annotations.PathParamDocs";

    public record OpDoc(String summary, String description, boolean deprecated) {
        public static final OpDoc EMPTY = new OpDoc(null, null, false);

        public boolean isEmpty() {
            return summary == null && description == null && !deprecated;
        }
    }

    private OpenApiAnnotationExtractor() {
    }

    public static OpDoc opDoc(Method definition, Method handling) {
        OpDoc doc = opDocOf(definition);
        if (handling != null && !handling.equals(definition)) {
            OpDoc fallback = opDocOf(handling);
            if (doc.isEmpty()) {
                return fallback;
            }
            // Fill any missing summary/description/deprecated from handling if definition only partially documented
            return new OpDoc(
                    doc.summary() != null ? doc.summary() : fallback.summary(),
                    doc.description() != null ? doc.description() : fallback.description(),
                    doc.deprecated() || fallback.deprecated());
        }
        return doc;
    }

    private static OpDoc opDocOf(Method method) {
        if (method == null) {
            return OpDoc.EMPTY;
        }
        Annotation[] all = safeDeclaredAnnotations(method);
        OpDoc oas = null;
        for (Annotation a : all) {
            Class<? extends Annotation> at = safeAnnotationType(a);
            if (at != null && OAS_OPERATION.equals(at.getName())) {
                String summary = cleanDoc(annString(a, "summary"), MAX_SUMMARY);
                String description = cleanDoc(annString(a, "description"), MAX_DESCRIPTION);
                boolean deprecated = Boolean.TRUE.equals(annMember(a, "deprecated"));
                if (summary != null && summary.equals(description)) {
                    description = null;
                }
                oas = new OpDoc(summary, description, deprecated);
                break;
            }
        }
        if (oas != null && oas.summary() != null && oas.description() != null) {
            return oas;
        }
        for (Annotation a : all) {
            Class<? extends Annotation> at = safeAnnotationType(a);
            if (at != null && SWAGGER_OPERATION.equals(at.getName())) {
                String summary = cleanDoc(annString(a, "value"), MAX_SUMMARY);
                String description = cleanDoc(annString(a, "notes"), MAX_DESCRIPTION);
                if (summary != null && summary.equals(description)) {
                    description = null;
                }
                String mergedSummary = oas != null && oas.summary() != null ? oas.summary() : summary;
                String mergedDesc = oas != null && oas.description() != null ? oas.description() : description;
                if (mergedSummary != null && mergedSummary.equals(mergedDesc)) {
                    mergedDesc = null;
                }
                OpDoc sw = new OpDoc(mergedSummary, mergedDesc, oas != null && oas.deprecated());
                if (!sw.isEmpty()) {
                    return sw;
                }
            }
        }
        return oas != null ? oas : OpDoc.EMPTY;
    }

    public static String annotatedReturnJavaType(Method definition, Method handling) {
        String type = annotatedReturnJavaTypeOf(definition);
        if (type == null && handling != null && !handling.equals(definition)) {
            type = annotatedReturnJavaTypeOf(handling);
        }
        return type;
    }

    private static String annotatedReturnJavaTypeOf(Method method) {
        if (method == null) {
            return null;
        }
        Annotation[] all = safeDeclaredAnnotations(method);
        // 1. OpenAPI v3
        List<Annotation> oasResponses = new ArrayList<>();
        for (Annotation a : all) {
            Class<? extends Annotation> at = safeAnnotationType(a);
            if (at == null) {
                continue;
            }
            String name = at.getName();
            if (OAS_API_RESPONSE.equals(name)) {
                oasResponses.add(a);
            } else if (OAS_API_RESPONSES.equals(name)) {
                addAnnotations(annMember(a, "value"), oasResponses);
            } else if (OAS_OPERATION.equals(name)) {
                addAnnotations(annMember(a, "responses"), oasResponses);
            }
        }
        String fromOas = extractOasResponseType(oasResponses);
        if (fromOas != null) {
            return fromOas;
        }

        // 2. Atlassian @ResponseType / @ResponseTypes container (preferring SUCCESS over CLIENT_ERROR/SERVER_ERROR)
        List<Annotation> responseTypes = new ArrayList<>();
        for (Annotation a : all) {
            Class<? extends Annotation> at = safeAnnotationType(a);
            if (at == null) {
                continue;
            }
            String simple = at.getSimpleName();
            if ("ResponseType".equals(simple)) {
                responseTypes.add(a);
            } else if ("ResponseTypes".equals(simple)) {
                addAnnotations(annMember(a, "value"), responseTypes);
            }
        }
        String errorFallback = null;
        for (Annotation rt : responseTypes) {
            Object statusObj = annMember(rt, "statusType");
            String statusName = statusObj == null ? "" : String.valueOf(statusObj).toUpperCase(Locale.ROOT);
            boolean isError = statusName.contains("ERROR") || statusName.contains("FAILURE");
            String formatted = formatAtlassianResponseType(rt);
            if (formatted == null) {
                continue;
            }
            if (!isError) {
                return formatted;
            }
            if (errorFallback == null) {
                errorFallback = formatted;
            }
        }
        if (errorFallback != null) {
            return errorFallback;
        }

        // 3. Swagger v2
        for (Annotation a : all) {
            Class<? extends Annotation> at = safeAnnotationType(a);
            if (at != null && SWAGGER_OPERATION.equals(at.getName())) {
                String t = formatSwaggerResponse(annMember(a, "response"), annString(a, "responseContainer"));
                if (t != null) {
                    return t;
                }
            }
        }
        List<Annotation> swResponses = new ArrayList<>();
        for (Annotation a : all) {
            Class<? extends Annotation> at = safeAnnotationType(a);
            if (at == null) {
                continue;
            }
            String name = at.getName();
            if (SWAGGER_API_RESPONSE.equals(name)) {
                swResponses.add(a);
            } else if (SWAGGER_API_RESPONSES.equals(name)) {
                addAnnotations(annMember(a, "value"), swResponses);
            }
        }
        for (Annotation r : swResponses) {
            Object codeObj = annMember(r, "code");
            if (codeObj instanceof Integer code && code >= 200 && code < 300) {
                String t = formatSwaggerResponse(annMember(r, "response"), annString(r, "responseContainer"));
                if (t != null) {
                    return t;
                }
            }
        }
        return null;
    }

    private static String formatAtlassianResponseType(Annotation a) {
        Object val = annMember(a, "value");
        if (val instanceof Class<?> cls && isConcreteResponseClass(cls)) {
            String base = TypeFormatter.stableTypeName(cls, cls);
            Object generics = annMember(a, "genericTypes");
            if (generics instanceof Class<?>[] gArr && gArr.length > 0) {
                List<String> args = new ArrayList<>();
                for (Class<?> g : gArr) {
                    if (g != null) {
                        args.add(TypeFormatter.stableTypeName(g, g));
                    }
                }
                if (!args.isEmpty()) {
                    return base + "<" + String.join(", ", args) + ">";
                }
            }
            return base;
        }
        return null;
    }

    private static void addAnnotations(Object value, List<Annotation> out) {
        if (value instanceof Annotation[] array) {
            Collections.addAll(out, array);
        }
    }

    private static String extractOasResponseType(List<Annotation> responses) {
        if (responses.isEmpty()) {
            return null;
        }
        String fallback = null;
        for (Annotation resp : responses) {
            String code = annString(resp, "responseCode");
            boolean is2xx = code != null && code.trim().startsWith("2");
            boolean isDefault = code == null || code.isBlank() || "default".equalsIgnoreCase(code.trim());
            if (!is2xx && !isDefault) {
                continue;
            }
            String found = extractOasContentType(annMember(resp, "content"));
            if (found != null) {
                if (is2xx) {
                    return found;
                }
                if (fallback == null) {
                    fallback = found;
                }
            }
        }
        return fallback;
    }

    private static String extractOasContentType(Object contentObj) {
        if (!(contentObj instanceof Annotation[] contents)) {
            return null;
        }
        for (Annotation content : contents) {
            Object arrayAnn = annMember(content, "array");
            if (arrayAnn instanceof Annotation arr) {
                String item = extractOasSchemaType(annMember(arr, "schema"));
                if (item != null) {
                    return item + "[]";
                }
                String arrSchema = extractOasSchemaType(annMember(arr, "arraySchema"));
                if (arrSchema != null) {
                    return arrSchema;
                }
            }
            String direct = extractOasSchemaType(annMember(content, "schema"));
            if (direct != null) {
                return direct;
            }
        }
        return null;
    }

    private static String extractOasSchemaType(Object schemaObj) {
        if (!(schemaObj instanceof Annotation schema)) {
            return null;
        }
        String base = null;
        Object impl = annMember(schema, "implementation");
        if (impl instanceof Class<?> cls && isConcreteResponseClass(cls)) {
            base = TypeFormatter.stableTypeName(cls, cls);
        }
        if (base == null) {
            for (String member : new String[]{"oneOf", "anyOf", "allOf"}) {
                Object arr = annMember(schema, member);
                if (arr instanceof Class<?>[] classes) {
                    for (Class<?> cls : classes) {
                        if (isConcreteResponseClass(cls)) {
                            base = TypeFormatter.stableTypeName(cls, cls);
                            break;
                        }
                    }
                }
                if (base != null) {
                    break;
                }
            }
        }
        if (base != null && "array".equalsIgnoreCase(annString(schema, "type"))) {
            return base + "[]";
        }
        return base;
    }

    private static String formatSwaggerResponse(Object responseObj, String container) {
        if (!(responseObj instanceof Class<?> cls) || !isConcreteResponseClass(cls)) {
            return null;
        }
        String base = TypeFormatter.stableTypeName(cls, cls);
        if (base == null) {
            return null;
        }
        if (container == null || container.isBlank()) {
            return base;
        }
        return switch (container.trim().toLowerCase(Locale.ROOT)) {
            case "list" -> "java.util.List<" + base + ">";
            case "set" -> "java.util.Set<" + base + ">";
            case "map" -> "java.util.Map<java.lang.String, " + base + ">";
            default -> base;
        };
    }

    private static boolean isConcreteResponseClass(Class<?> cls) {
        return cls != null && cls != Void.class && cls != void.class && cls != Object.class;
    }

    public static Map<String, String> paramDocs(Method definition, Method handling) {
        Map<String, String> out = new HashMap<>();
        if (definition != null) {
            collectMethodParamDocs(definition, out);
            collectClassParamDocs(definition.getDeclaringClass(), out);
        }
        if (handling != null && !handling.equals(definition)) {
            collectMethodParamDocs(handling, out);
            collectClassParamDocs(handling.getDeclaringClass(), out);
        }
        return out;
    }

    private static void collectMethodParamDocs(Method method, Map<String, String> out) {
        for (Annotation a : safeDeclaredAnnotations(method)) {
            Class<? extends Annotation> at = safeAnnotationType(a);
            if (at == null) {
                continue;
            }
            String name = at.getName();
            if (OAS_PARAMETER.equals(name)) {
                recordOasParam(a, out);
            } else if (OAS_PARAMETERS.equals(name)) {
                recordAnnotationArray(annMember(a, "value"), out, true);
            } else if (OAS_OPERATION.equals(name)) {
                recordAnnotationArray(annMember(a, "parameters"), out, true);
            } else if (SWAGGER_IMPLICIT_PARAM.equals(name)) {
                recordSwaggerImplicitParam(a, out);
            } else if (SWAGGER_IMPLICIT_PARAMS.equals(name)) {
                recordAnnotationArray(annMember(a, "value"), out, false);
            }
        }
    }

    private static void collectClassParamDocs(Class<?> cls, Map<String, String> out) {
        if (cls == null) {
            return;
        }
        for (Annotation a : safeDeclaredAnnotations(cls)) {
            Class<? extends Annotation> at = safeAnnotationType(a);
            if (at == null) {
                continue;
            }
            String annName = at.getName();
            if (PATH_PARAM_DOC.equals(annName)) {
                recordPathParamDoc(a, out);
            } else if (PATH_PARAM_DOCS.equals(annName)) {
                Object val = annMember(a, "value");
                if (val instanceof Annotation[] arr) {
                    for (Annotation child : arr) {
                        recordPathParamDoc(child, out);
                    }
                }
            } else if (OAS_PARAMETER.equals(annName)) {
                recordOasParam(a, out);
            } else if (OAS_PARAMETERS.equals(annName)) {
                recordAnnotationArray(annMember(a, "value"), out, true);
            } else if (SWAGGER_IMPLICIT_PARAM.equals(annName)) {
                recordSwaggerImplicitParam(a, out);
            } else if (SWAGGER_IMPLICIT_PARAMS.equals(annName)) {
                recordAnnotationArray(annMember(a, "value"), out, false);
            }
        }
    }

    private static void recordPathParamDoc(Annotation a, Map<String, String> out) {
        String name = annString(a, "name");
        String desc = annString(a, "documentation");
        if (desc == null) {
            desc = annString(a, "description");
        }
        putParamDoc(out, "path", name, desc);
    }

    private static void recordAnnotationArray(Object value, Map<String, String> out, boolean oas) {
        if (value instanceof Annotation[] array) {
            for (Annotation a : array) {
                if (oas) {
                    recordOasParam(a, out);
                } else {
                    recordSwaggerImplicitParam(a, out);
                }
            }
        }
    }

    private static void recordOasParam(Annotation a, Map<String, String> out) {
        String name = annString(a, "name");
        String desc = annString(a, "description");
        Object inObj = annMember(a, "in");
        String in = null;
        if (inObj instanceof Enum<?> e) {
            String n = e.name().toLowerCase(Locale.ROOT);
            if (!"default".equals(n)) {
                in = n;
            }
        }
        putParamDoc(out, in, name, desc);
    }

    private static void recordSwaggerImplicitParam(Annotation a, Map<String, String> out) {
        String name = annString(a, "name");
        String desc = annString(a, "value");
        String in = annString(a, "paramType");
        if (in != null) {
            in = in.trim().toLowerCase(Locale.ROOT);
            if (in.isEmpty()) {
                in = null;
            }
        }
        putParamDoc(out, in, name, desc);
    }

    private static void putParamDoc(Map<String, String> out, String in, String name, String rawDesc) {
        if (name == null || name.isBlank()) {
            return;
        }
        String desc = cleanDoc(rawDesc, MAX_PARAM_DESCRIPTION);
        if (desc == null) {
            return;
        }
        String key = name.trim();
        if (in != null && !in.isEmpty()) {
            out.putIfAbsent(in + ":" + key, desc);
        }
        out.putIfAbsent(":" + key, desc);
    }

    public static String paramDoc(Annotation[] annotations) {
        if (annotations == null) {
            return null;
        }
        for (Annotation a : annotations) {
            Class<? extends Annotation> at = safeAnnotationType(a);
            if (at == null) {
                continue;
            }
            String name = at.getName();
            if (OAS_PARAMETER.equals(name)) {
                String d = cleanDoc(annString(a, "description"), MAX_PARAM_DESCRIPTION);
                if (d != null) {
                    return d;
                }
            } else if (SWAGGER_PARAM.equals(name)) {
                String d = cleanDoc(annString(a, "value"), MAX_PARAM_DESCRIPTION);
                if (d != null) {
                    return d;
                }
            }
        }
        return null;
    }

    private static Class<? extends Annotation> safeAnnotationType(Annotation a) {
        if (a == null) {
            return null;
        }
        try {
            return a.annotationType();
        } catch (RuntimeException | LinkageError ignored) {
            return null;
        }
    }

    public static String cleanDoc(String s, int max) {
        if (s == null) {
            return null;
        }
        String t = s.replace("\r\n", "\n").replace('\r', '\n').trim();
        if (t.isEmpty()) {
            return null;
        }
        if (t.length() <= max) {
            return t;
        }
        int end = Character.isHighSurrogate(t.charAt(max - 1)) ? max - 1 : max;
        return t.substring(0, end) + "…";
    }
}
