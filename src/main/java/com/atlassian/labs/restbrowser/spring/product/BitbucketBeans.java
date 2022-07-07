package com.atlassian.labs.restbrowser.spring.product;

import com.atlassian.labs.restbrowser.provider.SoapServiceProvider;
import com.atlassian.plugins.osgi.javaconfig.conditions.product.BitbucketOnly;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;

import java.util.Collections;

@Configuration
@Conditional(BitbucketOnly.class)
public class BitbucketBeans {

    @Bean
    public SoapServiceProvider bitbucketSoapServiceProvider() {
        return Collections::emptySet;
    }
}
