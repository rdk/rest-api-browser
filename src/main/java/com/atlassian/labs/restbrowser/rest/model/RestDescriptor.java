package com.atlassian.labs.restbrowser.rest.model;

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

    public String getBasePath() { return basePath; }
    public String getRestPath() { return restPath; }
    public String getDisplayPath() { return displayPath; }
    public String getPluginCompleteKey() { return pluginCompleteKey; }
    public String getPluginDescription() { return pluginDescription; }
    public String getPluginKey() { return pluginKey; }
    public String getPluginName() { return pluginName; }
    public String getVersion() { return version; }

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
            this.pluginName = pluginName == null ? "" : pluginName.replace("\"", "");
            return this;
        }

        public Builder pluginDescription(String pluginDescription) {
            this.pluginDescription = pluginDescription == null ? "" : pluginDescription.replace("\"", "");
            return this;
        }

        public RestDescriptor build() {
            String bp = stripSlashes(this.basePath);
            String ver = stripSlashes(this.version);
            String normalized = bp;
            if (!ver.isEmpty() && !"none".equals(ver)) {
                normalized = normalized.isEmpty() ? ver : normalized + "/" + ver;
            }
            this.displayPath = normalized;
            this.restPath = normalized.isEmpty() ? "" : "/" + normalized;
            return new RestDescriptor(this);
        }

        private static String stripSlashes(String value) {
            if (value == null || value.isEmpty()) {
                return "";
            }
            int start = 0;
            int end = value.length();
            while (start < end && value.charAt(start) == '/') {
                start++;
            }
            while (end > start && value.charAt(end - 1) == '/') {
                end--;
            }
            return value.substring(start, end);
        }
    }
}
