package com.atlassian.plugins.rest.api.multipart;

import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;

@Retention(RetentionPolicy.RUNTIME)
public @interface MultipartFormParam {
    String value();
}
