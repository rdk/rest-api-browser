package com.atlassian.labs.restbrowser.servlet;

import com.atlassian.annotations.security.UnrestrictedAccess;
import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.CatalogSnapshot;
import com.atlassian.labs.restbrowser.rest.RestAuth;
import com.atlassian.labs.restbrowser.spring.LocalBeans;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.UrlMode;
import com.atlassian.sal.api.auth.LoginUriProvider;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import com.atlassian.templaterenderer.TemplateRenderer;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

import static java.util.Objects.requireNonNull;

/**
 * Decorated administration landing page ({@code /plugins/servlet/rest-api-browser/admin}) linked from Jira and
 * Confluence administration menus. Provides a prominent launch button for the full-screen new UI, live agent/MCP
 * onboarding endpoints, and copyable debugging prompts.
 */
@UnrestrictedAccess
public class AdminIntroServlet extends RequiresLoginServlet {

    private static final String TEMPLATE = "/templates/admin-intro.vm";

    private final UserManager userManager;
    private final ApplicationProperties applicationProperties;
    private final PluginAccessor pluginAccessor;
    private final CatalogService catalog;

    record DecoratorMeta(String activeSection, String activeTab, String selectedWebItem) {
    }

    public AdminIntroServlet(final UserManager userManager,
                             final TemplateRenderer renderer,
                             final LoginUriProvider loginUriProvider,
                             final ApplicationProperties applicationProperties,
                             final PluginAccessor pluginAccessor,
                             final CatalogService catalog) {
        super(userManager, renderer, loginUriProvider);
        this.userManager = requireNonNull(userManager, "userManager");
        this.applicationProperties = requireNonNull(applicationProperties, "applicationProperties");
        this.pluginAccessor = requireNonNull(pluginAccessor, "pluginAccessor");
        this.catalog = requireNonNull(catalog, "catalog");
    }

    @Override
    protected boolean allowAnonymous() {
        return false;
    }

    @Override
    protected boolean handleRequest(final HttpServletRequest req, final HttpServletResponse resp) throws IOException {
        final UserKey user = RestAuth.remoteUser(userManager, req);
        if (!RestAuth.isAdmin(userManager, user) && !RestAuth.isSystemAdmin(userManager, user)) {
            resp.sendError(HttpServletResponse.SC_FORBIDDEN,
                    "Administrator access is required to view this administration page.");
            return true;
        }
        return false;
    }

    @Override
    protected String getTemplatePath() {
        return TEMPLATE;
    }

    @Override
    protected Map<String, Object> getContext(final HttpServletRequest request) {
        final String baseUrl = stripTrailingSlashes(nonNull(applicationProperties.getBaseUrl(UrlMode.RELATIVE)));
        final String canonicalRaw = stripTrailingSlashes(nonNull(applicationProperties.getBaseUrl(UrlMode.CANONICAL)));
        final String canonicalBaseUrl = canonicalRaw.isEmpty() ? baseUrl : canonicalRaw;
        final String apiBase = canonicalBaseUrl + "/rest/restbrowser/1";
        final String scalpelApiBase = canonicalBaseUrl + "/rest/scalpel/1";
        final String uiBase = canonicalBaseUrl + "/plugins/servlet/rest-api-browser";

        final String productName = nonNull(applicationProperties.getDisplayName());
        final String productVersion = nonNull(applicationProperties.getVersion());
        final String pluginVersion = LocalBeans.pluginVersion(pluginAccessor);
        final UserKey user = RestAuth.remoteUser(userManager, request);
        final boolean isSysadmin = RestAuth.isSystemAdmin(userManager, user);
        final boolean hasLiveScalpel = isSysadmin && LocalBeans.isLiveScalpelEnabled(pluginAccessor);
        final String nodeId = nonNull(LocalBeans.clusterNodeId());

        final DecoratorMeta meta = decoratorMeta(productName);
        final CatalogSnapshot snap = catalog.peek();

        final Map<String, Object> ctx = new HashMap<>();
        ctx.put("baseUrl", baseUrl);
        ctx.put("canonicalBaseUrl", canonicalBaseUrl);
        ctx.put("apiBase", apiBase);
        ctx.put("uiBase", uiBase);
        ctx.put("productName", productName);
        ctx.put("productVersion", productVersion);
        ctx.put("pluginVersion", pluginVersion);
        ctx.put("isSysadmin", isSysadmin);
        ctx.put("hasLiveScalpel", hasLiveScalpel);
        ctx.put("nodeId", nodeId);
        ctx.put("liveScalpelUrl", baseUrl + "/plugins/servlet/live-scalpel");
        ctx.put("activeSection", meta.activeSection());
        ctx.put("activeTab", meta.activeTab());
        ctx.put("selectedWebItem", meta.selectedWebItem());
        final int opCount = snap == null ? 0 : snap.operations().size();
        ctx.put("catalogReady", snap != null && snap.complete());
        ctx.put("catalogOpCount", opCount);
        ctx.put("catalogOpCountText", String.format(Locale.US, "%,d", opCount));
        ctx.put("catalogModuleCount", snap == null ? 0 : snap.modules().size());
        ctx.put("mcpConfigJson", buildMcpConfigJson(apiBase));
        ctx.put("dualMcpConfigJson", buildDualMcpConfigJson(apiBase, scalpelApiBase));
        ctx.put("promptDebugStuck", buildPromptDebugStuck(apiBase, uiBase));
        ctx.put("promptExplorePayload", buildPromptExplorePayload(apiBase));
        ctx.put("promptTraceError", buildPromptTraceError(apiBase));
        ctx.put("promptDualWorkflow", buildPromptDualWorkflow(apiBase, scalpelApiBase));
        return ctx;
    }

