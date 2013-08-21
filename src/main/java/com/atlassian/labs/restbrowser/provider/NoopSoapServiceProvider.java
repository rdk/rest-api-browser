package com.atlassian.labs.restbrowser.provider;

import com.atlassian.labs.restbrowser.plugin.SoapService;
import com.google.common.collect.Lists;

/**
 * Returns an empty list for products that haven't implemented SOAP (or
 * that we just haven't gotten to yet).
 */
public class NoopSoapServiceProvider implements SoapServiceProvider {

    @Override
    public Iterable<? extends SoapService> getSoapServices() {
        return Lists.newArrayList();
    }
}
