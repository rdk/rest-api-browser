package com.atlassian.labs.restbrowser.provider;

import com.atlassian.labs.restbrowser.plugin.AbstractSoapService;
import com.atlassian.labs.restbrowser.plugin.SoapService;
import com.atlassian.jira.plugin.rpc.SoapModuleDescriptor;
import com.atlassian.plugin.PluginAccessor;
import com.google.common.base.Function;
import com.google.common.collect.Collections2;

import java.util.Collection;

/**
 * Provides {@link SoapService}s for JIRA.
 */
public class Jira6SoapServiceProvider implements SoapServiceProvider {

    private final PluginAccessor pluginAccessor;

    public Jira6SoapServiceProvider(PluginAccessor pluginAccessor) {
        this.pluginAccessor = pluginAccessor;
    }

    @Override
    public Iterable<? extends SoapService> getSoapServices() {
        Collection<SoapModuleDescriptor> soapModuleDescriptors =
                pluginAccessor.getEnabledModuleDescriptorsByClass(SoapModuleDescriptor.class);

        return Collections2.transform(soapModuleDescriptors, transformFunction);
    }

    private final Function<SoapModuleDescriptor, JiraSoapService> transformFunction =
            new Function<SoapModuleDescriptor, JiraSoapService>() {
                @Override
                public JiraSoapService apply(SoapModuleDescriptor moduleDescriptor) {
                    if (moduleDescriptor == null) return null;
                    return new JiraSoapService(moduleDescriptor);
                }
            };

    private final class JiraSoapService extends AbstractSoapService<SoapModuleDescriptor> {

        public JiraSoapService(SoapModuleDescriptor moduleDescriptor) {
            this.moduleDescriptor = moduleDescriptor;
        }

        @Override
        public String getServicePath() {
            return moduleDescriptor.getServicePath();
        }

        @Override
        public Class<?> getPublishedInterface() {
            return moduleDescriptor.getPublishedInterface();
        }

    }

}