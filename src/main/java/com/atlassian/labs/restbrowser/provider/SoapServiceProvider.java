package com.atlassian.labs.restbrowser.provider;

import com.atlassian.labs.restbrowser.plugin.SoapService;

/**
 * Supplies the application-specific SOAP module descriptors.
 */
public interface SoapServiceProvider {

    /**
     * Returns an {@code Iterable} of {@code SoapService} representing
     * the available SOAP services in the product.
     * @return an {@code Iterable} of {@code SoapService}
     */
    Iterable<? extends SoapService> getSoapServices();

}
