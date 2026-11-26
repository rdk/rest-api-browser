package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.OperationSpec;
import com.atlassian.labs.restbrowser.catalog.Model.Param;
import com.atlassian.labs.restbrowser.json.Json;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * An immutable catalog: the modules, the serialized index, and their hash.
 * <p>
 * The hash covers the catalog format, this plugin's version, every module's shared fields and the index, all in a
 * fixed order. Every node with the same plugins therefore computes the same hash, and an upgrade of this plugin
 * always changes it.
 */
public final class CatalogSnapshot {

    public static final int FORMAT = 1;

    private final String hash;
    private final boolean complete;
    private final int done;
    private final int total;
    private final List<ModuleEntry> modules;
    private final Map<String, ModuleEntry> moduleIndex;
    private final List<Operation> operations;
    private final Map<String, Operation> operationIndex;
    private final String operationsJson;
    private final byte[] index;
    private final String adminTag;

    private CatalogSnapshot(String hash, boolean complete, int done, int total, List<ModuleEntry> modules,
                            Map<String, ModuleEntry> moduleIndex, List<Operation> operations,
                            Map<String, Operation> operationIndex, String operationsJson, byte[] index) {
        this.hash = hash;
        this.complete = complete;
        this.done = done;
        this.total = total;
        this.modules = modules;
        this.moduleIndex = moduleIndex;
        this.operations = operations;
        this.operationIndex = operationIndex;
        this.operationsJson = operationsJson;
        this.index = index;
        StringBuilder errors = new StringBuilder(hash);
        for (ModuleEntry m : modules) {
            if (m.error() != null) {
                errors.append('\n').append(m.id()).append('=').append(m.error());
            }
        }
        this.adminTag = hash + "-" + sha256(errors.toString()).substring(0, 8);
    }

    static CatalogSnapshot of(List<ModuleEntry> modules, List<Operation> operations, boolean complete, int done,
                              int total, String ownVersion) {
        List<Operation> sortedOps = new ArrayList<>(operations);
        sortedOps.sort(Comparator.comparing(Operation::key));
        return fromSortedOperations(modules, sortedOps, operationsJson(sortedOps), complete, done, total, ownVersion);
    }

    /**
     * Fast path for progressive catalog builds using pre-serialized per-operation JSON strings so incremental
     * snapshots do not re-serialize previously built modules repeatedly.
     */
    static CatalogSnapshot ofPreserialized(List<ModuleEntry> modules, List<Operation> sortedOps,
                                           List<String> sortedOpJson, boolean complete, int done, int total,
                                           String ownVersion) {
        StringBuilder arr = new StringBuilder(Math.max(16, sortedOpJson.size() * 192)).append('[');
        for (int i = 0; i < sortedOpJson.size(); i++) {
            if (i > 0) {
                arr.append(',');
            }
            arr.append(sortedOpJson.get(i));
        }
        arr.append(']');
        return fromSortedOperations(modules, sortedOps, arr.toString(), complete, done, total, ownVersion);
    }

    static CatalogSnapshot ofPreserialized(List<ModuleEntry> modules, List<String> sortedOpJson,
                                           boolean complete, int done, int total, String ownVersion) {
        return ofPreserialized(modules, List.of(), sortedOpJson, complete, done, total, ownVersion);
    }

    private static CatalogSnapshot fromSortedOperations(List<ModuleEntry> modules, List<Operation> sortedOps,
                                                      String operationsJson, boolean complete, int done, int total,
                                                      String ownVersion) {
        List<ModuleEntry> sortedModules = new ArrayList<>(modules);
        sortedModules.sort(Comparator.comparing(ModuleEntry::id));
        Map<String, ModuleEntry> byId = new HashMap<>(sortedModules.size() * 2);
        for (ModuleEntry m : sortedModules) {
            byId.put(m.id(), m);
        }
        Map<String, Operation> byOpKey = new HashMap<>(Math.max(16, sortedOps.size() * 2));
        for (Operation op : sortedOps) {
            byOpKey.put(op.key(), op);
        }
        String hash = computeHash(sortedModules, operationsJson, complete, ownVersion);
        String index = "{\"format\":" + FORMAT + ",\"hash\":\"" + hash + "\",\"operations\":" + operationsJson + "}";
        return new CatalogSnapshot(hash, complete, done, total, List.copyOf(sortedModules), Map.copyOf(byId),
                List.copyOf(sortedOps), Map.copyOf(byOpKey), operationsJson, index.getBytes(StandardCharsets.UTF_8));
    }

    private static String computeHash(List<ModuleEntry> sortedModules, String operationsJson,
                                      boolean complete, String ownVersion) {
        StringBuilder hashInput = new StringBuilder(operationsJson.length() + sortedModules.size() * 96 + 64)
                .append("format=").append(FORMAT).append('\n')
                .append("plugin=").append(ownVersion).append('\n')
                .append("complete=").append(complete).append('\n');
        for (ModuleEntry m : sortedModules) {
            hashInput.append(String.join("|", m.id(), m.path(), m.origin(), m.stability(), String.valueOf(m.source()),
                    m.state().name(), String.valueOf(m.reason()), String.valueOf(m.opCount()), m.pluginKey(),
                    String.valueOf(m.pluginName()), String.valueOf(m.pluginVersion()))).append('\n');
        }
        hashInput.append(operationsJson);
        return sha256(hashInput.toString()).substring(0, 24);
    }

