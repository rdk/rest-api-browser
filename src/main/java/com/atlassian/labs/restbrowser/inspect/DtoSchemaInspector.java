package com.atlassian.labs.restbrowser.inspect;

import com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge;
import com.atlassian.labs.restbrowser.jaxrs.TypeFormatter;
import com.atlassian.labs.restbrowser.json.Json;

import java.lang.annotation.Annotation;
import java.lang.reflect.AnnotatedElement;
import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.lang.reflect.GenericArrayType;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.RecordComponent;
import java.lang.reflect.Type;
import java.lang.reflect.TypeVariable;
import java.lang.reflect.WildcardType;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge.annMember;
import static com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge.annString;
import static com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge.safeDeclaredAnnotations;

/**
 * Pure-JDK JSON Schema (Draft 2020-12) and example-payload synthesizer for Java DTO classes and generic types.
 * <p>
 * Inspects Jackson, JAXB, Jakarta/JSR-303 Bean Validation, and OpenAPI {@code @Schema} annotations purely via
 * {@link ReflectiveBridge} so callers never acquire optional OSGi bundle imports.
 */
public final class DtoSchemaInspector {

    private static final int MAX_TYPES = 60;
    private static final int MAX_PROPS = 80;
    private static final int MAX_ENUM_VALUES = 100;

    public record SchemaResult(String javaType, String schemaJson, String exampleJson,
                               int typesVisited, boolean truncated) {
    }

    private record PropSpec(String jsonName, String javaName, Type genericType, Class<?> rawType,
                            boolean required, String description, String example,
                            Long min, Long max, Integer minSize, Integer maxSize,
                            String pattern, boolean nullable) {
    }

    private DtoSchemaInspector() {
    }

    public static SchemaResult inspect(Type type, Class<?> rawClass, int rawMaxDepth, boolean includeExample) {
        int maxDepth = Math.max(1, Math.min(5, rawMaxDepth <= 0 ? 3 : rawMaxDepth));
        String fullType = TypeFormatter.stableTypeName(type, rawClass);
        Context ctx = new Context(maxDepth);
        String rootSchema = writeTypeSchema(type != null ? type : rawClass, rawClass, Map.of(), 0, null, ctx);

        Json fullSchema = new Json().raw(injectSchemaHeader(rootSchema, ctx.defs));
        String example = includeExample
                ? writeExample(type != null ? type : rawClass, rawClass, Map.of(), 0, new HashSet<>(), ctx.typeCount)
                : null;
        return new SchemaResult(fullType, fullSchema.toString(), example, ctx.typeCount, ctx.truncated);
    }

    /** Returns an explicit Jackson {@code @JsonProperty} or JAXB {@code @XmlElement}/{@code @XmlAttribute} name, or null. */
    public static String serializedFieldName(Field field) {
        if (field == null) {
            return null;
        }
        return explicitSerializedName(safeDeclaredAnnotations(field));
    }

