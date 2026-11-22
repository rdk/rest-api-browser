package com.atlassian.labs.restbrowser.spring;

import com.atlassian.labs.restbrowser.util.TextUtils;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class LocalBeans {

    // Velocity templates require this instance, because they can't call static methods
    @Bean
    @SuppressWarnings("squid:S2440")
    public TextUtils textUtils() {
        //noinspection InstantiationOfUtilityClass
        return new TextUtils();
    }
}
