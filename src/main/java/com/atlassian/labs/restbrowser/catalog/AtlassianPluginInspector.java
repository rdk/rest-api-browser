package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.ModuleDiscovery.RestModule;
import com.atlassian.labs.restbrowser.inspect.osgi.OsgiBundleInspector;
import com.atlassian.labs.restbrowser.json.Json;
import com.atlassian.plugin.ModuleDescriptor;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.plugin.PluginDependencies;
import com.atlassian.plugin.PluginInformation;
import org.osgi.framework.Bundle;

import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.Date;
import java.util.Dictionary;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

/**
 * Single source of truth for inspecting Atlassian plugins, module descriptors, and their owning OSGi bundles.
 * Shared by {@link OperationDetails} and {@link OperationSource} so metadata and null-guards never drift.
 */
final class AtlassianPluginInspector {

    static final int MAX_MODULES = 300;

    private AtlassianPluginInspector() {
    }

    static Plugin pluginForBundle(PluginAccessor pluginAccessor, Bundle b) {
        if (pluginAccessor == null || b == null) {
            return null;
        }
        try {
            Dictionary<String, String> headers = OsgiBundleInspector.rawHeaders(b);
            String key = headers == null ? null : headers.get("Atlassian-Plugin-Key");
            if (key != null && !key.isBlank()) {
                Plugin p = pluginAccessor.getPlugin(key.trim());
                if (p != null) {
                    return p;
                }
            }
            String sym = b.getSymbolicName();
            if (sym != null && !sym.isBlank()) {
                Plugin p = pluginAccessor.getPlugin(sym);
                if (p != null) {
                    return p;
                }
            }
        } catch (RuntimeException | LinkageError ignored) {
            // best effort
        }
        return null;
    }

    static void writePluginFull(Json j, Plugin p, ProductAdapter product) {
        writePluginBase(j, p, product, true);
    }

    static void writePluginSummary(Json j, Plugin p, ProductAdapter product) {
        writePluginBase(j, p, product, false);
    }

    private static void writePluginBase(Json j, Plugin p, ProductAdapter product, boolean includeModuleList) {
        if (p == null) {
            j.value((String) null);
            return;
        }
        PluginInformation info = p.getPluginInformation();
        j.beginObject()
                .field("key", p.getKey())
                .field("name", p.getName())
                .optional("version", info == null ? null : info.getVersion())
                .optional("vendor", info == null ? null : info.getVendorName())
                .optional("vendorUrl", info == null ? null : info.getVendorUrl());
        if (includeModuleList) {
            j.optional("description", info == null ? null : OsgiBundleInspector.clip(info.getDescription()));
        }
        j.optional("origin", product == null ? null : product.origin(p))
                .field("state", String.valueOf(p.getPluginState()))
                .field("pluginsVersion", p.getPluginsVersion())
                .optional("artifact", p.getPluginArtifact() == null ? null : p.getPluginArtifact().getName())
                .optional("installed", iso(p.getDateInstalled()))
                .optional("loaded", iso(p.getDateLoaded()))
                .optional("enabled", iso(p.getDateEnabled()));

        if (includeModuleList) {
            Set<String> mandatory = new TreeSet<>();
            Set<String> optional = new TreeSet<>();
            try {
                PluginDependencies deps = p.getDependencies();
                if (deps != null) {
                    mandatory.addAll(deps.getMandatory());
                    optional.addAll(deps.getOptional());
                    optional.addAll(deps.getDynamic());
                }
            } catch (RuntimeException | LinkageError ignored) {
                // older plugin types
            }
            optional.removeAll(mandatory);
            j.strings("dependsOn", mandatory).strings("optionallyDependsOn", optional);

            Collection<ModuleDescriptor<?>> rawMods = p.getModuleDescriptors();
            List<ModuleDescriptor<?>> modules = new ArrayList<>();
            if (rawMods != null) {
                for (ModuleDescriptor<?> md : rawMods) {
                    if (md != null) {
                        modules.add(md);
                    }
                }
            }
            if (!modules.isEmpty()) {
                modules.sort(Comparator.comparing(ModuleDescriptor::getKey, Comparator.nullsFirst(Comparator.naturalOrder())));
            }
            j.field("moduleCount", modules.size()).name("modules").beginArray();
            for (ModuleDescriptor<?> md : modules.subList(0, Math.min(modules.size(), MAX_MODULES))) {
                j.beginObject()
                        .field("key", md.getKey())
                        .field("type", moduleType(md))
                        .optional("name", md.getName())
                        .field("enabled", md.isEnabled())
                        .endObject();
            }
            j.endArray();
        } else {
            Collection<ModuleDescriptor<?>> mods = p.getModuleDescriptors();
            j.field("moduleCount", mods == null ? 0 : mods.size());
        }
        j.endObject();
    }

