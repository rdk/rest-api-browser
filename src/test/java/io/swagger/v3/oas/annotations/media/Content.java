package io.swagger.v3.oas.annotations.media;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

@Retention(RetentionPolicy.RUNTIME)
public @interface Content {
    String mediaType() default "";
    Schema schema() default @Schema;
    ArraySchema array() default @ArraySchema;
}
