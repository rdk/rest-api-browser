package com.atlassian.labs.restbrowser.inspect;

import com.atlassian.labs.restbrowser.catalog.AgentMarkdown;
import com.atlassian.labs.restbrowser.inspect.DtoSchemaInspector.SchemaResult;
import com.atlassian.labs.restbrowser.json.JsonParser;
import jakarta.servlet.http.HttpServletRequest;
import org.junit.Test;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.reflect.Field;
import java.lang.reflect.ParameterizedType;
import java.lang.reflect.Type;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.Assert.*;

public class DtoSchemaInspectorTest {

    public enum Status {
        OPEN, CLOSED
    }

    public record ItemRecord(String id, int count, Status status, Optional<String> note) {
    }

    public static class Page<T> {
        public List<T> values;
        public boolean lastPage;
        public Map<String, Integer> counts;
    }

    public static class Node {
        public String name;
        public Node parent;
        public List<Node> children;
    }

    @SuppressWarnings("unused")
    public static class ConstrainedDto {
        @NotNull
        @Size(min = 2, max = 40)
        @Pattern(regexp = "^[a-z0-9-]+$")
        public String slug;

        @NotBlank
        public String title;

        @Min(1L)
        @Max(500L)
        public Long count;

        public byte[] payload;
        public HttpServletRequest requestInterface;
        private transient String transientIgnored;
        public static String CONSTANT = "x";

        public String getDerived() {
            return title;
        }
    }

    @Test
    public void recordAndGenericPageProduceValidDraft202012SchemaAndExample() {
        Type pageOfItem = new ParameterizedType() {
            @Override
            public Type[] getActualTypeArguments() {
                return new Type[]{ItemRecord.class};
            }

            @Override
            public Type getRawType() {
                return Page.class;
            }

            @Override
            public Type getOwnerType() {
                return DtoSchemaInspectorTest.class;
            }
        };

        SchemaResult res = DtoSchemaInspector.inspect(pageOfItem, Page.class, 3, true);
        assertFalse(res.truncated());
        Map<String, Object> schema = JsonParser.parseObject(res.schemaJson());
        assertEquals("https://json-schema.org/draft/2020-12/schema", schema.get("$schema"));
        assertEquals("object", schema.get("type"));

        @SuppressWarnings("unchecked")
        Map<String, Object> props = (Map<String, Object>) schema.get("properties");
        assertNotNull(props.get("values"));
        assertNotNull(props.get("lastPage"));
        assertNotNull(props.get("counts"));

        @SuppressWarnings("unchecked")
        Map<String, Object> valuesSchema = (Map<String, Object>) props.get("values");
        assertEquals("array", valuesSchema.get("type"));
        @SuppressWarnings("unchecked")
        Map<String, Object> itemSchema = (Map<String, Object>) valuesSchema.get("items");
        assertEquals("object", itemSchema.get("type"));
        @SuppressWarnings("unchecked")
        Map<String, Object> itemProps = (Map<String, Object>) itemSchema.get("properties");
        assertTrue(itemProps.containsKey("status"));
        assertTrue(itemProps.containsKey("note"));

        Map<String, Object> example = JsonParser.parseObject(res.exampleJson());
        assertTrue(example.get("values") instanceof List<?>);
        assertEquals(Boolean.TRUE, example.get("lastPage"));

        String md = AgentMarkdown.renderSchemaJson(
                "{\"class\":\"" + Page.class.getName() + "\",\"schema\":" + res.schemaJson()
                        + ",\"example\":" + res.exampleJson() + "}");
        assertTrue(md.contains("# Schema `"));
        assertTrue(md.contains("### JSON Schema"));
        assertTrue(md.contains("### Example"));
    }

