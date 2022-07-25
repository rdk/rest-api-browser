package it.com.atlassian.labs.restbrowser.servlet.pageobject;

import com.atlassian.pageobjects.Page;
import com.atlassian.pageobjects.elements.ElementBy;
import com.atlassian.pageobjects.elements.PageElement;

/**
 * Page object for the main REST API Browser page.
 */
public class RestApiBrowserPage implements Page {

    @ElementBy(id = "searchField")
    private PageElement searchField;

    @ElementBy(id = "publicOnlyFilter")
    private PageElement publicOnlyCheckbox;

    @Override
    public String getUrl() {
        return "/plugins/servlet/restbrowser";
    }

    /**
     * Toggles the "public APIs only" checkbox.
     */
    public void togglePublicOnly() {
        publicOnlyCheckbox.click();
    }

    /**
     * Indicates whether the page is showing only public REST APIs.
     *
     * @return see description
     */
    public boolean isPublicOnly() {
        return publicOnlyCheckbox.isSelected();
    }
}
