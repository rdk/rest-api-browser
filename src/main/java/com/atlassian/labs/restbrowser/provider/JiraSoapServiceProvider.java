package com.atlassian.labs.restbrowser.provider;

import com.atlassian.labs.restbrowser.plugin.SoapService;

import java.util.ArrayList;

/**
 * Provides {@link SoapService}s for JIRA.
 */
public class JiraSoapServiceProvider implements SoapServiceProvider {


    @Override
    public Iterable<? extends SoapService> getSoapServices()
    {
        return new ArrayList<SoapService>();
    }
}
