package com.atlassian.labs.restbrowser.rest.model;

import com.google.common.collect.Lists;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Model class for passing JSON-RPC method information to the Velocity renderer.
 */
public class JsonRpcMethod {

    private final String name;
    private final List<Parameter> params;

    public JsonRpcMethod(Builder builder) {
        this.name = builder.name;
        this.params = Collections.unmodifiableList(builder.params);
    }

    public String getName() {
        return name;
    }

    public List<Parameter> getParams() {
        return params;
    }

    public static class Parameter {
        private final String name;
        private final String xmlnsType;

        public Parameter(String name, String xmlnsType) {
            this.name = name;
            this.xmlnsType = xmlnsType;
        }

        public String getName() {
            return name;
        }

        public String getXmlnsType() {
            return xmlnsType;
        }
    }

    public static class Builder {
        private String name;
        private ArrayList<Parameter> params;

        public Builder name(String name) {
            this.name = name;
            params = Lists.newArrayList();
            return this;
        }

        public Builder addParameter(String name, String xmlnsType) {
            params.add(new Parameter(name, xmlnsType));
            return this;
        }

        public JsonRpcMethod build() {
            return new JsonRpcMethod(this);
        }
    }

}
