package com.atlassian.labs.restbrowser.spring;

import com.atlassian.labs.restbrowser.spring.product.BambooBeans;
import com.atlassian.labs.restbrowser.spring.product.BitbucketBeans;
import com.atlassian.labs.restbrowser.spring.product.ConfluenceBeans;
import com.atlassian.labs.restbrowser.spring.product.CrowdBeans;
import com.atlassian.labs.restbrowser.spring.product.FecruBeans;
import com.atlassian.labs.restbrowser.spring.product.JiraBeans;
import com.atlassian.labs.restbrowser.spring.product.RefappBeans;
import com.atlassian.labs.restbrowser.util.TextUtils;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;

@Configuration
@Import({
        BambooBeans.class,
        BitbucketBeans.class,
        ConfluenceBeans.class,
        CrowdBeans.class,
        FecruBeans.class,
        JiraBeans.class,
        RefappBeans.class
})
public class LocalBeans {

    // Velocity templates require this instance, because they can't call static methods
    @Bean
    @SuppressWarnings("squid:S2440")
    public TextUtils textUtils() {
        //noinspection InstantiationOfUtilityClass
        return new TextUtils();
    }
}
