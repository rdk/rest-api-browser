package io.swagger.v3.oas.annotations.responses;

import io.swagger.v3.oas.annotations.media.Content;

import java.lang.annotation.Repeatable;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

@Retention(RetentionPolicy.RUNTIME)
@Repeatable(ApiResponses.class)
public @interface ApiResponse {
    String description() default "";
    String responseCode() default "default";
    Content[] content() default {};
}
