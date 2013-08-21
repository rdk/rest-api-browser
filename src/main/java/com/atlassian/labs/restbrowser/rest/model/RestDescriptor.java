package com.atlassian.labs.restbrowser.rest.model;

public class RestDescriptor {
    private final String basePath;
    private final String version;
    private final String pluginCompleteKey;
    private final String pluginKey;
    private final String pluginName;
    private final String pluginDescription;

    public RestDescriptor(Builder builder) {
        this.basePath = builder.basePath;
        this.version = builder.version;
        this.pluginCompleteKey = builder.pluginCompleteKey;
        this.pluginKey = builder.pluginKey;
        this.pluginName = builder.pluginName;
        this.pluginDescription = builder.pluginDescription;
    }

    public String getBasePath() {
        return basePath;
    }

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

    public static class Builder {
        private String basePath;
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
            return new RestDescriptor(this);
        }
    }
}