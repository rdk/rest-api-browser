package io.swagger.v3.oas.annotations;

import io.swagger.v3.oas.annotations.enums.ParameterIn;

import java.lang.annotation.Repeatable;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

@Retention(RetentionPolicy.RUNTIME)
@Repeatable(Parameters.class)
public @interface Parameter {
    String name() default "";
    ParameterIn in() default ParameterIn.DEFAULT;
    String description() default "";
    boolean required() default false;
}
