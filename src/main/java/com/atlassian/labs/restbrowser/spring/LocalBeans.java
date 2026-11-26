package com.atlassian.labs.restbrowser.spring;

import com.atlassian.event.api.EventPublisher;
import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.JerseyModelSource;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery;
import com.atlassian.labs.restbrowser.catalog.OperationDetails;
import com.atlassian.labs.restbrowser.catalog.OperationSource;
import com.atlassian.labs.restbrowser.catalog.ProductAdapter;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.plugin.PluginInformation;
import com.atlassian.plugin.metadata.PluginMetadataManager;
import com.atlassian.plugin.servlet.ServletModuleManager;
import com.atlassian.sal.api.ApplicationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.List;

@Configuration
public class LocalBeans {

    public static final String PLUGIN_KEY = "com.atlassian.labs.rest-api-browser";

    public static String pluginVersion(PluginAccessor pluginAccessor) {
        if (pluginAccessor == null) {
            return "";
        }
        try {
            Plugin own = pluginAccessor.getPlugin(PLUGIN_KEY);
            PluginInformation info = own == null ? null : own.getPluginInformation();
            String version = info == null ? null : info.getVersion();
            return version == null ? "" : version.trim();
        } catch (RuntimeException | LinkageError e) {
            return "";
        }
    }

    @Bean
    public ServletContextHolder servletContextHolder() {
        return new ServletContextHolder();
    }

    @Bean
    public ModuleDiscovery moduleDiscovery(PluginAccessor pluginAccessor) {
        return new ModuleDiscovery(pluginAccessor);
    }

    @Bean
    public ProductAdapter productAdapter(ApplicationProperties applicationProperties,
                                         PluginMetadataManager pluginMetadataManager) {
        return new ProductAdapter(applicationProperties, () -> pluginMetadataManager);
    }

    @Bean
    public JerseyModelSource jerseyModelSource(ServletModuleManager servletModuleManager,
                                               ServletContextHolder servletContextHolder) {
        return new JerseyModelSource(() -> servletModuleManager, servletContextHolder::get);
    }

    @Bean
    public CatalogService catalogService(ModuleDiscovery discovery, JerseyModelSource jersey,
                                         ProductAdapter productAdapter, EventPublisher eventPublisher,
                                         PluginAccessor pluginAccessor, ServletContextHolder servletContextHolder) {
        return new CatalogService(discovery, List.of(jersey), productAdapter, eventPublisher,
                () -> {
                    String ver = pluginVersion(pluginAccessor);
                    return ver.isEmpty() ? "unknown" : ver;
                },
                servletContextHolder);
    }

    @Bean
    public OperationDetails operationDetails(ModuleDiscovery discovery, JerseyModelSource jersey,
                                             ProductAdapter productAdapter) {
        return new OperationDetails(discovery, () -> jersey, productAdapter);
    }

    @Bean
    public OperationSource operationSource(ModuleDiscovery discovery, JerseyModelSource jersey,
                                           PluginAccessor pluginAccessor, ProductAdapter productAdapter) {
        return new OperationSource(discovery, () -> jersey, pluginAccessor, productAdapter);
    }
}
