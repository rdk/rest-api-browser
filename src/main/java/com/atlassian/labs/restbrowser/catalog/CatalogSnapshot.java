package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.OperationSpec;
import com.atlassian.labs.restbrowser.catalog.Model.Param;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;

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
    private final List<Operation> operations;
    private final byte[] index;
    private final String adminTag;

    private CatalogSnapshot(String hash, boolean complete, int done, int total, List<ModuleEntry> modules,
                            List<Operation> operations, byte[] index) {
        this.hash = hash;
        this.complete = complete;
        this.done = done;
        this.total = total;
        this.modules = modules;
        this.operations = operations;
        this.index = index;
        // error details are node-specific, so they stay out of the shared hash; admins' ETag covers them
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
        List<ModuleEntry> sortedModules = new ArrayList<>(modules);
        sortedModules.sort(Comparator.comparing(ModuleEntry::id));
        List<Operation> sortedOps = new ArrayList<>(operations);
        sortedOps.sort(Comparator.comparing(Operation::key));
        String operationsJson = operationsJson(sortedOps);
        StringBuilder hashInput = new StringBuilder()
                .append("format=").append(FORMAT).append('\n')
                .append("plugin=").append(ownVersion).append('\n')
                .append("complete=").append(complete).append('\n');
        for (ModuleEntry m : sortedModules) {
            hashInput.append(String.join("|", m.id(), m.path(), m.origin(), m.stability(), String.valueOf(m.source()),
                    m.state().name(), String.valueOf(m.reason()), String.valueOf(m.opCount()), m.pluginKey(),
                    String.valueOf(m.pluginName()), String.valueOf(m.pluginVersion()))).append('\n');
        }
        hashInput.append(operationsJson);
        String hash = sha256(hashInput.toString()).substring(0, 24);
        String index = "{\"format\":" + FORMAT + ",\"hash\":\"" + hash + "\",\"operations\":" + operationsJson + "}";
        return new CatalogSnapshot(hash, complete, done, total, List.copyOf(sortedModules), List.copyOf(sortedOps),
                index.getBytes(StandardCharsets.UTF_8));
    }

    /** The same catalog marked incomplete: a rebuild has started. */
    CatalogSnapshot incomplete(String ownVersion) {
        return complete ? of(modules, operations, false, done, total, ownVersion) : this;
    }

    /** The ETag base for admins: the hash plus the error details only admins see. */
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

    public List<ModuleEntry> modules() {
        return modules;
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

    /**
     * The summary document for one user. Plugin versions and error details are for admins only.
     */
    public String summary(String productName, String productVersion, String productBuild, String baseUrl,
                          boolean admin) {
        return summary(productName, productVersion, productBuild, baseUrl, admin, false);
    }

    /** The summary document; sysadmin tells the UI whether its user may trigger a rebuild. */
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

    static String operationsJson(List<Operation> operations) {
        Json j = new Json().beginArray();
        for (Operation op : operations) {
            OperationSpec s = op.spec();
            j.beginObject()
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
                j.endObject();
            }
            j.endArray().optional("access", s.access());
            if (s.deprecated()) {
                j.field("deprecated", true);
            }
            j.optional("bodyType", s.bodyType()).endObject();
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
