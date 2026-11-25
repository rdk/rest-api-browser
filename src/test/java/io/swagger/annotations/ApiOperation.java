package io.swagger.annotations;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

@Retention(RetentionPolicy.RUNTIME)
public @interface ApiOperation {
    String value() default "";
    String notes() default "";
}
