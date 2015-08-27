package com.atlassian.labs.restbrowser.provider;

import com.atlassian.jira.util.BuildUtilsInfo;
import com.atlassian.labs.restbrowser.plugin.SoapService;
import com.atlassian.plugin.PluginAccessor;
import com.google.common.collect.Lists;
import org.springframework.beans.factory.FactoryBean;

/**
 * Provides {@link SoapService}s for JIRA.
 */
public class JiraSoapServiceProviderFactory implements FactoryBean
{
    private final BuildUtilsInfo buildUtilsInfo;
    private final PluginAccessor pluginAccessor;

    public JiraSoapServiceProviderFactory(final BuildUtilsInfo buildUtilsInfo, final PluginAccessor pluginAccessor)
    {
        this.buildUtilsInfo = buildUtilsInfo;
        this.pluginAccessor = pluginAccessor;
    }

    @Override
    public SoapServiceProvider getObject() throws Exception
    {
        final int[] versionNumbers = buildUtilsInfo.getVersionNumbers();
        if (versionNumbers != null)
        {
            final int majorVersion = versionNumbers[0];
            // JIRA without SOAP, hurray!
            if (majorVersion >= 7)
            {
                return new NoopSoapServiceProvider();
            }
            else
            {
                return new Jira6SoapServiceProvider(pluginAccessor);
            }
        }
        else
        {
            return new NoopSoapServiceProvider();
        }
    }

    @Override
    public Class<?> getObjectType()
    {
        return SoapServiceProvider.class;
    }

    @Override
    public boolean isSingleton()
    {
        return true;
    }

    private static class NoopSoapServiceProvider implements SoapServiceProvider
    {
        @Override
        public Iterable<? extends SoapService> getSoapServices()
        {
            return Lists.newArrayList();
        }
    }
}
