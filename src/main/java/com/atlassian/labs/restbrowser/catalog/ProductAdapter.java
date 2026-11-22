package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.metadata.PluginMetadataManager;
import com.atlassian.sal.api.ApplicationProperties;
import org.slf4j.Logger;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Properties;
import java.util.function.Supplier;
import java.util.regex.Pattern;

import static org.slf4j.LoggerFactory.getLogger;

/**
 * What differs between products: which REST modules are supported (data, in /catalog/stability.properties) and who
 * provides a plugin. New products get a line in the data file; product-specific code goes into a subclass only when
 * a product really needs it.
 */
public class ProductAdapter {

    private static final Logger LOGGER = getLogger(ProductAdapter.class);

    private final String productId;
    private final List<Pattern> supported;
    private final Supplier<PluginMetadataManager> metadata;

    public ProductAdapter(ApplicationProperties applicationProperties, Supplier<PluginMetadataManager> metadata) {
        this(platformId(applicationProperties), metadata);
    }

    ProductAdapter(String productId, Supplier<PluginMetadataManager> metadata) {
        this.productId = productId;
        this.supported = rules(productId);
        this.metadata = metadata;
    }

    public String productId() {
        return productId;
    }

    /** product (the product's own modules), bundled (shipped with the product), or user (installed by an admin). */
    public String origin(Plugin plugin) {
        PluginMetadataManager pmm = metadataOrNull();
        if (pmm != null) {
            try {
                if (pmm.isUserInstalled(plugin)) {
                    return "user";
                }
                return pmm.isSystemProvided(plugin) ? "product" : "bundled";
            } catch (RuntimeException e) {
                LOGGER.debug("PluginMetadataManager failed for {}", plugin.getKey(), e);
            }
        }
        if (!plugin.isBundledPlugin()) {
            return "user";
        }
        return plugin.isSystemPlugin() ? "product" : "bundled";
    }

    /** supported (the product's public API), app (from a user-installed app), or internal. */
    public String stability(RestModule module, String origin) {
        for (Pattern p : supported) {
            if (p.matcher(module.path()).find()) {
                return "supported";
            }
        }
        return "user".equals(origin) ? "app" : "internal";
    }

    private PluginMetadataManager metadataOrNull() {
        try {
            return metadata == null ? null : metadata.get();
        } catch (RuntimeException | LinkageError e) {
            return null; // the product does not export it
        }
    }

    private static String platformId(ApplicationProperties applicationProperties) {
        try {
            return applicationProperties.getPlatformId();
        } catch (RuntimeException | LinkageError e) {
            return applicationProperties.getDisplayName().toLowerCase();
        }
    }

    static List<Pattern> rules(String productId) {
        Properties p = new Properties();
        try (InputStream in = ProductAdapter.class.getResourceAsStream("/catalog/stability.properties")) {
            if (in != null) {
                p.load(in);
            }
        } catch (IOException e) {
            LOGGER.warn("Couldn't read /catalog/stability.properties", e);
        }
        List<Pattern> patterns = new ArrayList<>();
        String value = p.getProperty(productId == null ? "" : productId, "");
        for (String rule : value.split(",")) {
            if (!rule.isBlank()) {
                patterns.add(Pattern.compile(rule.trim()));
            }
        }
        return patterns;
    }
}
