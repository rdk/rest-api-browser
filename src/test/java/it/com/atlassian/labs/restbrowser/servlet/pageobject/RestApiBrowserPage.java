package it.com.atlassian.labs.restbrowser.servlet.pageobject;

import com.atlassian.pageobjects.Page;
import com.atlassian.pageobjects.elements.ElementBy;
import com.atlassian.pageobjects.elements.PageElement;

/**
 * Page objects for the main REST API Browser page.
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

    public void togglePublicOnly() {
        publicOnlyCheckbox.click();
    }

    public boolean isPublicOnly() {
        return publicOnlyCheckbox.isSelected();
    }
}
