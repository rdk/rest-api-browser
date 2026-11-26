package com.atlassian.labs.restbrowser.catalog;

import com.atlassian.labs.restbrowser.catalog.Model.ModuleEntry;
import com.atlassian.labs.restbrowser.catalog.Model.Operation;
import com.atlassian.labs.restbrowser.catalog.Model.OperationSpec;
import com.atlassian.labs.restbrowser.catalog.Model.State;

import com.atlassian.labs.restbrowser.json.JsonParser;

import java.util.List;

/** Test helpers: builds snapshots (CatalogSnapshot.of is package-private) and parses JSON. */
public final class CatalogTestSupport {

    private CatalogTestSupport() {
    }

    public static ModuleEntry module(String id, String path, State state, String version) {
        return new ModuleEntry(id, path, "product", "supported", "jersey", state, null, null, 0,
                "plugin." + id, "Plugin " + id, version);
    }

    public static OperationSpec spec(String method, String path) {
        return new OperationSpec(method, path, List.of(), List.of("application/json"), List.of(), null, false, null);
    }

    public static CatalogSnapshot snapshot(List<ModuleEntry> modules, List<Operation> operations, boolean complete,
                                           String ownVersion) {
        return CatalogSnapshot.of(modules, operations, complete, modules.size(), modules.size(), ownVersion);
    }

    /** A snapshot part way through a build: done of total modules read. */
    public static CatalogSnapshot snapshot(List<ModuleEntry> modules, List<Operation> operations, boolean complete,
                                           int done, int total, String ownVersion) {
        return CatalogSnapshot.of(modules, operations, complete, done, total, ownVersion);
    }

    /** A strict, minimal JSON parser: objects become LinkedHashMap, arrays List, numbers Long/Double. */
    public static Object parseJson(String json) {
        return JsonParser.parse(json);
    }
}
