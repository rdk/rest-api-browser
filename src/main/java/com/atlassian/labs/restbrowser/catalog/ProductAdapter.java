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
import java.util.Locale;
import java.util.Properties;
import java.util.function.Supplier;
import java.util.regex.Pattern;

import static org.slf4j.LoggerFactory.getLogger;

/**
 * Product-specific REST module rules loaded once from {@code /catalog/stability.properties}.
 */
public class ProductAdapter {

    private static final Logger LOGGER = getLogger(ProductAdapter.class);
    private static final Properties STABILITY_PROPS = loadProperties();

    private final String productId;
    private final List<Pattern> supported;
    private final List<Pattern> excluded;
    private final Supplier<PluginMetadataManager> metadata;
    private volatile boolean metadataUnavailable;

    public ProductAdapter(ApplicationProperties applicationProperties, Supplier<PluginMetadataManager> metadata) {
        this(platformId(applicationProperties), metadata);
    }

    ProductAdapter(String productId, Supplier<PluginMetadataManager> metadata) {
        this.productId = productId;
        this.supported = rules(productId);
        this.excluded = rules("excluded");
        this.metadata = metadata;
    }

    public String productId() {
        return productId;
    }

    public String origin(Plugin plugin) {
        if (plugin == null) {
            return "bundled";
        }
        PluginMetadataManager pmm = metadataOrNull();
        if (pmm != null) {
            try {
                if (pmm.isUserInstalled(plugin)) {
                    return "user";
                }
                return pmm.isSystemProvided(plugin) ? "product" : "bundled";
            } catch (RuntimeException | LinkageError e) {
                metadataUnavailable = true;
                LOGGER.debug("PluginMetadataManager is not available; using the plugins' own flags", e);
            }
        }
        if (!plugin.isBundledPlugin()) {
            return "user";
        }
        return plugin.isSystemPlugin() ? "product" : "bundled";
    }

    public boolean excluded(RestModule module) {
        for (Pattern p : excluded) {
            if (p.matcher(module.path()).find()) {
                return true;
            }
        }
        return false;
    }

    public String stability(RestModule module, String origin) {
        for (Pattern p : supported) {
            if (p.matcher(module.path()).find()) {
                return "supported";
            }
        }
        return "user".equals(origin) ? "app" : "internal";
    }

    private PluginMetadataManager metadataOrNull() {
        if (metadataUnavailable) {
            return null;
        }
        try {
            return metadata == null ? null : metadata.get();
        } catch (RuntimeException | LinkageError e) {
            metadataUnavailable = true;
            return null;
        }
    }

    private static String platformId(ApplicationProperties applicationProperties) {
        if (applicationProperties == null) {
            return "";
        }
        try {
            String id = applicationProperties.getPlatformId();
            if (id != null && !id.isBlank()) {
                return id;
            }
        } catch (RuntimeException | LinkageError ignored) {
            // fallback to displayName
        }
        try {
            String name = applicationProperties.getDisplayName();
            return name == null ? "" : name.toLowerCase(Locale.ROOT);
        } catch (RuntimeException | LinkageError ignored) {
            return "";
        }
    }

    private static Properties loadProperties() {
        Properties p = new Properties();
        try (InputStream in = ProductAdapter.class.getResourceAsStream("/catalog/stability.properties")) {
            if (in != null) {
                p.load(in);
            }
        } catch (IOException e) {
            LOGGER.warn("Couldn't read /catalog/stability.properties", e);
        }
        return p;
    }

    static List<Pattern> rules(String productId) {
        List<Pattern> patterns = new ArrayList<>();
        String value = STABILITY_PROPS.getProperty(productId == null ? "" : productId, "");
        for (String rule : value.split(",")) {
            if (!rule.isBlank()) {
                patterns.add(Pattern.compile(rule.trim()));
            }
        }
        return patterns;
    }
}
