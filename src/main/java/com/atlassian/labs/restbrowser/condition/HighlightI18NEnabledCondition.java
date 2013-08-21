package com.atlassian.labs.restbrowser.condition;

import com.atlassian.plugin.PluginParseException;
import com.atlassian.plugin.web.Condition;
import com.atlassian.sal.api.ApplicationProperties;

import java.util.Map;

public class HighlightI18NEnabledCondition implements Condition {

    private ApplicationProperties applicationProperties;
    private Map<String, String> params;

    public HighlightI18NEnabledCondition(ApplicationProperties applicationProperties) {
        this.applicationProperties = applicationProperties;
    }

    @Override
    public void init(Map<String, String> params) throws PluginParseException {
        this.params = params;
    }

    @Override
    public boolean shouldDisplay(Map<String, Object> context) {
        return isI18nTranslationAvailable();
    }

    private boolean isI18nTranslationAvailable() {
        return getAppName().equals("jira") || getAppName().equals("confluence");
    }

    private String getAppName() {
        return applicationProperties.getDisplayName().toLowerCase();
    }
}
