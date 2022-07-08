package it.com.atlassian.labs.restbrowser.servlet.product;

import com.atlassian.pageobjects.TestedProduct;
import com.atlassian.pageobjects.TestedProductFactory;
import com.atlassian.webdriver.pageobjects.WebDriverTester;

import javax.annotation.Nonnull;

/**
 * Utility methods relating to the {@link TestedProduct} class.
 */
public final class TestedProductUtils {

    private TestedProductUtils() {}

    /**
     * Returns the product under test.
     *
     * @return the product
     */
    @Nonnull
    public static TestedProduct<WebDriverTester> getTestedProduct() {
        final TestableProduct testableProduct = TestableProduct.findById(System.getProperty("product"));
        return TestedProductFactory.create(testableProduct.getTestedProductClass());
    }
}
