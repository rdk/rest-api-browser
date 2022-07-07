package com.atlassian.labs.restbrowser.provider;

import com.atlassian.confluence.plugin.descriptor.rpc.SoapModuleDescriptor;
import com.atlassian.labs.restbrowser.plugin.AbstractSoapService;
import com.atlassian.labs.restbrowser.plugin.SoapService;
import com.atlassian.plugin.PluginAccessor;

import static java.util.Objects.requireNonNull;
import static java.util.stream.Collectors.toList;

/**
 * Provides {@link SoapService}s for Confluence.
 */
public class ConfluenceSoapServiceProvider implements SoapServiceProvider {

    private final PluginAccessor pluginAccessor;

    public ConfluenceSoapServiceProvider(final PluginAccessor pluginAccessor) {
        this.pluginAccessor = requireNonNull(pluginAccessor);
    }

    @Override
    public Iterable<? extends SoapService> getSoapServices() {
        return pluginAccessor.getEnabledModuleDescriptorsByClass(SoapModuleDescriptor.class).stream()
                .map(ConfluenceSoapService::getInstance)
                .collect(toList());
    }

    private static final class ConfluenceSoapService extends AbstractSoapService<SoapModuleDescriptor> {

        private static ConfluenceSoapService getInstance(final SoapModuleDescriptor soapModuleDescriptor) {
            if (soapModuleDescriptor == null) {
                return null;
            }
            return new ConfluenceSoapService(soapModuleDescriptor);
        }

        private ConfluenceSoapService(final SoapModuleDescriptor moduleDescriptor) {
            this.moduleDescriptor = requireNonNull(moduleDescriptor);
        }

        @Override
        public String getServicePath() {
            return moduleDescriptor.getServicePath();
        }

        @Override
        public Class<?> getPublishedInterface() {
            try {
                return moduleDescriptor.getPublishedInterface();
            } catch (final ClassNotFoundException e) {
                throw new RuntimeException("Couldn't get published interface from Confluence " +
                        "SOAP module descriptor", e);
            }
        }
    }
}
