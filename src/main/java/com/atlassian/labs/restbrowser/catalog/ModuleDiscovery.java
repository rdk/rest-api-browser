package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.plugin.ModuleDescriptor;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import org.slf4j.Logger;

import java.lang.reflect.Method;
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

    @SuppressWarnings("deprecation") // the predicate variant is the one that sees descriptors of every type
    public List<RestModule> discover() {
        List<RestModule> modules = new ArrayList<>();
        for (ModuleDescriptor<?> md : pluginAccessor.getEnabledModuleDescriptorsByClass(ModuleDescriptor.class)) {
            String type = md.getClass().getName();
            if (!REST_V1_DESCRIPTOR.equals(type) && !REST_V2_DESCRIPTOR.equals(type)) {
                continue;
            }
            try {
                // the descriptors' packages are not exported, so their getters are reached by reflection
                String basePath = (String) call(md, "getBasePath");
                String version = String.valueOf(call(md, "getVersion"));
                Plugin plugin = md.getPlugin();
                modules.add(new RestModule(md.getCompleteKey(), path(basePath, version), basePath, version,
                        REST_V2_DESCRIPTOR.equals(type), plugin.getKey(), plugin.getName(),
                        plugin.getPluginInformation().getVersion(), md.getDescription(), plugin, md));
            } catch (Exception | LinkageError e) {
                LOGGER.debug("Couldn't read REST module {}", md.getCompleteKey(), e);
            }
        }
        modules.sort(Comparator.comparing(RestModule::path).thenComparing(RestModule::id));
        return modules;
    }

    static String path(String basePath, String version) {
        String p = basePath.replaceAll("^/+|/+$", "");
        if ("none".equals(version) || version == null || version.isEmpty()) {
            return p;
        }
        return p.isEmpty() ? version : p + "/" + version;
    }

    private static Object call(Object target, String method) throws ReflectiveOperationException {
        Method m = target.getClass().getMethod(method);
        return m.invoke(target);
    }
}