    /**
     * Marks this catalog incomplete (e.g. when a manual refresh starts) without re-sorting or re-serializing any
     * operations. Safe to run under {@code synchronized (stalePlugins)}.
     */
    CatalogSnapshot incomplete(String ownVersion) {
        if (!complete) {
            return this;
        }
        String newHash = computeHash(modules, operationsJson, false, ownVersion);
        String newIndex = "{\"format\":" + FORMAT + ",\"hash\":\"" + newHash + "\",\"operations\":" + operationsJson + "}";
        return new CatalogSnapshot(newHash, false, done, total, modules, moduleIndex, operations, operationIndex,
                operationsJson, newIndex.getBytes(StandardCharsets.UTF_8));
    }

    public String adminTag() {
        return adminTag;
    }

    public String hash() {
        return hash;
    }

    public boolean complete() {
        return complete;
    }

    public int done() {
        return done;
    }

    public int total() {
        return total;
    }

    /** O(1) lookup of the module with this id. */
    public Optional<ModuleEntry> module(String id) {
        return id == null ? Optional.empty() : Optional.ofNullable(moduleIndex.get(id));
    }

    public List<ModuleEntry> modules() {
        return modules;
    }

    public List<Operation> operations() {
        return operations;
    }

    /** O(1) lookup of an operation by key. */
    public Optional<Operation> operation(String key) {
        return key == null ? Optional.empty() : Optional.ofNullable(operationIndex.get(key));
    }

    /** The index document, UTF-8 JSON, the same for every user. */
    public byte[] index() {
        return index.clone();
    }

    /** Writes the index document without copying it. */
    public void writeIndex(java.io.OutputStream out) throws java.io.IOException {
        out.write(index);
    }

    public int indexLength() {
        return index.length;
    }

    public String summary(String productName, String productVersion, String productBuild, String baseUrl,
                          boolean admin) {
        return summary(productName, productVersion, productBuild, baseUrl, admin, false);
    }

    public String summary(String productName, String productVersion, String productBuild, String baseUrl,
                          boolean admin, boolean sysadmin) {
        Json j = new Json().beginObject()
                .field("format", FORMAT)
                .name("product").beginObject()
                .field("name", productName).field("version", productVersion).field("build", productBuild)
                .endObject()
                .field("baseUrl", baseUrl)
                .field("hash", hash)
                .field("complete", complete)
                .name("progress").beginObject().field("done", done).field("total", total).endObject()
                .field("admin", admin)
                .field("sysadmin", sysadmin)
                .name("modules").beginArray();
        for (ModuleEntry m : modules) {
            j.beginObject()
                    .field("id", m.id()).field("path", m.path()).field("origin", m.origin())
                    .field("stability", m.stability()).optional("source", m.source())
                    .field("state", m.state().name()).optional("reason", m.reason())
                    .field("opCount", m.opCount())
                    .name("plugin").beginObject().field("key", m.pluginKey()).field("name", m.pluginName());
            if (admin) {
                j.optional("version", m.pluginVersion());
            }
            j.endObject();
            if (admin) {
                j.optional("error", m.error());
            }
            j.endObject();
        }
        return j.endArray().endObject().toString();
    }

    static String serializeOperation(Operation op) {
        OperationSpec s = op.spec();
        Json j = new Json().beginObject()
                .field("key", op.key()).field("module", op.moduleId())
                .field("method", s.method()).field("path", s.path())
                .strings("consumes", s.consumes()).strings("produces", s.produces())
                .name("params").beginArray();
        for (Param p : s.params()) {
            j.beginObject().field("name", p.name()).field("in", p.in()).field("type", p.type())
                    .field("required", p.required()).optional("default", p.defaultValue());
            if (p.options() != null && !p.options().isEmpty()) {
                j.strings("options", p.options());
            }
            if (p.repeating()) {
                j.field("repeating", true);
            }
            j.optional("description", p.description());
            j.optional("javaType", p.javaType());
            j.endObject();
        }
        j.endArray().optional("access", s.access());
        if (s.deprecated()) {
            j.field("deprecated", true);
        }
        j.optional("bodyType", s.bodyType())
                .optional("bodyJavaType", s.bodyJavaType())
                .optional("returnType", s.returnType())
                .optional("returnJavaType", s.returnJavaType())
                .optional("summary", s.summary())
                .optional("description", s.description())
                .endObject();
        return j.toString();
    }

    static String operationsJson(List<Operation> operations) {
        Json j = new Json().beginArray();
        for (Operation op : operations) {
            j.raw(serializeOperation(op));
        }
        return j.endArray().toString();
    }

    private static String sha256(String s) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
