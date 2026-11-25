package com.atlassian.labs.restbrowser.catalog;

import java.util.List;

/**
 * The catalog's data. Only strings and other records: nothing here may refer to a class, method or plugin of another
 * app, or a disabled app's class loader would stay in memory.
 */
public final class Model {

    private Model() {
    }

    /** One parameter of an operation. {@code in} is path, query, header, matrix or form. */
    public record Param(String name, String in, String type, boolean required, String defaultValue,
                        List<String> options, boolean repeating, String description, String javaType) {
        public Param(String name, String in, String type, boolean required, String defaultValue,
                     List<String> options, boolean repeating) {
            this(name, in, type, required, defaultValue, options, repeating, null, null);
        }

        public Param(String name, String in, String type, boolean required, String defaultValue,
                     List<String> options, boolean repeating, String description) {
            this(name, in, type, required, defaultValue, options, repeating, description, null);
        }

        Param withDescription(String description) {
            return new Param(name, in, type, required, defaultValue, options, repeating, description, javaType);
        }
    }

    /** What a source says about one operation, before the catalog gives it a key. */
    public record OperationSpec(String method, String path, List<String> consumes, List<String> produces,
                                List<Param> params, String access, boolean deprecated, String bodyType,
                                String summary, String description, String bodyJavaType,
                                String returnType, String returnJavaType) {
        public OperationSpec(String method, String path, List<String> consumes, List<String> produces,
                             List<Param> params, String access, boolean deprecated, String bodyType) {
            this(method, path, consumes, produces, params, access, deprecated, bodyType, null, null, null, null, null);
        }

        public OperationSpec(String method, String path, List<String> consumes, List<String> produces,
                             List<Param> params, String access, boolean deprecated, String bodyType,
                             String summary, String description) {
            this(method, path, consumes, produces, params, access, deprecated, bodyType, summary, description, null, null, null);
        }
    }

    /** What a source says about one module. */
    public record ModuleSpec(String source, List<OperationSpec> operations) {
    }

    /** An operation in the catalog. */
    public record Operation(String key, String moduleId, OperationSpec spec) {
    }

    /** A module's state in the catalog. */
    public enum State { ok, pending, failed }

    /**
     * A module in the catalog.
     *
     * @param reason short, safe reason code when failed (shown to everyone)
     * @param error  details when failed (admins only)
     */
    public record ModuleEntry(String id, String path, String origin, String stability, String source, State state,
                              String reason, String error, int opCount, String pluginKey, String pluginName,
                              String pluginVersion) {
        ModuleEntry withSource(String source) {
            return new ModuleEntry(id, path, origin, stability, source, state, reason, error, opCount, pluginKey,
                    pluginName, pluginVersion);
        }
    }
}
