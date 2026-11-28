package com.atlassian.labs.restbrowser.jaxrs;

import com.atlassian.labs.restbrowser.jaxrs.OpenApiAnnotationExtractor.OpDoc;
import io.swagger.annotations.ApiOperation;
import io.swagger.annotations.ApiParam;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.Parameters;
import io.swagger.v3.oas.annotations.enums.ParameterIn;
import io.swagger.v3.oas.annotations.media.ArraySchema;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import org.junit.Test;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.reflect.Method;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Direct unit tests for {@link OpenApiAnnotationExtractor}.
 */
public class OpenApiAnnotationExtractorTest {

    public static class ItemDto {
        public String id;
    }

    public static class AltDto {
        public int count;
    }

    public static class ErrorDto {
        public String message;
    }

    public enum StatusType {
        SUCCESS,
        CLIENT_ERROR
    }

    @Retention(RetentionPolicy.RUNTIME)
    @interface ResponseType {
        Class<?> value();
        StatusType statusType() default StatusType.SUCCESS;
        Class<?>[] genericTypes() default {};
    }

    @Retention(RetentionPolicy.RUNTIME)
    @interface ResponseTypes {
        ResponseType[] value();
    }

    public interface DefResource {
        @Operation(summary = "Summary only", description = "Summary only")
        void partial();

        @ApiOperation(value = "Swagger sum", notes = "Swagger notes", response = ItemDto.class, responseContainer = "list")
        void swaggerList();
    }

    @Parameter(name = "sharedKey", in = ParameterIn.PATH, description = "Class path doc")
    public static class ImplResource {
        @Operation(description = "Impl description", deprecated = true)
        public void partial() {}

        @Operation(responses = {
                @ApiResponse(responseCode = "404", content = @Content(schema = @Schema(implementation = ErrorDto.class))),
                @ApiResponse(responseCode = "201", content = @Content(schema = @Schema(implementation = ItemDto.class)))
        })
        public void oas2xx() {}

        @ApiResponse(responseCode = "default", content = @Content(array = @ArraySchema(schema = @Schema(implementation = AltDto.class))))
        public void oasArrayDefault() {}

        @ApiResponse(responseCode = "200", content = @Content(schema = @Schema(oneOf = {Void.class, AltDto.class})))
        public void oasOneOf() {}

        @ResponseTypes({
                @ResponseType(value = ErrorDto.class, statusType = StatusType.CLIENT_ERROR),
                @ResponseType(value = java.util.List.class, statusType = StatusType.SUCCESS, genericTypes = {ItemDto.class})
        })
        public void atlassianSuccessPreferred() {}

        @ApiOperation(value = "Set", response = ItemDto.class, responseContainer = "set")
        public void swaggerSet() {}

        @ApiOperation(value = "Map", response = AltDto.class, responseContainer = "map")
        public void swaggerMap() {}

        @Operation(parameters = @Parameter(name = "expand", in = ParameterIn.QUERY, description = "Expand fields"))
        @Parameters(@Parameter(name = "limit", in = ParameterIn.QUERY, description = "Max items"))
        public void paramsOp(
                @Parameter(description = "Filter text") String filter,
                @ApiParam("Swagger page") int start) {}
    }

    @Test
    public void opDocMergesDefinitionAndHandlingAndDeduplicatesEqualDescription() throws Exception {
        Method def = DefResource.class.getMethod("partial");
        Method impl = ImplResource.class.getMethod("partial");

        OpDoc doc = OpenApiAnnotationExtractor.opDoc(def, impl);
        assertEquals("Summary only", doc.summary());
        assertEquals("Impl description", doc.description());
        assertTrue(doc.deprecated());

        OpDoc sameDef = OpenApiAnnotationExtractor.opDoc(def, null);
        assertEquals("Summary only", sameDef.summary());
        assertNull(sameDef.description());
        assertFalse(sameDef.deprecated());

        Method sw = DefResource.class.getMethod("swaggerList");
        OpDoc swDoc = OpenApiAnnotationExtractor.opDoc(sw, null);
        assertEquals("Swagger sum", swDoc.summary());
        assertEquals("Swagger notes", swDoc.description());
        assertFalse(swDoc.deprecated());
    }

    @Test
    public void annotatedReturnJavaTypeCoversOasAtlassianAndSwaggerVariants() throws Exception {
        assertEquals(ItemDto.class.getName(), OpenApiAnnotationExtractor.annotatedReturnJavaType(
                ImplResource.class.getMethod("oas2xx"), null));
        assertEquals(AltDto.class.getName() + "[]", OpenApiAnnotationExtractor.annotatedReturnJavaType(
                null, ImplResource.class.getMethod("oasArrayDefault")));
        assertEquals(AltDto.class.getName(), OpenApiAnnotationExtractor.annotatedReturnJavaType(
                ImplResource.class.getMethod("oasOneOf"), null));
        assertEquals("java.util.List<" + ItemDto.class.getName() + ">",
                OpenApiAnnotationExtractor.annotatedReturnJavaType(
                        ImplResource.class.getMethod("atlassianSuccessPreferred"), null));
        assertEquals("java.util.List<" + ItemDto.class.getName() + ">",
                OpenApiAnnotationExtractor.annotatedReturnJavaType(
                        DefResource.class.getMethod("swaggerList"), null));
        assertEquals("java.util.Set<" + ItemDto.class.getName() + ">",
                OpenApiAnnotationExtractor.annotatedReturnJavaType(
                        ImplResource.class.getMethod("swaggerSet"), null));
        assertEquals("java.util.Map<java.lang.String, " + AltDto.class.getName() + ">",
                OpenApiAnnotationExtractor.annotatedReturnJavaType(
                        ImplResource.class.getMethod("swaggerMap"), null));
    }

    @Test
    public void paramDocsParamDocAndCleanDocWorkAcrossAnnotationsAndSurrogates() throws Exception {
        Method m = ImplResource.class.getMethod("paramsOp", String.class, int.class);
        Map<String, String> docs = OpenApiAnnotationExtractor.paramDocs(m, null);
        assertEquals("Expand fields", docs.get("query:expand"));
        assertEquals("Expand fields", docs.get(":expand"));
        assertEquals("Max items", docs.get("query:limit"));
        assertEquals("Class path doc", docs.get("path:sharedKey"));

        var anns = m.getParameterAnnotations();
        assertEquals("Filter text", OpenApiAnnotationExtractor.paramDoc(anns[0]));
        assertEquals("Swagger page", OpenApiAnnotationExtractor.paramDoc(anns[1]));
        assertNull(OpenApiAnnotationExtractor.paramDoc(null));

        assertNull(OpenApiAnnotationExtractor.cleanDoc(" \r\n ", 10));
        assertEquals("a\nb\nc", OpenApiAnnotationExtractor.cleanDoc("  a\r\nb\rc  ", 20));
        String surrogateSafe = OpenApiAnnotationExtractor.cleanDoc("hi\uD83D\uDE00tail", 3);
        assertEquals("hi…", surrogateSafe);
    }
}
