package io.swagger.v3.oas.annotations;

import io.swagger.v3.oas.annotations.responses.ApiResponse;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

@Retention(RetentionPolicy.RUNTIME)
public @interface Operation {
    String summary() default "";
    String description() default "";
    boolean deprecated() default false;
    Parameter[] parameters() default {};
    ApiResponse[] responses() default {};
}
