package com.atlassian.labs.restbrowser.plugin;

import com.atlassian.plugin.Plugin;

/**
 * Simple interface that provides the bits of a {@link com.atlassian.plugin.ModuleDescriptor}
 * we care about in this application.
 */
public interface SoapService {

    /**
     * Wrapper for {@link com.atlassian.plugin.ModuleDescriptor#getPluginKey()}.
     * @return the plugin key
     */
    public String getPluginKey();

    /**
     * Wrapper for {@link com.atlassian.plugin.ModuleDescriptor#getCompleteKey()}.
     * @return the complete plugin key
     */
    public String getCompleteKey();

    /**
     * Wrapper for {@link com.atlassian.plugin.ModuleDescriptor#getDescription()}.
     * @return the SOAP module description
     */
    public String getDescription();

    /**
     * Wrapper for {@link com.atlassian.plugin.ModuleDescriptor#getPlugin()}.
     * @return the host plugin of this SOAP {@code ModuleDescriptor}
     */
    public Plugin getPlugin();

    /**
     * Returns the SOAP service path.
     * @return the SOAP service path
     */
    public String getServicePath();

    /**
     * Returns the interface under which the SOAP service is published by the product.
     * @return the published {@link Class}
     */
    public Class<?> getPublishedInterface();
}
