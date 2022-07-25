package com.atlassian.labs.restbrowser.spring.product;

import com.atlassian.labs.restbrowser.provider.SoapServiceProvider;
import com.atlassian.plugins.osgi.javaconfig.conditions.product.BambooOnly;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;

import java.util.Collections;

@Configuration
@Conditional(BambooOnly.class)
public class BambooBeans {

    @Bean
    public SoapServiceProvider bambooSoapServiceProvider() {
        return Collections::emptySet;
    }
}
