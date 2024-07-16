package com.atlassian.labs.restbrowser.spring;

import com.atlassian.plugin.PluginAccessor;
import com.atlassian.plugin.web.WebInterfaceManager;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.auth.LoginUriProvider;
import com.atlassian.sal.api.user.UserManager;
import com.atlassian.templaterenderer.TemplateRenderer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import static com.atlassian.plugins.osgi.javaconfig.OsgiServices.importOsgiService;

@Configuration
public class ImportedPlatformServices {

    @Bean
    public ApplicationProperties applicationProperties() {
        return importOsgiService(ApplicationProperties.class);
    }

    @Bean
    public LoginUriProvider loginUriProvider() {
        return importOsgiService(LoginUriProvider.class);
    }

    @Bean
    public PluginAccessor pluginAccessor() {
        return importOsgiService(PluginAccessor.class);
    }

    @Bean
    public UserManager userManager() {
        return importOsgiService(UserManager.class);
    }

    @Bean
    public TemplateRenderer velocityTemplateRenderer() {
        return importOsgiService(TemplateRenderer.class);
    }

    @Bean
    public WebInterfaceManager webInterfaceManager() {
        return importOsgiService(WebInterfaceManager.class);
    }
}