    @Test
    public void extractsValidationConstraintsOpaqueTypesAndExcludesStaticTransient() {
        SchemaResult res = DtoSchemaInspector.inspect(ConstrainedDto.class, ConstrainedDto.class, 2, false);
        assertNull(res.exampleJson());
        Map<String, Object> schema = JsonParser.parseObject(res.schemaJson());

        @SuppressWarnings("unchecked")
        List<String> req = (List<String>) schema.get("required");
        assertNotNull(req);
        assertTrue(req.contains("slug"));
        assertTrue(req.contains("title"));

        @SuppressWarnings("unchecked")
        Map<String, Object> props = (Map<String, Object>) schema.get("properties");
        @SuppressWarnings("unchecked")
        Map<String, Object> slug = (Map<String, Object>) props.get("slug");
        assertEquals(2L, slug.get("minLength"));
        assertEquals(40L, slug.get("maxLength"));
        assertEquals("^[a-z0-9-]+$", slug.get("pattern"));

        @SuppressWarnings("unchecked")
        Map<String, Object> title = (Map<String, Object>) props.get("title");
        assertEquals(1L, title.get("minLength"));

        @SuppressWarnings("unchecked")
        Map<String, Object> count = (Map<String, Object>) props.get("count");
        assertEquals(1L, count.get("minimum"));
        assertEquals(500L, count.get("maximum"));

        @SuppressWarnings("unchecked")
        Map<String, Object> payload = (Map<String, Object>) props.get("payload");
        assertEquals("byte", payload.get("format"));

        @SuppressWarnings("unchecked")
        Map<String, Object> reqIf = (Map<String, Object>) props.get("requestInterface");
        assertEquals("object", reqIf.get("type"));
        assertEquals(HttpServletRequest.class.getName(), reqIf.get("x-javaType"));

        assertTrue(props.containsKey("derived"));
        assertFalse(props.containsKey("transientIgnored"));
        assertFalse(props.containsKey("CONSTANT"));
    }

    @Test
    public void cyclicDtoUsesDefsAndRefWithoutStackOverflowAndRespectsDepthTruncation() {
        SchemaResult res = DtoSchemaInspector.inspect(Node.class, Node.class, 4, true);
        Map<String, Object> schema = JsonParser.parseObject(res.schemaJson());
        assertEquals("object", schema.get("type"));
        assertTrue(res.schemaJson().contains("\"$ref\":\"#/$defs/"));
        assertNotNull(schema.get("$defs"));
        assertNotNull(JsonParser.parseObject(res.exampleJson()).get("name"));

        SchemaResult shallow = DtoSchemaInspector.inspect(Node.class, Node.class, 1, false);
        assertTrue(shallow.truncated());
        assertTrue(shallow.schemaJson().contains("\"x-truncated\":true"));
    }

    @Test
    public void serializedFieldNameAndMarkdownRenderersWorkCleanly() throws Exception {
        assertNull(DtoSchemaInspector.serializedFieldName(null));
        Field f = ConstrainedDto.class.getDeclaredField("slug");
        assertNull(DtoSchemaInspector.serializedFieldName(f));

        String errMd = AgentMarkdown.renderErrorJson("{\"error\":\"class-not-found\",\"hint\":\"Try search\",\"suggestions\":[\"a.B\"]}");
        assertTrue(errMd.contains("**Error**: `class-not-found`"));
        assertTrue(errMd.contains("**Hint**: Try search"));
        assertTrue(errMd.contains("- `a.B`"));

        String srcMd = AgentMarkdown.renderSourceJson(
                "{\"class\":\"a.Foo\",\"scope\":\"class\",\"decompiler\":\"Vineflower\",\"startLine\":1,\"endLine\":2,\"totalLines\":2,\"lineNumbers\":true,\"source\":\" 1 | class Foo {\\n 2 | }\"}");
        assertTrue(srcMd.contains("# a.Foo"));
        assertTrue(srcMd.contains(" 1 | class Foo {"));
        assertFalse(srcMd.contains(" 1 |  1 |"));
    }
}

@Retention(RetentionPolicy.RUNTIME)
@interface NotNull {
}

@Retention(RetentionPolicy.RUNTIME)
@interface NotBlank {
}

@Retention(RetentionPolicy.RUNTIME)
@interface Size {
    int min() default 0;
    int max() default Integer.MAX_VALUE;
}

@Retention(RetentionPolicy.RUNTIME)
@interface Min {
    long value();
}

@Retention(RetentionPolicy.RUNTIME)
@interface Max {
    long value();
}

@Retention(RetentionPolicy.RUNTIME)
@interface Pattern {
    String regexp();
}
