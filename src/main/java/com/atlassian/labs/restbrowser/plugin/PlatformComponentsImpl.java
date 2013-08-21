package com.atlassian.labs.restbrowser.plugin;

import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.plugin.util.PluginFrameworkUtils;
import com.google.common.collect.Maps;
import org.osgi.framework.BundleContext;
import org.osgi.framework.ServiceReference;
import org.osgi.service.packageadmin.ExportedPackage;
import org.osgi.service.packageadmin.PackageAdmin;

import java.util.Map;

/**
 * Default implementation of {@code PlatformComponents}.
 */
public class PlatformComponentsImpl implements PlatformComponents {

    private final PluginAccessor pluginAccessor;
    private final BundleContext bundleContext;

    public PlatformComponentsImpl(final PluginAccessor pluginAccessor, final BundleContext bundleContext) {
        this.pluginAccessor = pluginAccessor;
        this.bundleContext = bundleContext;
    }

    @Override
    public Map<String, String> getPlatformComponents() {
        Map<String, String> components = Maps.newTreeMap();

        pluginsVersion(components);
        salVersion(components);
        restVersion(components);
        upmVersion(components);
        auiVersion(components);
        atrVersion(components);
        aoVersion(components);
        speakeasyVersion(components);
        gadgetsVersion(components);
        applinksVersion(components);
        
        return components;
    }
    
    private void pluginsVersion(Map<String, String> container) {
        container.put("Atlassian Plugins", PluginFrameworkUtils.getPluginFrameworkVersion());
    }

    private void salVersion(Map<String, String> container) {
        // load the system bundle by referencing a class that can only come from it
        ServiceReference adminSvcRef = bundleContext.getServiceReference(PackageAdmin.class.getName());
        PackageAdmin admin = (PackageAdmin) bundleContext.getService(adminSvcRef);
        ExportedPackage sal = admin.getExportedPackage("com.atlassian.sal.api");
        if (sal != null) {      
            container.put("Shared Application Layer (SAL)", sal.getVersion().toString());
        }
    }

    private void restVersion(Map<String, String> container) {
        Plugin plugin = pluginAccessor.getPlugin("com.atlassian.plugins.rest.atlassian-rest-module");
        if (plugin != null) {
            container.put("Atlassian REST", plugin.getPluginInformation().getVersion());
        }
    }

    private void upmVersion(Map<String, String> container) {
        Plugin plugin = pluginAccessor.getPlugin("com.atlassian.upm.atlassian-universal-plugin-manager-plugin");
        if (plugin != null) {
            container.put("Universal Plugin Manager", plugin.getPluginInformation().getVersion());
        }
    }

    private void auiVersion(Map<String, String> container) {
        Plugin plugin = pluginAccessor.getPlugin("com.atlassian.auiplugin");
        if (plugin != null) {
            container.put("Atlassian User Interface (AUI)", plugin.getPluginInformation().getVersion());
        }
    }

    private void atrVersion(Map<String, String> container) {
        Plugin plugin = pluginAccessor.getPlugin("com.atlassian.templaterenderer.api");
        if (plugin != null) {
            container.put("Atlassian Template Renderer", plugin.getPluginInformation().getVersion());
        }
    }

    private void aoVersion(Map<String, String> container) {
        Plugin plugin = pluginAccessor.getPlugin("com.atlassian.activeobjects.activeobjects-plugin");
        if (plugin != null) {
            container.put("Active Objects", plugin.getPluginInformation().getVersion());
        }
    }

    private void speakeasyVersion(Map<String, String> container) {
        Plugin plugin = pluginAccessor.getPlugin("com.atlassian.labs.speakeasy-plugin");
        if (plugin != null) {
            container.put("Speakeasy", plugin.getPluginInformation().getVersion());
        }
    }

    private void gadgetsVersion(Map<String, String> container) {
        Plugin plugin = pluginAccessor.getPlugin("com.atlassian.gadgets.dashboard");
        if (plugin != null) {
            container.put("Atlassian Gadgets", plugin.getPluginInformation().getVersion());
        }
    }

    private void applinksVersion(Map<String, String> container) {
        Plugin plugin = pluginAccessor.getPlugin("com.atlassian.applinks.applinks-plugin");
        if (plugin != null) {
            container.put("Application Links", plugin.getPluginInformation().getVersion());
        }
    }
}
