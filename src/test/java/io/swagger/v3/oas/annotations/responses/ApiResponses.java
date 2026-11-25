package io.swagger.v3.oas.annotations.responses;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

@Retention(RetentionPolicy.RUNTIME)
public @interface ApiResponses {
    ApiResponse[] value() default {};
}
