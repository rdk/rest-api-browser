package com.atlassian.labs.restbrowser.spring.product;

import com.atlassian.labs.restbrowser.provider.SoapServiceProvider;
import com.atlassian.plugins.osgi.javaconfig.conditions.product.BambooOnly;
import com.atlassian.plugins.osgi.javaconfig.conditions.product.JiraOnly;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;

import java.util.Collections;

@Configuration
@Conditional(JiraOnly.class)
public class JiraBeans {

    @Bean
    public SoapServiceProvider jiraSoapServiceProvider() {
        return Collections::emptySet;
    }
}
