package com.atlassian.labs.restbrowser.provider;

import com.atlassian.confluence.plugin.descriptor.rpc.SoapModuleDescriptor;
import com.atlassian.labs.restbrowser.plugin.AbstractSoapService;
import com.atlassian.labs.restbrowser.plugin.SoapService;
import com.atlassian.plugin.PluginAccessor;
import com.google.common.base.Function;
import com.google.common.collect.Collections2;

import java.util.Collection;

/**
 * Provides {@link SoapService}s for Confluence.
 */
public class ConfluenceSoapServiceProvider implements SoapServiceProvider {

    private final PluginAccessor pluginAccessor;

    public ConfluenceSoapServiceProvider(PluginAccessor pluginAccessor) {
        this.pluginAccessor = pluginAccessor;
    }

    private final Function<SoapModuleDescriptor, ConfluenceSoapService> transformFunction =
            new Function<SoapModuleDescriptor, ConfluenceSoapService>() {
                @Override
                public ConfluenceSoapService apply(SoapModuleDescriptor soapModuleDescriptor) {
                    if (soapModuleDescriptor == null) return null;
                    return new ConfluenceSoapService(soapModuleDescriptor);
                }
            };


    @Override
    public Iterable<? extends SoapService> getSoapServices() {
        Collection<SoapModuleDescriptor> moduleDescriptors =
                pluginAccessor.getEnabledModuleDescriptorsByClass(SoapModuleDescriptor.class);

        return Collections2.transform(moduleDescriptors, transformFunction);
    }

    private final class ConfluenceSoapService extends AbstractSoapService<SoapModuleDescriptor> {

        private ConfluenceSoapService(SoapModuleDescriptor moduleDescriptor) {
            this.moduleDescriptor = moduleDescriptor;
        }

        @Override
        public String getServicePath() {
            return moduleDescriptor.getServicePath();
        }

        @Override
        public Class<?> getPublishedInterface() {
            Class<?> publishedInterface;
            try {
                publishedInterface = moduleDescriptor.getPublishedInterface();
            } catch (ClassNotFoundException cnfe) {
                throw new RuntimeException("Couldn't get published interface from Confluence " +
                        "SOAP module descriptor", cnfe);
            }
            return publishedInterface;
        }
    }

}
