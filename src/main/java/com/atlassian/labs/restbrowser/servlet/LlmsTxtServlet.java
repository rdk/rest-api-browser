package com.atlassian.labs.restbrowser.servlet;

import com.atlassian.annotations.security.AnonymousSiteAccess;
import com.atlassian.labs.restbrowser.catalog.CatalogService;
import com.atlassian.labs.restbrowser.catalog.CatalogSnapshot;
import com.atlassian.labs.restbrowser.catalog.OperationSource;
import com.atlassian.labs.restbrowser.rest.RestAuth;
import com.atlassian.labs.restbrowser.spring.LocalBeans;
import com.atlassian.plugin.PluginAccessor;
import com.atlassian.sal.api.ApplicationProperties;
import com.atlassian.sal.api.UrlMode;
import com.atlassian.sal.api.user.UserKey;
import com.atlassian.sal.api.user.UserManager;
import jakarta.servlet.ServletOutputStream;
import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

import static java.util.Objects.requireNonNull;

/**
 * Serves {@code /plugins/servlet/rest-api-browser/llms.txt} for AI coding agents.
 * Annotated with {@code @AnonymousSiteAccess} to honor the product's anonymous-access policy: when site anonymous access
 * is enabled, unauthenticated or unlicensed requests receive only a generic relative-path guide, while authenticated
 * licensed users receive instance-specific product details and catalog stats (via {@link CatalogService#peek()}, never
 * forcing a catalog build).
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
        byte[] body = (isFullGuide(req) ? renderFull(req) : render(req)).getBytes(StandardCharsets.UTF_8);
        resp.setContentLength(body.length);
        ServletOutputStream out = resp.getOutputStream();
        out.write(body);
        out.flush();
    }

    private static boolean isFullGuide(HttpServletRequest req) {
        if (req == null) {
            return false;
        }
        String servletPath = req.getServletPath();
        String pathInfo = req.getPathInfo();
        String uri = req.getRequestURI();
        return (servletPath != null && servletPath.endsWith("/llms-full.txt"))
                || (pathInfo != null && pathInfo.endsWith("llms-full.txt"))
                || (uri != null && uri.endsWith("/llms-full.txt"));
    }

    String render(HttpServletRequest req) {
        UserKey user = RestAuth.remoteUser(userManager, req);
        boolean licensed = RestAuth.isLicensedUser(userManager, user);
        boolean sysadmin = licensed && RestAuth.isSystemAdmin(userManager, user);
        return renderGuide(applicationProperties, pluginAccessor, catalog, licensed, sysadmin, false);
    }

    String renderFull(HttpServletRequest req) {
        UserKey user = RestAuth.remoteUser(userManager, req);
        boolean licensed = RestAuth.isLicensedUser(userManager, user);
        boolean sysadmin = licensed && RestAuth.isSystemAdmin(userManager, user);
        return renderGuide(applicationProperties, pluginAccessor, catalog, licensed, sysadmin, true);
    }

    /** Renders compact {@code llms.txt} or extended {@code llms-full.txt} Markdown for REST and MCP callers. */
    public static String renderGuide(ApplicationProperties appProps, PluginAccessor pluginAccessor,
                                     CatalogService catalog, boolean licensed, boolean sysadmin, boolean full) {
        String base = licensed ? stripTrailingSlash(canonicalOrRelativeBase(appProps)) : "";
        String api = base + "/rest/restbrowser/1";
        String ui = base + "/plugins/servlet/rest-api-browser";
        String compact = renderCompact(appProps, pluginAccessor, catalog, licensed, sysadmin, base, api, ui);
        if (!full) {
            return compact;
        }
        StringBuilder md = new StringBuilder(4096);
        md.append("# REST API Browser — Full Agent Reference\n\n");
        appendHeader(md, appProps, pluginAccessor, catalog, licensed, sysadmin);
        md.append(compact).append('\n');

        md.append("## Quick Curl Examples\n\n");
        md.append("```bash\n");
        md.append("# 0. Compact ~200-token node & catalog triage brief (or client/rab.py brief)\n");
        md.append("curl -H \"Authorization: Bearer $PAT\" \"").append(api).append("/catalog/brief\"\n\n");
        md.append("# 1. Search endpoints cleanly (Markdown)\n");
        md.append("curl -H \"Authorization: Bearer $PAT\" -H \"Accept: text/markdown\" \\\n");
        md.append("  \"").append(api).append("/catalog/operations?q=issue&method=GET&limit=10\"\n\n");
        md.append("# 2. Resolve a live URL to an operation key + pathParams\n");
        md.append("curl -H \"Authorization: Bearer $PAT\" \\\n");
        md.append("  \"").append(api).append("/catalog/resolve?method=GET&url=/rest/api/2/issue/PROJ-123\"\n\n");
        md.append("# 3. Export OpenAPI 3.1.0 for one module\n");
        md.append("curl -H \"Authorization: Bearer $PAT\" \\\n");
        md.append("  \"").append(api).append("/catalog/openapi?module=com.atlassian.rest:api&includeSchemas=true\"\n\n");
        md.append("# 4. One-call investigation context (metadata + schemas + decompiled method + impls, capped with maxChars)\n");
        md.append("curl -X POST -H \"Authorization: Bearer $PAT\" -H \"X-Atlassian-Token: no-check\" \\\n");
        md.append("  -H \"Content-Type: application/json\" \\\n");
        md.append("  -d '{\"url\":\"/rest/api/2/issue/PROJ-123\",\"maxLines\":250,\"maxChars\":6000,\"format\":\"markdown\"}' \\\n");
        md.append("  \"").append(api).append("/code/context\"\n");
        md.append("```\n\n");

        md.append("## Deep Links & Companion Live Scalpel Workflow\n\n");
        md.append("- **Direct decompiler deep-link**: Open `").append(ui).append("?class=<fqcn>&method=<name>&line=<1-based>` (or `?supportedOnly=1`) to launch the floating tabbed decompiler straight on a stack-trace frame.\n");
        md.append("- **Zero-dependency Python CLI**: Run `python3 client/rab.py brief`, `search`, `resolve`, `context`, or `source` with `RAB_URL` + `RAB_TOKEN` (defaults to `--max-chars 6000`).\n");
        md.append("- **Dual-MCP loop with Live Scalpel**: Pair `/rest/scalpel/1/mcp` (runtime traces, JFR, jobs, caches) with `").append(api).append("/mcp` (`decompile_source`, `read_bundle_resource`) to move straight from hot stack frames to exact decompiled lines and before/after trace diffs.\n\n");

        md.append("## MCP Streamable HTTP Configuration\n\n");
        md.append("Connect any MCP-capable client (Claude Code, Cursor, Antigravity) using Bearer PAT authentication:\n\n");
        md.append("```json\n");
        md.append("{\n");
        md.append("  \"mcpServers\": {\n");
        md.append("    \"rest-api-browser\": {\n");
        md.append("      \"url\": \"").append(api).append("/mcp\",\n");
        md.append("      \"headers\": {\n");
        md.append("        \"Authorization\": \"Bearer <PERSONAL_ACCESS_TOKEN>\"\n");
        md.append("      }\n");
        md.append("    }\n");
        md.append("  }\n");
        md.append("}\n");
        md.append("```\n\n");

        md.append("## HTTP Caching & Error Recovery\n\n");
        md.append("- **ETag Support**: `/catalog`, `/catalog/index/current`, `/catalog/openapi`, `/openapi` (`/openapi.json`), `/code/class`, `/code/plugin`, `/code/source`, `/code/schema`, and `/code/resource` return strong `ETag` headers and respond `304 Not Modified` to `If-None-Match`.\n");
        md.append("- **`not-started` (503)**: Lazy Confluence/Jira REST modules initialize on first HTTP hit; response `hint` includes the exact `/rest/{path}` probe URL and `POST ").append(api).append("/catalog/started?module={id}` call.\n");
        md.append("- **`unknown-operation` (404)** & **`class-not-found` (404)**: Responses return `hint` and `suggestions` with closest valid operation keys or candidate FQCNs.\n");
        md.append("- **`xsrf-check-failed` (403)**: Add `X-Atlassian-Token: no-check` on browser/cookie `POST` calls (not needed on `/mcp` with `Authorization: Bearer ...`).\n");
        md.append("- **Decompiler diagnostics**: `/code/source`, `/code/operation`, and `/code/context` emit `warnings` and `decompilerFallback` (e.g. `cfr`) if a decompiler emits incomplete output.\n");
        return md.toString();
    }

    private static String renderCompact(ApplicationProperties appProps, PluginAccessor pluginAccessor,
                                        CatalogService catalog, boolean licensed, boolean sysadmin,
                                        String base, String api, String ui) {
        StringBuilder md = new StringBuilder(2048);
        appendHeader(md, appProps, pluginAccessor, catalog, licensed, sysadmin);

        md.append("Recommended agent workflow:\n");
        md.append("1. Call `GET ").append(api).append("/catalog/brief` (or `/catalog?format=brief`) for a ~200-token node overview, then `GET ").append(api).append("/catalog/operations?q={keyword}&limit=20` or `GET ").append(api).append("/catalog/resolve?url=/rest/...`. Add `&format=markdown` (or `Accept: text/markdown`) for concise Markdown.\n");
        md.append("2. For one-call deep understanding (metadata, DTO schemas, handler source, and injected OSGi service implementations), call `POST ").append(api).append("/code/context` with `{\"op\":\"{key}\"}` or `{\"url\":\"/rest/...\"}` (sysadmin only; add `\"maxChars\":6000` to cap output).\n");
        md.append("3. Connect MCP-compatible agents directly via Streamable HTTP `POST ").append(api).append("/mcp` using `Authorization: Bearer <PAT>` (all tools support `maxChars`).\n");
        md.append("4. Read complete examples, parameters, deep links (`?class=...&method=...&line=...`), and error codes in [llms-full.txt](").append(ui).append("/llms-full.txt) or fetch machine-readable [openapi.json](").append(api).append("/openapi.json) (`/openapi`).\n\n");

        md.append("## Catalog API\n\n");
        md.append("- [Catalog brief](").append(api).append("/catalog/brief): Compact ~200-token plain-text triage brief of product, cluster `nodeId`, catalog hash, top modules, and waiting/failed modules (also `/catalog?format=brief&top=12`, supports `ETag`).\n");
        md.append("- [Catalog summary](").append(api).append("/catalog): Current catalog `hash`, product info, `nodeId`, `liveScalpel` companion flag, `sysadmin` flag, and all REST modules with state (`ok`, `pending`, `failed`). Supports `ETag` / `If-None-Match`.\n");
        md.append("- [Search operations](").append(api).append("/catalog/operations?q={text}&method={GET}&path={substr}&module={key}&plugin={key}&access={admin|sysadmin|licensed|anonymous}&deprecated={true|false}&usesClass={substr}&limit=50&offset=0&fields=compact|full&format=json|markdown): Server-side scored search & pagination over all indexed operations.\n");
        md.append("- [Resolve endpoint URL](").append(api).append("/catalog/resolve?url={pathOrUrl}&method={optional}&limit=10&format=json|markdown): Matches a URL against JAX-RS URI templates, returning ranked candidate operations and extracted `pathParams`/`queryParams`.\n");
        md.append("- [Export module OpenAPI 3.1](").append(api).append("/catalog/openapi?module={moduleId}&includeSchemas=true&schemaDepth=2): Generates an OpenAPI 3.1.0 specification for one indexed REST module (supports `ETag`).\n");
        md.append("- [Self OpenAPI 3.1](").append(api).append("/openapi.json): OpenAPI 3.1.0 specification of REST API Browser's own endpoints (also `/openapi`, role-filtered, supports `ETag`).\n");
        md.append("- [Current catalog index](").append(api).append("/catalog/index/current): Latest catalog snapshot stream supporting `ETag` / `If-None-Match` and `X-Catalog-Hash`.\n");
        md.append("- [Catalog index by hash](").append(api).append("/catalog/index/{hash}): Immutable snapshot stream for a specific catalog `hash`.\n");
        md.append("- [Start lazy module](").append(api).append("/catalog/started?module={moduleId}): POST with `X-Atlassian-Token: no-check` after probing a lazy module to index it on this node.\n");
        md.append("- [Rebuild catalog](").append(api).append("/catalog/refresh): POST with `X-Atlassian-Token: no-check` (sysadmin only) to rebuild the full catalog or one `?module={moduleId}`.\n\n");

        md.append("## Code & Decompilation API\n\n");
        md.append("- [One-shot investigation context](").append(api).append("/code/context): POST `X-Atlassian-Token: no-check` with `{\"op\":\"...\",\"url\":\"...\",\"method\":\"...\",\"maxLines\":400,\"format\":\"json|markdown\"}` for metadata, DTO schemas, decompiled handler source, and OSGi dependency implementations (sysadmin only).\n");
        md.append("- [Read-only MCP endpoint](").append(api).append("/mcp): JSON-RPC 2.0 `initialize`, `tools/*`, `resources/*`, and `prompts/*` exposing read-only catalog and code tools, resources, and prompts via PAT auth.\n");
        md.append("- [Operation details + source](").append(api).append("/code/operation?op={key}&scope=method&decompiler=vineflower&view=compact|full&startLine=1&maxLines=250&lineNumbers=true&format=json|markdown): Combined reflection details, OSGi bundle, plugin ownership, decompiled source, and bytecode `refs` (sysadmin only).\n");
        md.append("- [Class metadata, outlines, fields & enums](").append(api).append("/code/class?class={fqcn}&fromBundle={bundleId}&op={key}&view=compact|full&outline=true&includeImplementations=false&format=json|markdown): Reflection metadata, field annotations, enum constants, bytecode `LineNumberTable` outlines, and `ETag` caching (sysadmin only).\n");
        md.append("- [DTO JSON Schema & example](").append(api).append("/code/schema?class={fqcn}&op={key}&fromBundle={bundleId}&depth=3&includeExample=true&format=json|markdown): Draft 2020-12 JSON Schema + representative example payload (supports `ETag`, sysadmin only).\n");
        md.append("- [Plugin & OSGi bundle metadata](").append(api).append("/code/plugin?key={pluginKey}&view=compact|full): Inspect an Atlassian plugin, dependencies, modules, and backing OSGi bundle (supports `ETag`, sysadmin only).\n");
        md.append("- [Bundle resource reader](").append(api).append("/code/resource?bundleId={id}&plugin={key}&path={entry}&prefix=&startLine=1&maxLines=200&lineNumbers=true&format=json|text|markdown): Safely list or read UTF-8 descriptors (`atlassian-plugin.xml`), Spring configs, Velocity `.vm` templates, and `.properties` inside an OSGi bundle (supports `ETag`, sysadmin only).\n");
        md.append("- [Decompile class or method](").append(api).append("/code/source?class={fqcn}&op={key}&method={name}&scope=class&decompiler=vineflower&fromBundle={bundleId}&startLine=1&maxLines=250&includeMeta=false&lineNumbers=true&format=json|text|markdown): Decompile via `vineflower` or `cfr` with warnings/`decompilerFallback` hints and `ETag` support (sysadmin only).\n");
        md.append("- [Traverse typed reference graph](").append(api).append("/code/graph?class={fqcn}&op={key}&fromBundle={bundleId}&depth=2&maxNodes=40&includeJdk=false&excludeLibraries=false&preset=domain&edgeKinds=extends,implements,field,signature,body&packagePrefix=&includeSources=false&decompiler=vineflower): BFS traversal with typed edges and domain filtering (sysadmin only).\n");
        md.append("- [Find implementations & OSGi services](").append(api).append("/code/implementations?class={fqcn}&op={key}&fromBundle={bundleId}&bundleId={optional}&plugin={optional}&includeAbstract=false&limit=30): Live OSGi registered services plus concrete bytecode subtypes (sysadmin only).\n");
        md.append("- [Find bytecode callers](").append(api).append("/code/callers?class={fqcn}&method={optional}&op={key}&fromBundle={bundleId}&bundleId={optional}&plugin={optional}&packagePrefix=&limit=50): Scan constant pools for callers (sysadmin only).\n");
        md.append("- [Grep bytecode string literals](").append(api).append("/code/grep?q={text}&bundleId={optional}&plugin={optional}&packagePrefix=&caseSensitive=false&includeUtf8=true&limit=50): Fast constant-pool string/UTF-8 grep across bundles (sysadmin only).\n");
        md.append("- [Search Java classes](").append(api).append("/code/search?q={query}&limit=30&bundleId={optional}): Find Java classes across active OSGi bundles (sysadmin only).\n");
        md.append("- [Batch inspect or decompile](").append(api).append("/code/batch): POST `X-Atlassian-Token: no-check` with `{\"classes\":[...], ...}` or heterogeneous `{\"items\":[...]}` for up to 10 items (sysadmin only).\n");
        md.append("- [Operation Java details (UI)](").append(api).append("/catalog/details?op={key}): Reflection details (sysadmin only).\n");
        md.append("- [Operation source (UI)](").append(api).append("/catalog/details/source?op={key}&class={candidates}&fromBundle={bundleId}&scope=method&decompiler=vineflower): UI decompiler endpoint (sysadmin only).\n\n");

        md.append("## Optional\n\n");
        md.append("- [Complete Agent Reference](").append(ui).append("/llms-full.txt): Extended guide with curl examples, MCP client config, and error recovery hints.\n");
        md.append("- [REST API Browser UI](").append(ui).append("): Interactive web UI with search, live request runner, response viewer, clickable Java types, and tabbed decompiler.\n");
        md.append("- [Classic UI](").append(base).append("/plugins/servlet/restbrowser): Original WADL-based REST API Browser page.\n");
        md.append("- [Echo request headers](").append(api).append("/echo): Returns the request headers seen by the server (with secret headers redacted).\n");

        return md.toString();
    }

    private static void appendHeader(StringBuilder md, ApplicationProperties appProps, PluginAccessor pluginAccessor,
                                     CatalogService catalog, boolean licensed, boolean sysadmin) {
        md.append("# REST API Browser\n\n");
        if (licensed) {
            String product = safe(appProps.getDisplayName());
            String version = safe(appProps.getVersion());
            String ownVersion = LocalBeans.pluginVersion(pluginAccessor);
            CatalogSnapshot snap = catalog.peek();
            md.append("> Live REST API catalog, OpenAPI 3.1 exporter, Java/OSGi inspector, on-demand decompiler (CFR 0.152 & Vineflower 1.12.0), and MCP server running on ");
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
            md.append("> Live REST API catalog, Java class inspector, and on-demand bytecode decompiler for Atlassian Data Center.\n\n");
        }

        md.append("All REST endpoints require an authenticated licensed user (session cookie, Personal Access Token `Authorization: Bearer <token>`, or Basic Auth). ");
        md.append("POST endpoints require the header `X-Atlassian-Token: no-check` (for cookie auth; `/mcp` also accepts `Authorization: Bearer <token>` directly). ");
        md.append("Java inspection, decompilation, and code-graph endpoints require system administrator privileges");
        if (licensed) {
            md.append(sysadmin ? " (your current account has system administrator access)" : " (your current account is not a system administrator)");
        }
        md.append(" and can be disabled via `-D").append(OperationSource.ENABLED_PROPERTY).append("=false`.\n\n");
    }

    private static String canonicalOrRelativeBase(ApplicationProperties appProps) {
        String canonical = safe(appProps.getBaseUrl(UrlMode.CANONICAL));
        return !canonical.isEmpty() ? canonical : safe(appProps.getBaseUrl(UrlMode.RELATIVE));
    }

    private static String safe(String s) {
        return s == null ? "" : s.trim();
    }

    private static String stripTrailingSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }
}
