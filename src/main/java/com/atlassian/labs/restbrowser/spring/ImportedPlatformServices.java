package com.atlassian.labs.restbrowser.spring;

import com.atlassian.event.api.EventPublisher;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.plugin.metadata.PluginMetadataManager;
import com.atlassian.plugin.servlet.ServletModuleManager;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.auth.LoginUriProvider;
import com.atlassian.sal.api.user.UserManager;
import com.atlassian.templaterenderer.TemplateRenderer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;

import static com.atlassian.plugins.osgi.javaconfig.ImportOptions.defaultOptions;
import static com.atlassian.plugins.osgi.javaconfig.OsgiServices.importOsgiService;

@Configuration
public class ImportedPlatformServices {

    @Bean
    public ApplicationProperties applicationProperties() {
        return importOsgiService(ApplicationProperties.class);
    }

    @Bean
    public EventPublisher eventPublisher() {
        return importOsgiService(EventPublisher.class);
    }

    @Bean
    public LoginUriProvider loginUriProvider() {
        return importOsgiService(LoginUriProvider.class);
    }

    @Bean
    public PluginAccessor pluginAccessor() {
        return importOsgiService(PluginAccessor.class);
    }

    /** Optional: not every product exports it; the catalog then falls back to the plugin's own flags. */
    @Bean
    public PluginMetadataManager pluginMetadataManager() {
        return importOsgiService(PluginMetadataManager.class,
                defaultOptions().optional_DANGEROUS_ReadTheJavadocs().withTimeout(Duration.ofSeconds(1)));
    }

    @Bean
    public ServletModuleManager servletModuleManager() {
        return importOsgiService(ServletModuleManager.class);
    }

    @Bean
    public UserManager userManager() {
        return importOsgiService(UserManager.class);
    }

    @Bean
    public TemplateRenderer velocityTemplateRenderer() {
        return importOsgiService(TemplateRenderer.class);
    }
}
