package com.atlassian.labs.restbrowser.spring;

import com.atlassian.event.api.EventPublisher;
import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.JerseyModelSource;
import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery;
import com.atlassian.labs.restbrowser.catalog.ProductAdapter;
import com.atlassian.labs.restbrowser.util.TextUtils;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.plugin.metadata.PluginMetadataManager;
import com.atlassian.plugin.servlet.ServletModuleManager;
import com.atlassian.sal.api.ApplicationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

@Configuration
public class LocalBeans {

    static final String PLUGIN_KEY = "com.atlassian.labs.rest-api-browser";

    // Velocity templates require this instance, because they can't call static methods
    @Bean
    @SuppressWarnings("squid:S2440")
    public TextUtils textUtils() {
        //noinspection InstantiationOfUtilityClass
        return new TextUtils();
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
    public CatalogService catalogService(ModuleDiscovery discovery, ProductAdapter productAdapter,
                                         EventPublisher eventPublisher, PluginAccessor pluginAccessor,
                                         ServletModuleManager servletModuleManager) {
        // the source needs the catalog's ServletContext, the catalog needs the source: tie the knot by reference
        AtomicReference<CatalogService> self = new AtomicReference<>();
        JerseyModelSource jersey = new JerseyModelSource(() -> servletModuleManager,
                () -> self.get() == null ? null : self.get().servletContext());
        CatalogService service = new CatalogService(discovery, List.of(jersey), productAdapter, eventPublisher,
                () -> {
                    Plugin own = pluginAccessor.getPlugin(PLUGIN_KEY);
                    return own == null ? "unknown" : own.getPluginInformation().getVersion();
                });
        self.set(service);
        return service;
    }
}