    static DecoratorMeta decoratorMeta(final String productName) {
        final String p = productName == null ? "" : productName.toLowerCase(Locale.ROOT);
        if (p.contains("jira")) {
            return new DecoratorMeta(
                    "admin_system_menu/advanced_menu_section/advanced_section",
                    "restapi-browser-link",
                    "");
        }
        if (p.contains("confluence")) {
            return new DecoratorMeta(
                    "system.admin/administration",
                    "restapi-browser-link",
                    "rest-browser-link-confluence");
        }
        if (p.contains("bitbucket")) {
            return new DecoratorMeta(
                    "atl.admin/admin-plugins-section",
                    "restapi-browser-link",
                    "");
        }
        if (p.contains("bamboo")) {
            return new DecoratorMeta(
                    "system.admin/system",
                    "restapi-browser-link",
                    "");
        }
        if (p.contains("crowd")) {
            return new DecoratorMeta(
                    "administrationnav",
                    "restapi-browser-link",
                    "");
        }
        return new DecoratorMeta(
                "system.admin/administration",
                "restapi-browser-link",
                "");
    }

    static String buildMcpConfigJson(final String apiBase) {
        final String escapedUrl = escapeJsonString(apiBase + "/mcp");
        return "{\n"
                + "  \"mcpServers\": {\n"
                + "    \"rest-api-browser\": {\n"
                + "      \"type\": \"http\",\n"
                + "      \"url\": \"" + escapedUrl + "\",\n"
                + "      \"headers\": {\n"
                + "        \"Authorization\": \"Bearer <PERSONAL_ACCESS_TOKEN>\"\n"
                + "      }\n"
                + "    }\n"
                + "  }\n"
                + "}";
    }

    public static String buildPromptDebugStuck(final String apiBase, final String uiBase) {
        return "Investigate why a REST endpoint on this instance is slow or getting stuck (read-only).\n"
                + "Target URL or symptom: <PASTE REQUEST URL / THREAD DUMP SYMPTOM HERE>\n"
                + "Instance API base: " + apiBase + " (full UI: " + uiBase + ")\n\n"
                + "Steps (use REST API Browser MCP tools, or REST endpoints with Authorization: Bearer <PAT>):\n"
                + "1. Resolve the endpoint to its operation key (`op`): call `resolve_url` (or `GET " + apiBase + "/catalog/resolve?url=<path>`).\n"
                + "2. Fetch handler details, request/response schemas, handler source, and OSGi service implementations in one shot: "
                + "call `investigate_operation_context` with `op`, `maxLines=400`, `lineNumbers=true` (or `POST " + apiBase + "/code/context` with header `X-Atlassian-Token: no-check`).\n"
                + "3. Trace downstream collaborators without pulling in JDK/library noise: inspect interfaces via `find_implementations` "
                + "(`/code/implementations`) and walk domain call/field edges via `traverse_graph` (`preset=domain`, `depth=2`, `/code/graph`). "
                + "Decompile suspicious classes/methods via `decompile_source` (`/code/source?decompiler=vineflower` or `cfr` if warnings appear).\n"
                + "4. Check bundle configuration and thread/timeout/filter wiring with `read_bundle_resource` (`/code/resource` on `atlassian-plugin.xml`, Spring XML, or `.properties`).\n"
                + "5. Summarize root-cause hypotheses with exact class/method/line references, lock/I-O/query bottlenecks, and safe remediation steps without executing mutating REST calls.";
    }

