package com.atlassian.labs.restbrowser.spring.product;

import com.atlassian.labs.restbrowser.provider.SoapServiceProvider;
import com.atlassian.plugins.osgi.javaconfig.conditions.product.FecruOnly;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;

import java.util.Collections;

@Configuration
@Conditional(FecruOnly.class)
public class FecruBeans {

    @Bean
    public SoapServiceProvider fecruSoapServiceProvider() {
        return Collections::emptySet;
    }
}
