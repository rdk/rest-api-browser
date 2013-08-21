package com.atlassian.labs.restbrowser.condition;

import com.atlassian.plugin.PluginParseException;
import com.atlassian.plugin.web.Condition;

import java.util.Map;

public class DevModeCondition implements Condition {

    @Override
    public void init(Map<String, String> stringStringMap) throws PluginParseException {
    }

    @Override
    public boolean shouldDisplay(Map<String, Object> stringObjectMap) {
        return "true".equals(System.getProperty("atlassian.dev.mode")) ||
               "true".equals(System.getProperty("devtoolbar.enable"));
    }
}
