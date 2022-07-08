package it.com.atlassian.labs.restbrowser.servlet.product;

import com.atlassian.pageobjects.TestedProduct;
import com.atlassian.webdriver.pageobjects.WebDriverTester;
import com.atlassian.webdriver.refapp.RefappTestedProduct;

import javax.annotation.Nonnull;
import javax.annotation.ParametersAreNonnullByDefault;

import static java.lang.String.format;
import static java.util.Arrays.stream;
import static java.util.Objects.requireNonNull;

@ParametersAreNonnullByDefault
public enum TestableProduct {

    REFAPP("refapp", RefappTestedProduct.class);

    /**
     * Returns the product with the given ID.
     *
     * @param productId the AMPS product ID
     * @return the product
     * @throws IllegalArgumentException if the ID is invalid
     */
    public static TestableProduct findById(final String productId) {
        return stream(values())
                .filter(p -> p.id.equals(productId))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException(format("Invalid productId '%s'", productId)));
    }

    private final String id;
    private final Class<? extends TestedProduct<WebDriverTester>> testedProductClass;

    TestableProduct(final String id, final Class<? extends TestedProduct<WebDriverTester>> testedProductClass) {
        this.id = requireNonNull(id);
        this.testedProductClass = requireNonNull(testedProductClass);
    }

    @Nonnull
    public Class<? extends TestedProduct<WebDriverTester>> getTestedProductClass() {
        return testedProductClass;
    }
}
