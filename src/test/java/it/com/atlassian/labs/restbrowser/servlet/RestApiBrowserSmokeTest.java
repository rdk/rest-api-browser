package it.com.atlassian.labs.restbrowser.servlet;

import it.com.atlassian.labs.restbrowser.servlet.pageobject.RestApiBrowserPage;
import org.junit.Test;

import static it.com.atlassian.labs.restbrowser.servlet.product.TestedProductFinder.getTestedProduct;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * A smoke test of the main Rest API Browser page.
 */
public class RestApiBrowserSmokeTest {

    @Test
    public void publicOnlyCheckboxShouldBeToggleable() {
        final RestApiBrowserPage restApiBrowserPage = getTestedProduct().visit(RestApiBrowserPage.class);
        assertTrue(restApiBrowserPage.isPublicOnly());
        restApiBrowserPage.togglePublicOnly();
        assertFalse(restApiBrowserPage.isPublicOnly());
    }
}
