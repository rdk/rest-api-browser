package com.atlassian.labs.restbrowser.servlet;

import com.atlassian.annotations.security.AnonymousSiteAccess;
import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.CatalogSnapshot;
import com.atlassian.labs.restbrowser.catalog.OperationSource;
import com.atlassian.labs.restbrowser.spring.LocalBeans;
import com.atlassian.plugin.Plugin;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.UrlMode;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;

import static java.util.Objects.requireNonNull;

/**
 * Serves {@code /plugins/servlet/rest-api-browser/llms.txt} following the <a href="https://llmstxt.org/">llmstxt.org</a>
 * format so AI coding agents can discover and use the REST API Browser's catalog, class inspection, decompiler, and
 * code-traversal endpoints.
 * <p>
 * Authenticated users receive an instance-specific guide (canonical base URL, product name/version, live catalog hash
 * and counts). Unauthenticated requests receive a generic guide with relative paths only so no instance details leak.
 */
@AnonymousSiteAccess
public class LlmsTxtServlet extends HttpServlet {

    private final UserManager userManager;
    private final ApplicationProperties applicationProperties;
    private final PluginAccessor pluginAccessor;
    private final CatalogService catalog;

    public LlmsTxtServlet(UserManager userManager, ApplicationProperties applicationProperties,
                          PluginAccessor pluginAccessor, CatalogService catalog) {
        this.userManager = requireNonNull(userManager);
        this.applicationProperties = requireNonNull(applicationProperties);
        this.pluginAccessor = requireNonNull(pluginAccessor);
        this.catalog = requireNonNull(catalog);
    }

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.setContentType("text/plain; charset=utf-8");
        resp.setHeader("Cache-Control", "private, no-cache");
        resp.getWriter().write(render(req));
    }

    String render(HttpServletRequest req) {
        UserKey user = userManager.getRemoteUserKey(req);
        boolean authenticated = user != null;
        boolean sysadmin = authenticated && userManager.isSystemAdmin(user);
        String base = authenticated ? stripTrailingSlash(canonicalOrRelativeBase()) : "";
        String api = base + "/rest/restbrowser/1";
        String ui = base + "/plugins/servlet/rest-api-browser";

        StringBuilder md = new StringBuilder(2048);
        md.append("# REST API Browser\n\n");
        if (authenticated) {
            String product = safe(applicationProperties.getDisplayName());
            String version = safe(applicationProperties.getVersion());
            String ownVersion = pluginVersion();
            CatalogSnapshot snap = req.getServletContext() != null ? catalog.current(req.getServletContext()) : null;
            md.append("> Live REST API catalog, Java class inspector, and on-demand decompiler (CFR 0.152 & Vineflower 1.11.1) running on ");
            md.append(product.isEmpty() ? "this Atlassian Data Center instance" : (version.isEmpty() ? product : product + " " + version));
            if (!ownVersion.isEmpty()) {
                md.append(" (plugin v").append(ownVersion).append(")");
            }
            if (snap != null) {
                int ops = snap.modules().stream().mapToInt(m -> m.opCount()).sum();
                md.append(". Catalog hash `").append(snap.hash()).append("`: ")
                        .append(ops).append(" operations across ")
                        .append(snap.modules().size()).append(" modules (")
                        .append(snap.complete() ? "complete" : snap.done() + "/" + snap.total() + " indexed")
                        .append(")");
            }
            md.append(".\n\n");
        } else {
            md.append("> Live REST API catalog, Java class inspector, and on-demand bytecode decompiler (CFR 0.152 & Vineflower 1.11.1) for Atlassian Data Center.\n\n");
        }

        md.append("All REST endpoints require an authenticated licensed user (session cookie, Personal Access Token `Authorization: Bearer <token>`, or Basic Auth). ");
        md.append("POST endpoints require the header `X-Atlassian-Token: no-check`. ");
        md.append("Java inspection, decompilation, and code-graph endpoints require system administrator privileges");
        if (authenticated) {
            md.append(sysadmin ? " (your current account has system administrator access)" : " (your current account is not a system administrator)");
        }
        md.append(" and can be disabled via `-D").append(OperationSource.ENABLED_PROPERTY).append("=false`.\n\n");

        md.append("Recommended agent workflow:\n");
        md.append("1. Fetch `GET ").append(api).append("/catalog` to obtain the current `hash`, `baseUrl`, and module list.\n");
        md.append("2. Fetch `GET ").append(api).append("/catalog/index/{hash}` to search operations by HTTP method, path, OpenAPI summary/description, parameters, `bodyJavaType`, and `returnJavaType`.\n");
        md.append("3. For a specific operation `key`, fetch `GET ").append(api).append("/code/operation?op={key}&scope=method` to get reflection metadata, OSGi/plugin provenance, and decompiled source in one call.\n");
        md.append("4. Traverse referenced Java classes via `GET ").append(api).append("/code/graph?class={fqcn}&fromBundle={bundleId}&depth=2` or inspect individual classes via `GET ").append(api).append("/code/class` and `GET ").append(api).append("/code/source?class={fqcn}&startLine=1&maxLines=200`.\n\n");

        md.append("## Catalog API\n\n");
        md.append("- [Catalog summary](").append(api).append("/catalog): Current catalog `hash`, product info, `sysadmin` flag, and all REST modules with state (`ok`, `pending`, `failed`). Supports `ETag` / `If-None-Match`.\n");
        md.append("- [Catalog index](").append(api).append("/catalog/index/{hash}): Full list of REST operations with `key`, `module`, `method`, `path`, `consumes`, `produces`, `params` (including `javaType` and `description`), `bodyType`, `bodyJavaType`, `returnType`, `returnJavaType`, `access`, `summary`, and `description`.\n");
        md.append("- [Start lazy module](").append(api).append("/catalog/started?module={moduleId}): POST with `X-Atlassian-Token: no-check` after hitting a lazy module to index it on this node.\n");
        md.append("- [Rebuild catalog](").append(api).append("/catalog/refresh): POST with `X-Atlassian-Token: no-check` (sysadmin only) to rebuild the full catalog or one `?module={moduleId}`.\n\n");

        md.append("## Code & Decompilation API\n\n");
        md.append("- [Operation details + source](").append(api).append("/code/operation?op={key}&scope=method&decompiler=cfr): Combined reflection details, OSGi bundle, plugin ownership, decompiled source, `methodLine` (1-based), and bytecode `refs` in one request (sysadmin only).\n");
        md.append("- [Class metadata & OSGi provenance](").append(api).append("/code/class?class={fqcn}&fromBundle={bundleId}&op={key}): Structured Java class inspection without decompiling — declaration, superclasses, interfaces, annotations, method/field/constructor counts and signatures, bytecode version/size, classLoader, codeSource, OSGi bundle headers/wiring/export state, plugin ownership & installed/loaded/enabled timestamps, and `refs` (sysadmin only).\n");
        md.append("- [Decompile class or method](").append(api).append("/code/source?class={fqcn}&op={key}&method={name}&scope=class&decompiler=cfr&fromBundle={bundleId}&startLine=1&maxLines=250&includeMeta=false): On-demand decompilation via `cfr` (CFR 0.152) or `vineflower` (Vineflower 1.11.1). Supports line slicing (`startLine`, `maxLines`), `methodLine` anchoring, `refs` extraction, and raw source via `?format=text` or `Accept: text/plain` (sysadmin only).\n");
        md.append("- [Traverse class reference graph](").append(api).append("/code/graph?class={fqcn}&op={key}&fromBundle={bundleId}&depth=2&maxNodes=40&includeJdk=false&packagePrefix=&includeSources=false&decompiler=cfr): BFS traversal of referenced classes across OSGi bundle wires, returning `nodes` (with OSGi/plugin provenance and outgoing edges) and `edges` (sysadmin only).\n");
        md.append("- [Search Java classes](").append(api).append("/code/search?q={query}&limit=30&bundleId={optional}): Find Java classes across REST handlers and active OSGi bundles by substring or package prefix (sysadmin only).\n");
        md.append("- [Batch inspect or decompile](").append(api).append("/code/batch): POST with `X-Atlassian-Token: no-check` and JSON `{\"classes\":[\"fqcn\",...],\"fromBundle\":-1,\"decompiler\":\"cfr\",\"includeSource\":true,\"includeMeta\":false,\"maxLines\":200}` for up to 10 classes in one round trip (sysadmin only).\n");
        md.append("- [Operation Java details (UI)](").append(api).append("/catalog/details?op={key}): Reflection details of an operation's handler method, class, signature types, OSGi bundle wiring, plugin, and REST module (sysadmin only).\n");
        md.append("- [Operation source (UI)](").append(api).append("/catalog/details/source?op={key}&class={candidates}&fromBundle={bundleId}&scope=method&decompiler=cfr): Legacy UI decompiler endpoint backed by the same engine (sysadmin only).\n\n");

        md.append("## Optional\n\n");
        md.append("- [REST API Browser UI](").append(ui).append("): Interactive web UI with search, live request runner, response viewer, clickable Java types, and tabbed CFR/Vineflower decompiler.\n");
        md.append("- [Classic UI](").append(base).append("/plugins/servlet/restbrowser): Original WADL-based REST API Browser page.\n");
        md.append("- [Echo request headers](").append(api).append("/echo): Returns the request headers seen by the server (with secret headers redacted).\n");

        return md.toString();
    }

    private String canonicalOrRelativeBase() {
        String canonical = safe(applicationProperties.getBaseUrl(UrlMode.CANONICAL));
        return !canonical.isEmpty() ? canonical : safe(applicationProperties.getBaseUrl(UrlMode.RELATIVE));
    }

    private String pluginVersion() {
        try {
            Plugin own = pluginAccessor.getPlugin(LocalBeans.PLUGIN_KEY);
            String version = own == null ? null : own.getPluginInformation().getVersion();
            return safe(version);
        } catch (RuntimeException e) {
            return "";
        }
    }

    private static String safe(String s) {
        return s == null ? "" : s.trim();
    }

    private static String stripTrailingSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }
}
