package com.atlassian.labs.restbrowser.plugin;

import com.atlassian.plugin.ModuleDescriptor;
import com.atlassian.plugin.Plugin;

/**
 * Partial implementation that takes care of the
 * {@link com.atlassian.plugin.ModuleDescriptor}-specific parts.
 */
public abstract class AbstractSoapService<T extends ModuleDescriptor> implements SoapService {

    protected T moduleDescriptor;

    @Override
    public String getCompleteKey() {
        return moduleDescriptor.getCompleteKey();
    }

    @Override
    public String getDescription() {
        return moduleDescriptor.getDescription();
    }

    @Override
    public Plugin getPlugin() {
        return moduleDescriptor.getPlugin();
    }

    @Override
    public String getPluginKey() {
        return moduleDescriptor.getPluginKey();
    }
}