    public static String buildPromptExplorePayload(final String apiBase) {
        return "Document and construct a valid request for an undocumented or internal REST endpoint on this instance.\n"
                + "Search term or URL: <PASTE KEYWORD OR /rest/... URL HERE>\n"
                + "Instance API base: " + apiBase + "\n\n"
                + "1. Find candidate operations with `search_operations` (or `GET " + apiBase + "/catalog/operations?q=...&format=markdown`) or `export_module_openapi` (`/catalog/openapi?module=...`).\n"
                + "2. Inspect access requirements (`access` annotation), parameters, and synthesized request/response JSON Schema + example payload via `get_dto_schema` (`/code/schema?op=...`).\n"
                + "3. Read validation branches in the handler via `decompile_source` (`/code/source?op=...&scope=method&lineNumbers=true`).\n"
                + "4. Return required permissions, exact query/path/body fields, edge-case constraints, and a ready-to-run `curl` command.";
    }

    public static String buildPromptTraceError(final String apiBase) {
        return "Trace an unexpected REST error message, status code, or response header back to the plugin and Java code that emitted it.\n"
                + "Error text or identifier: <PASTE ERROR STRING / LOG FRAGMENT HERE>\n"
                + "Instance API base: " + apiBase + "\n\n"
                + "1. Search constant-pool string and UTF-8 literals across active OSGi bundles via `grep_bytecode` (or `GET " + apiBase + "/code/grep?q=...`).\n"
                + "2. Inspect matching classes and their owning plugin via `inspect_class` (`/code/class?outline=true`) and `inspect_plugin` (`/code/plugin?view=compact`).\n"
                + "3. Find upstream REST handlers calling the helper with `find_callers` (`/code/callers`) and cross-reference via `search_operations` (`usesClass=...`).\n"
                + "4. Explain the exact condition triggering the error and which REST endpoints can reach it.";
    }

    static String buildDualMcpConfigJson(final String rabApiBase, final String scalpelApiBase) {
        return "{\n"
                + "  \"mcpServers\": {\n"
                + "    \"rest-api-browser\": {\n"
                + "      \"type\": \"http\",\n"
                + "      \"url\": \"" + escapeJsonString(rabApiBase + "/mcp") + "\",\n"
                + "      \"headers\": {\n"
                + "        \"Authorization\": \"Bearer <PERSONAL_ACCESS_TOKEN>\"\n"
                + "      }\n"
                + "    },\n"
                + "    \"live-scalpel\": {\n"
                + "      \"type\": \"http\",\n"
                + "      \"url\": \"" + escapeJsonString(scalpelApiBase + "/mcp") + "\",\n"
                + "      \"headers\": {\n"
                + "        \"Authorization\": \"Bearer <PERSONAL_ACCESS_TOKEN>\"\n"
                + "      }\n"
                + "    }\n"
                + "  }\n"
                + "}";
    }

    public static String buildPromptDualWorkflow(final String rabApiBase, final String scalpelApiBase) {
        return "Diagnose a slow or failing REST endpoint end-to-end across runtime traces and Java bytecode.\n"
                + "Target path: <PASTE /rest/... URL HERE>\n"
                + "REST API Browser: " + rabApiBase + " | Live Scalpel: " + scalpelApiBase + "\n\n"
                + "1. Resolve the REST operation and check its access/parameters via REST API Browser (`resolve_url`, `investigate_operation_context`).\n"
                + "2. Capture a live request stack trace on the same sticky node with Live Scalpel (`scalpel_trace` or `POST " + scalpelApiBase + "/traces/arm`) to see actual wall/CPU time, wait reasons, and hot stack frames.\n"
                + "3. Pass the hottest non-JDK frame (`class`, `method`) back to REST API Browser `decompile_source` (`/code/source`) and inspect OSGi descriptors via `read_bundle_resource`.\n"
                + "4. After applying a fix or configuration tuning, re-run `scalpel_trace` and compare before/after with `traces/diff/{idA}/{idB}?format=brief`.";
    }

    private static String escapeJsonString(final String value) {
        final StringBuilder out = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            final char c = value.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        return out.toString();
    }

    private static String stripTrailingSlashes(final String value) {
        int end = value.length();
        while (end > 0 && value.charAt(end - 1) == '/') {
            end--;
        }
        return value.substring(0, end);
    }

    private static String nonNull(final String s) {
        return s == null ? "" : s;
    }
}
