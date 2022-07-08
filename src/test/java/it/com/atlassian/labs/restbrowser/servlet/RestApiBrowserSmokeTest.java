package it.com.atlassian.labs.restbrowser.servlet;

import com.atlassian.pageobjects.TestedProduct;
import com.atlassian.webdriver.pageobjects.WebDriverTester;
import it.com.atlassian.labs.restbrowser.servlet.pageobject.RestApiBrowserPage;
import org.junit.Test;

import static it.com.atlassian.labs.restbrowser.servlet.product.TestedProductFinder.getTestedProduct;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * A smoke test of the main Rest API Browser page.
 */
public class RestApiBrowserSmokeTest {

    private static final TestedProduct<WebDriverTester> TESTED_PRODUCT = getTestedProduct();

    @Test
    public void publicOnlyCheckboxShouldBeToggleable() {
        final RestApiBrowserPage restApiBrowserPage = TESTED_PRODUCT.visit(RestApiBrowserPage.class);
        assertTrue(restApiBrowserPage.isPublicOnly());
        restApiBrowserPage.togglePublicOnly();
        assertFalse(restApiBrowserPage.isPublicOnly());
    }
}
