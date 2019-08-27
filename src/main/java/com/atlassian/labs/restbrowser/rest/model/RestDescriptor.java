package com.atlassian.labs.restbrowser.rest.model;

import com.atlassian.labs.restbrowser.util.TextUtils;
import com.atlassian.plugins.rest.module.ApiVersion;

public class RestDescriptor {
    private final String basePath;
    private final String restPath;
    private final String displayPath;
    private final String version;
    private final String pluginCompleteKey;
    private final String pluginKey;
    private final String pluginName;
    private final String pluginDescription;

    public RestDescriptor(Builder builder) {
        this.basePath = builder.basePath;
        this.restPath = builder.restPath;
        this.displayPath = builder.displayPath;
        this.version = builder.version;
        this.pluginCompleteKey = builder.pluginCompleteKey;
        this.pluginKey = builder.pluginKey;
        this.pluginName = builder.pluginName;
        this.pluginDescription = builder.pluginDescription;
    }

    public String getBasePath() {
        return basePath;
    }

    public String getRestPath() { return restPath; }

    public String getDisplayPath() { return displayPath; }

    public String getPluginCompleteKey() {
        return pluginCompleteKey;
    }

    public String getPluginDescription() {
        return pluginDescription;
    }

    public String getPluginKey() {
        return pluginKey;
    }

    public String getPluginName() {
        return pluginName;
    }

    public String getVersion() {
        return version;
    }

    @Override
    public String toString() {
        return "RestDescriptor{" +
            "basePath='" + basePath + '\'' +
            ", restPath='" + restPath + '\'' +
            ", displayPath='" + displayPath + '\'' +
            ", version='" + version + '\'' +
            ", pluginCompleteKey='" + pluginCompleteKey + '\'' +
            ", pluginKey='" + pluginKey + '\'' +
            ", pluginName='" + pluginName + '\'' +
            ", pluginDescription='" + pluginDescription + '\'' +
            '}';
    }

    public static class Builder {
        private String basePath;
        private String restPath;
        private String displayPath;
        private String version;
        private String pluginCompleteKey;
        private String pluginKey;
        private String pluginName;
        private String pluginDescription;

        public Builder basePath(String basePath) {
            this.basePath = basePath;
            return this;
        }

        public Builder version(String version) {
            this.version = version;
            return this;
        }

        public Builder pluginCompleteKey(String pluginCompleteKey) {
            this.pluginCompleteKey = pluginCompleteKey;
            return this;
        }

        public Builder pluginKey(String pluginKey) {
            this.pluginKey = pluginKey;
            return this;
        }

        public Builder pluginName(String pluginName) {
            if (pluginName == null) {
                this.pluginName = "";
            } else {
                this.pluginName = pluginName.replaceAll("\"", "");
            }
            return this;
        }

        public Builder pluginDescription(String pluginDescription) {
            if (pluginDescription == null) {
                this.pluginDescription = "";
            } else {
                this.pluginDescription = pluginDescription.replaceAll("\"", "");
            }
            return this;
        }

        public RestDescriptor build() {
            this.restPath = TextUtils.htmlEncode(this.basePath);
            if(!"none".equals(this.version)) {
                this.restPath += "/" + TextUtils.htmlEncode(this.version);
            }
            this.displayPath = this.restPath.substring(1);
            return new RestDescriptor(this);
        }
    }
}