    static void writeStandalonePluginInspection(Json j, Plugin p, ProductAdapter product, long startNanos) {
        PluginInformation info = p.getPluginInformation();
        j.beginObject()
                .field("format", 1)
                .field("key", p.getKey())
                .field("name", p.getName())
                .optional("version", info == null ? null : info.getVersion())
                .optional("vendor", info == null ? null : info.getVendorName())
                .optional("vendorUrl", info == null ? null : info.getVendorUrl())
                .optional("description", info == null ? null : OsgiBundleInspector.clip(info.getDescription()))
                .optional("origin", product == null ? null : product.origin(p))
                .field("state", String.valueOf(p.getPluginState()))
                .field("pluginsVersion", p.getPluginsVersion())
                .optional("artifact", p.getPluginArtifact() == null ? null : p.getPluginArtifact().getName())
                .optional("installed", iso(p.getDateInstalled()))
                .optional("loaded", iso(p.getDateLoaded()))
                .optional("enabled", iso(p.getDateEnabled()));
        Set<String> mandatory = new TreeSet<>();
        Set<String> optional = new TreeSet<>();
        try {
            PluginDependencies deps = p.getDependencies();
            if (deps != null) {
                mandatory.addAll(deps.getMandatory());
                optional.addAll(deps.getOptional());
                optional.addAll(deps.getDynamic());
            }
        } catch (RuntimeException | LinkageError ignored) {
            // older plugin types
        }
        optional.removeAll(mandatory);
        j.strings("dependsOn", mandatory).strings("optionallyDependsOn", optional);
        Collection<ModuleDescriptor<?>> mods = p.getModuleDescriptors();
        int totalMods = mods == null ? 0 : mods.size();
        int enabledMods = 0;
        if (mods != null) {
            for (ModuleDescriptor<?> md : mods) {
                if (md != null && md.isEnabled()) {
                    enabledMods++;
                }
            }
        }
        j.field("moduleCount", totalMods).field("enabledModuleCount", enabledMods);
        Bundle b = OsgiBundleInspector.bundleForPluginKey(p.getKey(), p.getKey());
        if (b != null) {
            j.name("bundle");
            OsgiBundleInspector.writeBundleSummary(j, b, null);
        }
        long inspectMs = Math.max(1L, (System.nanoTime() - startNanos) / 1_000_000L);
        j.field("inspectMs", inspectMs).endObject();
    }

    static void writeRestModule(Json j, RestModule m) {
        j.beginObject()
                .field("key", m.id())
                .field("path", m.path())
                .field("basePath", m.basePath())
                .field("version", m.version())
                .field("rest", m.restV2() ? "REST v2 (Jersey 2)" : "REST v1 (Jersey 1)")
                .optional("description", OsgiBundleInspector.clip(m.description()))
                .optional("descriptor", m.descriptor() == null ? null : m.descriptor().getClass().getName())
                .endObject();
    }

    static String moduleType(ModuleDescriptor<?> md) {
        String name = md.getClass().getSimpleName();
        return name.endsWith("ModuleDescriptor") && name.length() > "ModuleDescriptor".length()
                ? name.substring(0, name.length() - "ModuleDescriptor".length()) : name;
    }

    static String iso(Date d) {
        return d == null ? null : DateTimeFormatter.ISO_INSTANT.format(d.toInstant());
    }
}
