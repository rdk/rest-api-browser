package io.swagger.v3.oas.annotations.media;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

@Retention(RetentionPolicy.RUNTIME)
public @interface ArraySchema {
    Schema schema() default @Schema;
    Schema arraySchema() default @Schema;
}
