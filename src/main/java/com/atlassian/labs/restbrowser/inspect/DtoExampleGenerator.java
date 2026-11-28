package com.atlassian.labs.restbrowser.inspect;

import com.atlassian.labs.restbrowser.inspect.DtoTypeResolver.PropSpec;
import com.atlassian.labs.restbrowser.json.Json;

import java.lang.reflect.GenericArrayType;
import java.lang.reflect.Type;
import java.lang.reflect.TypeVariable;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Generates bounded JSON example payloads from Java DTO types and extracted {@link PropSpec} metadata.
 */
final class DtoExampleGenerator {

    private DtoExampleGenerator() {
    }

    static String writeExample(Type type, Class<?> rawHint, Map<TypeVariable<?>, Type> vars, int depth,
                               Set<Class<?>> visiting, int maxObjectsBudget) {
        Type resolved = DtoTypeResolver.substitute(type, vars);
        Class<?> raw = DtoTypeResolver.rawClassOf(resolved, rawHint);
        if (raw != null) {
            raw = TypeProxyUnwrapper.unwrapType(raw);
        }
        if (raw != null && Optional.class.isAssignableFrom(raw)) {
            Type inner = DtoTypeResolver.firstTypeArg(resolved);
            return writeExample(inner != null ? inner : Object.class, null, vars, depth, visiting, maxObjectsBudget);
        }
        if (raw == null) {
            return "null";
        }
        if (raw.isEnum()) {
            List<String> vals = DtoTypeResolver.enumConstants(raw, 1);
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
            Type elem = DtoTypeResolver.firstTypeArg(resolved);
            return "[" + writeExample(elem != null ? elem : String.class, null, vars, depth + 1, visiting, maxObjectsBudget) + "]";
        }
        if (Map.class.isAssignableFrom(raw)) {
            if (depth >= 3) {
                return "{}";
            }
            Type[] kv = DtoTypeResolver.typeArgs(resolved);
            String val = kv.length >= 2 ? writeExample(kv[1], null, vars, depth + 1, visiting, maxObjectsBudget) : "\"string\"";
            return "{\"key\":" + val + "}";
        }
        if (raw == Object.class || DtoTypeResolver.isOpaqueLibraryType(raw) || depth >= 3 || !visiting.add(raw)) {
            return "{}";
        }
        try {
            Map<TypeVariable<?>, Type> nextVars = DtoTypeResolver.bindTypeArgs(raw, resolved, vars);
            List<PropSpec> props = DtoTypeResolver.extractProperties(raw, nextVars);
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
}
