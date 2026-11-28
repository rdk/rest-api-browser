package com.atlassian.labs.restbrowser.inspect;

import com.atlassian.labs.restbrowser.inspect.DtoTypeResolver.PropSpec;
import com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge;
import com.atlassian.labs.restbrowser.jaxrs.TypeFormatter;
import com.atlassian.labs.restbrowser.json.Json;

import java.lang.reflect.Field;
import java.lang.reflect.GenericArrayType;
import java.lang.reflect.Type;
import java.lang.reflect.TypeVariable;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

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

    private DtoSchemaInspector() {
    }

    public static SchemaResult inspect(Type type, Class<?> rawClass, int rawMaxDepth, boolean includeExample) {
        int maxDepth = Math.max(1, Math.min(5, rawMaxDepth <= 0 ? 3 : rawMaxDepth));
        String fullType = TypeFormatter.stableTypeName(type, rawClass);
        Context ctx = new Context(maxDepth);
        String rootSchema = writeTypeSchema(type != null ? type : rawClass, rawClass, Map.of(), 0, null, ctx);

        Json fullSchema = new Json().raw(injectSchemaHeader(rootSchema, ctx.defs));
        String example = includeExample
                ? DtoExampleGenerator.writeExample(
                        type != null ? type : rawClass, rawClass, Map.of(), 0, new HashSet<>(), ctx.typeCount)
                : null;
        return new SchemaResult(fullType, fullSchema.toString(), example, ctx.typeCount, ctx.truncated);
    }

    /** Returns an explicit Jackson {@code @JsonProperty} or JAXB {@code @XmlElement}/{@code @XmlAttribute} name, or null. */
    public static String serializedFieldName(Field field) {
        if (field == null) {
            return null;
        }
        return DtoTypeResolver.explicitSerializedName(safeDeclaredAnnotations(field));
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
        Type resolved = DtoTypeResolver.substitute(type, scopeVars);
        Class<?> raw = DtoTypeResolver.rawClassOf(resolved, rawHint);
        if (raw != null) {
            raw = TypeProxyUnwrapper.unwrapType(raw);
        }

        if (raw != null && Optional.class.isAssignableFrom(raw)) {
            Type inner = DtoTypeResolver.firstTypeArg(resolved);
            return writeTypeSchema(inner != null ? inner : Object.class, null, scopeVars, depth,
                    DtoTypeResolver.withNullable(meta, true), ctx);
        }

        String scalar = writeScalarOrOpaqueSchema(raw, meta);
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
            Type elem = DtoTypeResolver.firstTypeArg(resolved);
            if (elem == null) {
                elem = TypeFormatter.elementClass(resolved, raw);
            }
            String items = elem != null
                    ? writeTypeSchema(elem, null, scopeVars, depth + 1, null, ctx)
                    : "{\"type\":\"object\"}";
            Json j = new Json().beginObject().field("type", "array").name("items").raw(items);
            return finishArrayMeta(j, meta);
        }
        if (raw != null && Map.class.isAssignableFrom(raw)) {
            Type[] kv = DtoTypeResolver.typeArgs(resolved);
            String valSchema = kv.length >= 2
                    ? writeTypeSchema(kv[1], null, scopeVars, depth + 1, null, ctx)
                    : "{\"type\":\"object\"}";
            Json j = new Json().beginObject()
                    .field("type", "object")
                    .name("additionalProperties").raw(valSchema);
            return finishObjectMeta(j, meta);
        }

        if (raw == null || DtoTypeResolver.isOpaqueLibraryType(raw)) {
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
            Map<TypeVariable<?>, Type> nextVars = DtoTypeResolver.bindTypeArgs(raw, resolved, scopeVars);
            List<PropSpec> props = DtoTypeResolver.extractProperties(raw, nextVars);
            Json j = new Json().beginObject()
                    .field("type", "object")
                    .field("x-javaType", raw.getName());
            addMetaFields(j, meta);
            List<String> subTypes = DtoTypeResolver.polymorphicSubtypes(raw);
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

    private static String writeScalarOrOpaqueSchema(Class<?> raw, PropSpec meta) {
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
            List<String> vals = DtoTypeResolver.enumConstants(raw, MAX_ENUM_VALUES);
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
        if ("com.fasterxml.jackson.databind.JsonNode".equals(n)
                || "com.fasterxml.jackson.databind.node.ObjectNode".equals(n)
                || "org.codehaus.jackson.JsonNode".equals(n)) {
            return finishObjectMeta(new Json().beginObject().field("type", "object").field("x-javaType", n), meta);
        }
        if ("com.fasterxml.jackson.databind.node.ArrayNode".equals(n)) {
            return finishArrayMeta(new Json().beginObject().field("type", "array").field("x-javaType", n), meta);
        }
        return null;
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
}
