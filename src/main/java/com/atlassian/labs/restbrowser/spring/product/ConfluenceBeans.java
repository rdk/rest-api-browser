package com.atlassian.labs.restbrowser.spring.product;

import com.atlassian.labs.restbrowser.provider.SoapServiceProvider;
import com.atlassian.plugins.osgi.javaconfig.conditions.product.ConfluenceOnly;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;

import java.util.Collections;

@Configuration
@Conditional(ConfluenceOnly.class)
public class ConfluenceBeans {

    /**
     * None: Confluence 10, the first on Platform 8, removed the SOAP API and its module type (SoapModuleDescriptor).
     */
    @Bean
    public SoapServiceProvider confluenceSoapServiceProvider() {
        return Collections::emptySet;
    }
}
