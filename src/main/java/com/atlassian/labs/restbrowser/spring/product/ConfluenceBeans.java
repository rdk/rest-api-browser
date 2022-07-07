package com.atlassian.labs.restbrowser.spring.product;

import com.atlassian.labs.restbrowser.provider.ConfluenceSoapServiceProvider;
import com.atlassian.labs.restbrowser.provider.SoapServiceProvider;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.plugins.osgi.javaconfig.conditions.product.ConfluenceOnly;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;

@Configuration
@Conditional(ConfluenceOnly.class)
public class ConfluenceBeans {

    @Bean
    public SoapServiceProvider confluenceSoapServiceProvider(final PluginAccessor pluginAccessor) {
        return new ConfluenceSoapServiceProvider(pluginAccessor);
    }
}
