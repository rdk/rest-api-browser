package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.jaxrs.ReflectiveBridge;
import com.atlassian.plugin.ModuleDescriptor;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.plugin.PluginInformation;
import org.slf4j.Logger;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

import static java.util.Objects.requireNonNull;
import static org.slf4j.LoggerFactory.getLogger;

/**
 * Finds the enabled REST modules of every plugin.
 */
public class ModuleDiscovery {

    private static final Logger LOGGER = getLogger(ModuleDiscovery.class);

    static final String REST_V1_DESCRIPTOR = "com.atlassian.plugins.rest.module.RestServletFilterModuleDescriptor";
    static final String REST_V2_DESCRIPTOR = "com.atlassian.plugins.rest.v2.descriptor.RestServletFilterModuleDescriptor";

    /**
     * A REST module as discovered. Holds its descriptor, so it lives only while the catalog is built and must never
     * be stored in the catalog.
     *
     * @param path the module's path below /rest, for example "api/2" (no leading slash)
     */
    public record RestModule(String id, String path, String basePath, String version, boolean restV2,
                             String pluginKey, String pluginName, String pluginVersion, String description,
                             Plugin plugin, ModuleDescriptor<?> descriptor) {
    }

    private final PluginAccessor pluginAccessor;

    public ModuleDiscovery(PluginAccessor pluginAccessor) {
        this.pluginAccessor = requireNonNull(pluginAccessor);
    }

    @SuppressWarnings("deprecation")
    public List<RestModule> discover() {
        List<RestModule> modules = new ArrayList<>();
        for (ModuleDescriptor<?> md : pluginAccessor.getEnabledModuleDescriptorsByClass(ModuleDescriptor.class)) {
            String type = md.getClass().getName();
            if (!REST_V1_DESCRIPTOR.equals(type) && !REST_V2_DESCRIPTOR.equals(type)) {
                continue;
            }
            try {
                Object rawBase = ReflectiveBridge.call(md, "getBasePath");
                String basePath = rawBase == null ? "" : String.valueOf(rawBase);
                Object rawVer = ReflectiveBridge.call(md, "getVersion");
                String version = rawVer == null ? null : String.valueOf(rawVer);
                Plugin plugin = md.getPlugin();
                PluginInformation info = plugin == null ? null : plugin.getPluginInformation();
                String pluginKey = plugin == null ? "" : plugin.getKey();
                String pluginName = plugin == null ? "" : plugin.getName();
                String pluginVer = info == null ? null : info.getVersion();
                modules.add(new RestModule(md.getCompleteKey(), path(basePath, version), basePath, version,
                        REST_V2_DESCRIPTOR.equals(type), pluginKey, pluginName,
                        pluginVer, md.getDescription(), plugin, md));
            } catch (Exception | LinkageError e) {
                LOGGER.debug("Couldn't read REST module {}", md.getCompleteKey(), e);
            }
        }
        modules.sort(Comparator.comparing(RestModule::path).thenComparing(RestModule::id));
        return modules;
    }

    static String path(String basePath, String version) {
        String p = basePath == null ? "" : basePath.replaceAll("^/+|/+$", "");
        String v = version == null ? "" : version.replaceAll("^/+|/+$", "");
        if ("none".equals(v) || v.isEmpty()) {
            return p;
        }
        return p.isEmpty() ? v : p + "/" + v;
    }
}
