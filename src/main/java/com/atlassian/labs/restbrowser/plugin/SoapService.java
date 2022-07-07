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
    String getPluginKey();

    /**
     * Wrapper for {@link com.atlassian.plugin.ModuleDescriptor#getCompleteKey()}.
     * @return the complete plugin key
     */
    String getCompleteKey();

    /**
     * Wrapper for {@link com.atlassian.plugin.ModuleDescriptor#getDescription()}.
     * @return the SOAP module description
     */
    String getDescription();

    /**
     * Wrapper for {@link com.atlassian.plugin.ModuleDescriptor#getPlugin()}.
     * @return the host plugin of this SOAP {@code ModuleDescriptor}
     */
    Plugin getPlugin();

    /**
     * Returns the SOAP service path.
     * @return the SOAP service path
     */
    String getServicePath();

    /**
     * Returns the interface under which the SOAP service is published by the product.
     * @return the published {@link Class}
     */
    Class<?> getPublishedInterface();
}