    private static String explicitSerializedName(Annotation[] annotations) {
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

    private static final class Context {
        final int maxDepth;
        final Set<Class<?>> visiting = new HashSet<>();
        final Map<Class<?>, String> defNames = new LinkedHashMap<>();
        final Map<String, String> defs = new LinkedHashMap<>();
        final Set<Class<?>> referencedCyclicDefs = new HashSet<>();
        int typeCount;
        boolean truncated;

        Context(int maxDepth) {
            this.maxDepth = maxDepth;
        }

        String defName(Class<?> c) {
            String existing = defNames.get(c);
            if (existing != null) {
                return existing;
            }
            String base = c.getSimpleName().isEmpty() ? "Type" : c.getSimpleName().replaceAll("[^A-Za-z0-9_]", "_");
            String candidate = base;
            int n = 2;
            while (defNames.containsValue(candidate)) {
                candidate = base + "_" + n++;
            }
            defNames.put(c, candidate);
            return candidate;
        }
    }

    private static String injectSchemaHeader(String rootObjJson, Map<String, String> defs) {
        if (!rootObjJson.startsWith("{") || !rootObjJson.endsWith("}")) {
            return rootObjJson;
        }
        StringBuilder sb = new StringBuilder(rootObjJson.length() + 128);
        sb.append("{\"$schema\":")
                .append(new Json().value("https://json-schema.org/draft/2020-12/schema").toString());
        String inner = rootObjJson.substring(1, rootObjJson.length() - 1);
        if (!inner.isEmpty()) {
            sb.append(',').append(inner);
        }
        if (!defs.isEmpty()) {
            Json defsObj = new Json().beginObject();
            for (Map.Entry<String, String> e : defs.entrySet()) {
                defsObj.name(e.getKey()).raw(e.getValue());
            }
            defsObj.endObject();
            sb.append(",\"$defs\":").append(defsObj.toString());
        }
        return sb.append('}').toString();
    }

    private static String writeTypeSchema(Type type, Class<?> rawHint, Map<TypeVariable<?>, Type> scopeVars,
                                          int depth, PropSpec meta, Context ctx) {
        Type resolved = substitute(type, scopeVars);
        Class<?> raw = rawClassOf(resolved, rawHint);
        if (raw != null) {
            raw = TypeProxyUnwrapper.unwrapType(raw);
        }

        if (raw != null && Optional.class.isAssignableFrom(raw)) {
            Type inner = firstTypeArg(resolved);
            return writeTypeSchema(inner != null ? inner : Object.class, null, scopeVars, depth,
                    withNullable(meta, true), ctx);
        }

        String scalar = writeScalarOrOpaqueSchema(resolved, raw, meta);
        if (scalar != null) {
            return scalar;
        }

        if (raw != null && raw.isArray()) {
            if (raw.getComponentType() == byte.class || raw.getComponentType() == Byte.class) {
                return finishObjectMeta(new Json().beginObject().field("type", "string").field("format", "byte"), meta);
            }
            Class<?> comp = raw.getComponentType();
            String items = writeTypeSchema(comp, comp, scopeVars, depth + 1, null, ctx);
            Json j = new Json().beginObject().field("type", "array").name("items").raw(items);
            return finishArrayMeta(j, meta);
        }
        if (resolved instanceof GenericArrayType ga) {
            String items = writeTypeSchema(ga.getGenericComponentType(), null, scopeVars, depth + 1, null, ctx);
            Json j = new Json().beginObject().field("type", "array").name("items").raw(items);
            return finishArrayMeta(j, meta);
        }
        if (raw != null && Collection.class.isAssignableFrom(raw)) {
            Type elem = firstTypeArg(resolved);
            if (elem == null) {
                Class<?> superElem = TypeFormatter.elementClass(resolved, raw);
                elem = superElem;
            }
            String items = elem != null
                    ? writeTypeSchema(elem, null, scopeVars, depth + 1, null, ctx)
                    : "{\"type\":\"object\"}";
            Json j = new Json().beginObject().field("type", "array").name("items").raw(items);
            return finishArrayMeta(j, meta);
        }
        if (raw != null && Map.class.isAssignableFrom(raw)) {
            Type[] kv = typeArgs(resolved);
            String valSchema = kv.length >= 2
                    ? writeTypeSchema(kv[1], null, scopeVars, depth + 1, null, ctx)
                    : "{\"type\":\"object\"}";
            Json j = new Json().beginObject()
                    .field("type", "object")
                    .name("additionalProperties").raw(valSchema);
            return finishObjectMeta(j, meta);
        }

        if (raw == null || isOpaqueLibraryType(raw)) {
            Json j = new Json().beginObject().field("type", "object");
            if (raw != null) {
                j.field("x-javaType", raw.getName());
            }
            return finishObjectMeta(j, meta);
        }

        if (ctx.typeCount >= MAX_TYPES || depth >= ctx.maxDepth) {
            ctx.truncated = true;
            Json j = new Json().beginObject()
                    .field("type", "object")
                    .field("x-javaType", raw.getName())
                    .field("x-truncated", true);
            return finishObjectMeta(j, meta);
        }

        if (!ctx.visiting.add(raw)) {
            String defName = ctx.defName(raw);
            ctx.referencedCyclicDefs.add(raw);
            return new Json().beginObject()
                    .field("$ref", "#/$defs/" + defName)
                    .field("x-javaType", raw.getName())
                    .endObject().toString();
        }

        ctx.typeCount++;
        try {
            Map<TypeVariable<?>, Type> nextVars = bindTypeArgs(raw, resolved, scopeVars);
            List<PropSpec> props = extractProperties(raw, nextVars);
            Json j = new Json().beginObject()
                    .field("type", "object")
                    .field("x-javaType", raw.getName());
            addMetaFields(j, meta);
            List<String> subTypes = polymorphicSubtypes(raw);
            if (!subTypes.isEmpty()) {
                j.strings("x-subtypes", subTypes);
            }
            j.name("properties").beginObject();
            List<String> required = new ArrayList<>();
            int written = 0;
            for (PropSpec p : props) {
                if (written >= MAX_PROPS) {
                    ctx.truncated = true;
                    break;
                }
                written++;
                String pSchema = writeTypeSchema(p.genericType(), p.rawType(), nextVars, depth + 1, p, ctx);
                j.name(p.jsonName()).raw(pSchema);
                if (p.required()) {
                    required.add(p.jsonName());
                }
            }
            j.endObject();
            if (!required.isEmpty()) {
                j.strings("required", required);
            }
            String serialized = j.endObject().toString();
            if (ctx.referencedCyclicDefs.contains(raw)) {
                ctx.defs.putIfAbsent(ctx.defName(raw), serialized);
            }
            return serialized;
        } finally {
            ctx.visiting.remove(raw);
        }
    }

    private static String writeScalarOrOpaqueSchema(Type type, Class<?> raw, PropSpec meta) {
        if (raw == null) {
            return null;
        }
        if (raw == Object.class) {
            return finishObjectMeta(new Json().beginObject().field("x-javaType", "java.lang.Object"), meta);
        }
        if (raw.isEnum()) {
            Json j = new Json().beginObject()
                    .field("type", "string")
                    .field("x-javaType", raw.getName());
            List<String> vals = enumConstants(raw, MAX_ENUM_VALUES);
            if (!vals.isEmpty()) {
                j.strings("enum", vals);
            }
            return finishObjectMeta(j, meta);
        }
        if (raw == boolean.class || raw == Boolean.class) {
            return finishObjectMeta(new Json().beginObject().field("type", "boolean"), meta);
        }
        if (raw == int.class || raw == Integer.class || raw == short.class || raw == Short.class
                || raw == byte.class || raw == Byte.class) {
            return finishNumericMeta(new Json().beginObject().field("type", "integer").field("format", "int32"), meta);
        }
        if (raw == long.class || raw == Long.class) {
            return finishNumericMeta(new Json().beginObject().field("type", "integer").field("format", "int64"), meta);
        }
        if (raw == java.math.BigInteger.class) {
            return finishNumericMeta(new Json().beginObject().field("type", "integer"), meta);
        }
        if (raw == float.class || raw == Float.class) {
            return finishNumericMeta(new Json().beginObject().field("type", "number").field("format", "float"), meta);
        }
        if (raw == double.class || raw == Double.class) {
            return finishNumericMeta(new Json().beginObject().field("type", "number").field("format", "double"), meta);
        }
        if (raw == java.math.BigDecimal.class || raw == Number.class) {
            return finishNumericMeta(new Json().beginObject().field("type", "number"), meta);
        }
        if (raw == String.class || raw == CharSequence.class || raw == char.class || raw == Character.class) {
            return finishStringMeta(new Json().beginObject().field("type", "string"), meta);
        }
        String n = raw.getName();
        if ("java.util.UUID".equals(n)) {
            return finishStringMeta(new Json().beginObject().field("type", "string").field("format", "uuid"), meta);
        }
        if ("java.net.URI".equals(n) || "java.net.URL".equals(n)) {
            return finishStringMeta(new Json().beginObject().field("type", "string").field("format", "uri"), meta);
        }
        if ("java.time.LocalDate".equals(n) || "java.sql.Date".equals(n)) {
            return finishStringMeta(new Json().beginObject().field("type", "string").field("format", "date"), meta);
        }
        if ("java.time.Duration".equals(n)) {
            return finishStringMeta(new Json().beginObject().field("type", "string").field("format", "duration"), meta);
        }
        if ("java.util.Date".equals(n) || "java.time.Instant".equals(n) || "java.time.OffsetDateTime".equals(n)
                || "java.time.ZonedDateTime".equals(n) || "java.time.LocalDateTime".equals(n)
                || "java.sql.Timestamp".equals(n) || java.util.Calendar.class.isAssignableFrom(raw)) {
            return finishStringMeta(new Json().beginObject().field("type", "string").field("format", "date-time"), meta);
        }
        if (n.equals("com.fasterxml.jackson.databind.JsonNode")
                || n.equals("com.fasterxml.jackson.databind.node.ObjectNode")
                || n.equals("org.codehaus.jackson.JsonNode")) {
            return finishObjectMeta(new Json().beginObject().field("type", "object").field("x-javaType", n), meta);
        }
        if (n.equals("com.fasterxml.jackson.databind.node.ArrayNode")) {
            return finishArrayMeta(new Json().beginObject().field("type", "array").field("x-javaType", n), meta);
        }
        return null;
    }

    private static List<PropSpec> extractProperties(Class<?> cls, Map<TypeVariable<?>, Type> scopeVars) {
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
            for (Annotation a : anns) {
                annotations.add(a);
            }
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
            for (Annotation a : anns) {
                annotations.add(a);
            }
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

    private static String writeExample(Type type, Class<?> rawHint, Map<TypeVariable<?>, Type> vars, int depth,
                                       Set<Class<?>> visiting, int maxObjectsBudget) {
        Type resolved = substitute(type, vars);
        Class<?> raw = rawClassOf(resolved, rawHint);
        if (raw != null) {
            raw = TypeProxyUnwrapper.unwrapType(raw);
        }
        if (raw != null && Optional.class.isAssignableFrom(raw)) {
            Type inner = firstTypeArg(resolved);
            return writeExample(inner != null ? inner : Object.class, null, vars, depth, visiting, maxObjectsBudget);
        }
        if (raw == null) {
            return "null";
        }
        if (raw.isEnum()) {
            List<String> vals = enumConstants(raw, 1);
            return Json.quote(vals.isEmpty() ? "VALUE" : vals.get(0));
        }
        if (raw == boolean.class || raw == Boolean.class) {
            return "true";
        }
        if (raw == int.class || raw == Integer.class || raw == short.class || raw == Short.class
                || raw == byte.class || raw == Byte.class || raw == long.class || raw == Long.class
                || raw == java.math.BigInteger.class) {
            return "0";
        }
        if (raw == float.class || raw == Float.class || raw == double.class || raw == Double.class
                || raw == java.math.BigDecimal.class || raw == Number.class) {
            return "0.0";
        }
        String n = raw.getName();
        if ("java.util.UUID".equals(n)) {
            return "\"00000000-0000-0000-0000-000000000000\"";
        }
        if ("java.net.URI".equals(n) || "java.net.URL".equals(n)) {
            return "\"https://example.com\"";
        }
        if ("java.time.LocalDate".equals(n) || "java.sql.Date".equals(n)) {
            return "\"2026-01-01\"";
        }
        if ("java.time.Duration".equals(n)) {
            return "\"PT1M\"";
        }
        if ("java.util.Date".equals(n) || "java.time.Instant".equals(n) || "java.time.OffsetDateTime".equals(n)
                || "java.time.ZonedDateTime".equals(n) || "java.time.LocalDateTime".equals(n)
                || "java.sql.Timestamp".equals(n) || java.util.Calendar.class.isAssignableFrom(raw)) {
            return "\"2026-01-01T00:00:00Z\"";
        }
        if (raw == String.class || raw == CharSequence.class || raw == char.class || raw == Character.class) {
            return "\"string\"";
        }
        if (raw.isArray()) {
            if (raw.getComponentType() == byte.class || raw.getComponentType() == Byte.class) {
                return "\"AA==\"";
            }
            if (depth >= 3) {
                return "[]";
            }
            return "[" + writeExample(raw.getComponentType(), raw.getComponentType(), vars, depth + 1, visiting, maxObjectsBudget) + "]";
        }
        if (resolved instanceof GenericArrayType ga) {
            return depth >= 3 ? "[]" : "[" + writeExample(ga.getGenericComponentType(), null, vars, depth + 1, visiting, maxObjectsBudget) + "]";
        }
        if (Collection.class.isAssignableFrom(raw)) {
            if (depth >= 3) {
                return "[]";
            }
            Type elem = firstTypeArg(resolved);
            return "[" + writeExample(elem != null ? elem : String.class, null, vars, depth + 1, visiting, maxObjectsBudget) + "]";
        }
        if (Map.class.isAssignableFrom(raw)) {
            if (depth >= 3) {
                return "{}";
            }
            Type[] kv = typeArgs(resolved);
            String val = kv.length >= 2 ? writeExample(kv[1], null, vars, depth + 1, visiting, maxObjectsBudget) : "\"string\"";
            return "{\"key\":" + val + "}";
        }
        if (raw == Object.class || isOpaqueLibraryType(raw) || depth >= 3 || !visiting.add(raw)) {
            return "{}";
        }
        try {
            Map<TypeVariable<?>, Type> nextVars = bindTypeArgs(raw, resolved, vars);
            List<PropSpec> props = extractProperties(raw, nextVars);
            Json obj = new Json().beginObject();
            int count = 0;
            for (PropSpec p : props) {
                if (count++ >= 30) {
                    break;
                }
                String v = p.example() != null
                        ? exampleForLiteral(p)
                        : writeExample(p.genericType(), p.rawType(), nextVars, depth + 1, visiting, maxObjectsBudget);
                obj.name(p.jsonName()).raw(v);
            }
            return obj.endObject().toString();
        } finally {
            visiting.remove(raw);
        }
    }

    private static String exampleForLiteral(PropSpec p) {
        Class<?> raw = p.rawType();
        if (raw == boolean.class || raw == Boolean.class) {
            if ("true".equalsIgnoreCase(p.example()) || "false".equalsIgnoreCase(p.example())) {
                return p.example().toLowerCase(Locale.ROOT);
            }
        }
        if (raw == int.class || raw == Integer.class || raw == long.class || raw == Long.class
                || raw == double.class || raw == Double.class || raw == float.class || raw == Float.class) {
            try {
                Double.parseDouble(p.example());
                return p.example();
            } catch (NumberFormatException ignored) {
                // fall through to JSON string
            }
        }
        return Json.quote(p.example());
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

    private static List<String> polymorphicSubtypes(Class<?> c) {
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

    private static boolean isOpaqueLibraryType(Class<?> c) {
        if (c == null || c.isPrimitive()) {
            return false;
        }
        String n = c.getName();
        return n.startsWith("java.") || n.startsWith("javax.") || n.startsWith("jakarta.")
                || n.startsWith("jdk.") || n.startsWith("sun.") || n.startsWith("org.osgi.");
    }

    private static Type substitute(Type t, Map<TypeVariable<?>, Type> vars) {
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

    private static Map<TypeVariable<?>, Type> bindTypeArgs(Class<?> raw, Type type, Map<TypeVariable<?>, Type> outerVars) {
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

    private static Class<?> rawClassOf(Type t, Class<?> fallback) {
        if (t instanceof Class<?> c) {
            return c;
        }
        if (t instanceof ParameterizedType pt && pt.getRawType() instanceof Class<?> c) {
            return c;
        }
        return fallback;
    }

    private static Type firstTypeArg(Type t) {
        Type[] args = typeArgs(t);
        return args.length > 0 ? args[0] : null;
    }

    private static Type[] typeArgs(Type t) {
        if (t instanceof ParameterizedType pt) {
            return pt.getActualTypeArguments();
        }
        return new Type[0];
    }

    private static List<String> enumConstants(Class<?> c, int limit) {
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

    private static PropSpec withNullable(PropSpec meta, boolean nullable) {
        if (meta == null) {
            return new PropSpec("", "", Object.class, Object.class, false, null, null, null, null, null, null, null, nullable);
        }
        return new PropSpec(meta.jsonName(), meta.javaName(), meta.genericType(), meta.rawType(), meta.required(),
                meta.description(), meta.example(), meta.min(), meta.max(), meta.minSize(), meta.maxSize(),
                meta.pattern(), meta.nullable() || nullable);
    }

    private static void addMetaFields(Json j, PropSpec meta) {
        if (meta == null) {
            return;
        }
        j.optional("description", meta.description())
                .optional("x-example", meta.example());
        if (meta.nullable()) {
            j.field("nullable", true);
        }
    }

    private static String finishObjectMeta(Json j, PropSpec meta) {
        addMetaFields(j, meta);
        return j.endObject().toString();
    }

    private static String finishStringMeta(Json j, PropSpec meta) {
        addMetaFields(j, meta);
        if (meta != null) {
            if (meta.minSize() != null) j.field("minLength", meta.minSize());
            if (meta.maxSize() != null) j.field("maxLength", meta.maxSize());
            j.optional("pattern", meta.pattern());
        }
        return j.endObject().toString();
    }

    private static String finishNumericMeta(Json j, PropSpec meta) {
        addMetaFields(j, meta);
        if (meta != null) {
            if (meta.min() != null) j.field("minimum", meta.min());
            if (meta.max() != null) j.field("maximum", meta.max());
        }
        return j.endObject().toString();
    }

    private static String finishArrayMeta(Json j, PropSpec meta) {
        addMetaFields(j, meta);
        if (meta != null) {
            if (meta.minSize() != null) j.field("minItems", meta.minSize());
            if (meta.maxSize() != null) j.field("maxItems", meta.maxSize());
        }
        return j.endObject().toString();
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
