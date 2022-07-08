package it.com.atlassian.labs.restbrowser.servlet.product;

import com.atlassian.pageobjects.TestedProduct;
import com.atlassian.pageobjects.TestedProductFactory;
import com.atlassian.webdriver.pageobjects.WebDriverTester;
import com.atlassian.webdriver.refapp.RefappTestedProduct;

import javax.annotation.Nonnull;
import java.util.HashMap;
import java.util.Map;

import static java.lang.String.format;
import static org.apache.commons.lang3.StringUtils.isBlank;

/**
 * Identifies the {@link TestedProduct} class.
 */
public final class TestedProductFinder {

    private static final Map<String, Class<? extends TestedProduct<WebDriverTester>>> TESTABLE_PRODUCTS;

    private static final String PRODUCT_SYSTEM_PROPERTY = "product";

    static {
        TESTABLE_PRODUCTS = new HashMap<>();
        // To support running the integration tests in other products, add them here
        TESTABLE_PRODUCTS.put("refapp", RefappTestedProduct.class);
    }

    private TestedProductFinder() {}

    /**
     * Returns the product under test.
     *
     * @return the product
     */
    @Nonnull
    public static TestedProduct<WebDriverTester> getTestedProduct() {
        final String product = System.getProperty(PRODUCT_SYSTEM_PROPERTY);
        if (isBlank(product)) {
            throw new IllegalStateException(format("System property %s must be set", PRODUCT_SYSTEM_PROPERTY));
        }
        final Class<? extends TestedProduct<WebDriverTester>> testedProductClass = TESTABLE_PRODUCTS.get(product);
        if (testedProductClass == null) {
            throw new UnsupportedOperationException(
                    format("Cannot determine TestedProduct class for product = '%s'", product));
        }
        return TestedProductFactory.create(testedProductClass);
    }
}
