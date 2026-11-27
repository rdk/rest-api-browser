# Agent REST API & MCP Reference

REST API Browser exposes a scriptable REST API under `/rest/restbrowser/1`, machine-readable OpenAPI 3.1.0 documents, [`llmstxt.org`](https://llmstxt.org/) bootstrap guides, and a built-in strictly read-only Model Context Protocol (MCP) Streamable HTTP server.

All examples below use `https://example.invalid/jira` as the base URL.

## Discovery & Bootstrap

| Surface | URL | Auth | Purpose |
|---|---|---|---|
| Admin intro page | `/plugins/servlet/rest-api-browser/admin` | Admin / Sysadmin | Decorated administration landing page linked from Jira/Confluence admin menus: full-screen launch button, live agent URLs, MCP config, and copyable prompts. |
| Compact agent guide | `/plugins/servlet/rest-api-browser/llms.txt` | Optional (`@AnonymousSiteAccess`) | Concise entry point; returns generic relative URLs when anonymous, or instance product details + live catalog stats from `peek()` when logged in as a licensed user. |
| Full agent reference | `/plugins/servlet/rest-api-browser/llms-full.txt` | Optional (`@AnonymousSiteAccess`) | Extended guide with `curl` examples, MCP JSON config, `ETag` notes, and error recovery hints. |
| Self OpenAPI 3.1.0 | `/rest/restbrowser/1/openapi` (`/openapi.json`) | `@LicensedOnly` | OpenAPI 3.1.0 spec for REST API Browser's own endpoints (role-filtered to hide `/code/*` and `/catalog/refresh` from non-sysadmins; supports `ETag`). |
| Module OpenAPI 3.1.0 | `/rest/restbrowser/1/catalog/openapi?module={id}` | `@LicensedOnly` | On-demand OpenAPI 3.1.0 spec for any catalog REST module (adds DTO schemas when called by a sysadmin; supports `ETag`). |
| Built-in MCP server | `/rest/restbrowser/1/mcp` | `@LicensedOnly` | Streamable HTTP JSON-RPC 2.0 endpoint exposing `tools/*` (4 catalog / 16 sysadmin), `resources/*`, and `prompts/*`. |

> [!NOTE]
> Atlassian REST v2 runs Jersey's URI extension content negotiation (`UriConnegFilter`), stripping trailing `.json`. [`OpenApiResource.java`](../src/main/java/com/atlassian/labs/restbrowser/rest/OpenApiResource.java) declares `@Path("/openapi")`, so both `/rest/restbrowser/1/openapi` and `/rest/restbrowser/1/openapi.json` resolve to it cleanly.

## Authentication, Roles & XSRF

- **Licensed users (`@LicensedOnly`)**: Catalog discovery (`/catalog`, `/catalog/operations`, `/catalog/resolve`, `/catalog/openapi`, `/catalog/index/*`, `/catalog/started`, `/openapi`, `/echo`) and the 4 catalog MCP tools. Unauthenticated calls return `401 login-required`; unlicensed accounts (such as service-desk portal users) return `403 licensed-user-required`.
- **System administrators (`@SystemAdminOnly`)**: Full catalog rebuild (`POST /catalog/refresh`), the UI reflection endpoints (`/catalog/details`, `/catalog/details/source`), all `/code/*` endpoints, and the 12 code-intelligence MCP tools. Non-sysadmins receive `403 system-admin-only`.
- **Credentials**: Works with browser session cookies, HTTP Basic auth, or Jira/Confluence Personal Access Tokens (`Authorization: Bearer <token>`).
- **XSRF protection**: Browser/CLI `POST` calls to `/catalog/started`, `/catalog/refresh`, `/code/batch`, and `/code/context` require `X-Atlassian-Token: no-check`. `POST /mcp` is `@XsrfProtectionExcluded` so standard MCP clients work with `Authorization: Bearer <token>` alone; cross-origin cookie `POST` requests without `Authorization` or `X-Atlassian-Token: no-check` are rejected with `403 xsrf-check-failed`.
- **Disable decompilation**: Start the product with `-Drest.api.browser.decompile=false` if bytecode decompilation must be turned off globally.

## Catalog & OpenAPI Endpoints (`/rest/restbrowser/1`)

| Endpoint | Role | Params & Notes |
|---|---|---|
| `GET /catalog` | Licensed | Current `hash`, `complete`, `progress{done,total}`, product info, optional cluster `nodeId`, `sysadmin` & `liveScalpel` flags, and REST module states (`ok`, `pending`, `failed`). Pass `?format=brief` (with optional `top`) for plain-text triage output, or use `ETag` / `If-None-Match` (`304`) for JSON. |
| `GET /catalog/brief` | Licensed | Plain-text instance & catalog triage brief (`text/plain`; optional `top` module count, default `12`) showing product version, cluster node, catalog state, Live Scalpel availability, and top REST modules. Supports `ETag` / `304`. |
| `GET /catalog/operations` | Licensed | Server-side scored search & pagination across indexed operations: `q`, `method`, `path` (substring or safe `/regex/`), `module`, `plugin`, `access` (`anonymous`, `unlicensed`, `licensed`, `admin`, `sysadmin`), `deprecated` (`true`/`false`), `usesClass` (DTO/param type word-boundary filter), `limit` (`<= 200`), `offset`, `fields=compact|full`, `format=json|markdown`. Emits `X-Catalog-Hash`. |
| `GET /catalog/resolve` | Licensed | Matches a concrete URL (`?url=/rest/...` or full URL) plus optional `method` against JAX-RS URI templates; returns ranked candidate operations (`limit <= 25`) with extracted `pathParams` and `queryParams`. Supports `format=json|markdown`. |
| `GET /catalog/openapi` | Licensed | Exports OpenAPI 3.1.0 JSON for `?module={moduleId}`. Optional `includeSchemas=true|false` and `schemaDepth` (`<= 2` default; sysadmin only, capped at 60 operations for deep DTO schemas). Supports `ETag` / `If-None-Match`. |
| `GET /catalog/index/current` | Licensed | Streams the latest node-local operation index with `ETag` / `If-None-Match` and `X-Catalog-Hash`. |
| `GET /catalog/index/{hash}` | Licensed | Immutable operation index (`Cache-Control: private, max-age=31536000, immutable` when complete); returns `404 unknown-hash` with recovery hint if another node/rebuild moved ahead. |
| `POST /catalog/started?module={id}` | Licensed | Requires `X-Atlassian-Token: no-check`. Re-reads a single lazy Confluence/Jira module after a probe request initializes it (`200`, `202`, `204`, `404`, or `409 still-not-started`). |
| `POST /catalog/refresh[?module={id}]` | Sysadmin | Requires `X-Atlassian-Token: no-check`. Triggers full or single-module catalog rebuild (`204`). |
| `GET /echo` | Licensed | Echoes request headers as seen by the server with credential headers redacted (`Authorization`, `Cookie`, token headers). |

## Code Intelligence & Decompilation Endpoints (`/rest/restbrowser/1/code/*`)

All `/code/*` endpoints require a **system administrator** (`@SystemAdminOnly`).

| Endpoint | Method | Params & Behavior |
|---|---|---|
| `/code/context` | `POST` | Requires `X-Atlassian-Token: no-check`. Accepts JSON `{"op":"..."}` or `{"url":"...","method":"..."}` plus `maxLines` (default `400`), `maxChars` (optional `200..200000` Markdown char budget, also accepted as query param), `schemaDepth` (`3`), `includeSchemas`, `includeImplementations`, `includeSource`, `lineNumbers`, `decompiler` (`vineflower`|`cfr`), `format` (`json`|`markdown`). Returns resolved operation summary, details, request/response DTO schemas, line-budgeted handler source, and OSGi implementations for injected fields in one call. |
| `/code/operation` | `GET` | `op`, `scope` (`method`|`class`), `decompiler`, `view` (`compact`|`full`), `startLine`, `maxLines`, `lineNumbers`, `format` (`json`|`markdown`). Combines reflection details, OSGi bundle/plugin provenance, handler source, and bytecode `refs`. |
| `/code/class` | `GET` | `class` / `op`, `fromBundle`, `view` (`compact`|`full`), `outline` (`true`/`false` for bytecode `LineNumberTable` method ranges), `includeImplementations` (`true`/`false` + inline service hints on interfaces/abstract types), `format` (`json`|`markdown`). Reads fields, annotations, and enum constants without decompiling. Supports `ETag`. |
| `/code/schema` | `GET` | `class` / `op`, `fromBundle`, `depth` (default `3`), `includeExample` (`true`/`false`), `format` (`json`|`markdown`). Synthesizes Draft 2020-12 JSON Schema + representative example payloads from DTO bytecode/reflection (request body + typed return DTOs). Supports `ETag`. |
| `/code/source` | `GET` | `class` / `op`, `method`, `scope` (`class`|`method`), `decompiler` (`vineflower`|`cfr`), `fromBundle`, `startLine`, `maxLines`, `includeMeta`, `lineNumbers`, `format` (`json`|`text`|`markdown`). Includes `warnings` and `decompilerFallback` hints on partial output. Supports `ETag`. |
| `/code/plugin` | `GET` | `key` (plugin key), `view` (`compact`|`full`). Returns plugin metadata, dependencies, modules, and backing OSGi bundle details. Supports `ETag`. |
| `/code/resource` | `GET` | `bundleId` / `plugin`, `path`, `prefix`, `startLine`, `maxLines`, `lineNumbers`, `limit` (`100`), `format` (`json`|`text`|`markdown`). Lists or reads non-binary UTF-8 bundle entries (`atlassian-plugin.xml`, Spring XML, `.vm`, `.properties`) with traversal and binary guards. Supports `ETag`. |
| `/code/graph` | `GET` | `class` / `op`, `fromBundle`, `depth` (`1`), `maxNodes` (`30`), `preset=domain`, `edgeKinds` (`extends,implements,field,signature,body`), `includeJdk`, `excludeLibraries`, `packagePrefix`, `includeSources`, `decompiler`. BFS traversal across OSGi bundle wires with typed edge kinds. |
| `/code/implementations` | `GET` | `class` / `op`, `fromBundle`, `bundleId`, `plugin`, `includeAbstract`, `limit` (`30`). Finds live OSGi registered services and concrete bytecode subtypes. |
| `/code/callers` | `GET` | `class`, optional `method`, `op`, `fromBundle`, `bundleId`, `plugin`, `packagePrefix`, `limit` (`50`). Scans wired OSGi bundle constant pools for callers. |
| `/code/grep` | `GET` | `q`, `bundleId`, `plugin`, `packagePrefix`, `caseSensitive`, `includeUtf8`, `limit` (`50`). Scans constant-pool string and UTF-8 literals without decompiling. |
| `/code/search` | `GET` | `q`, `limit` (`30`), `bundleId`. Searches Java class names across active OSGi bundles. |
| `/code/batch` | `POST` | Requires `X-Atlassian-Token: no-check` (max body `16,384` bytes, up to `10` items). Accepts `{"classes":[...]}` or heterogeneous `{"items":[{class/op, scope, method, decompiler, includeSource, includeMeta, includeSchema, startLine, maxLines, lineNumbers}]}`. |

## Built-in Read-Only MCP Server (`POST /rest/restbrowser/1/mcp`)

[`McpResource.java`](../src/main/java/com/atlassian/labs/restbrowser/rest/McpResource.java) implements MCP Streamable HTTP JSON-RPC 2.0 (`protocolVersion`: `"2025-03-26"`), advertising `tools`, `resources`, and `prompts` capabilities and handling `initialize`, `notifications/*`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, and `prompts/get` (`GET /mcp` returns `405` with `Allow: POST`). Every tool sets `readOnlyHint: true`, `destructiveHint: false`, and `idempotentHint: true`.

### MCP Client Configuration

```json
{
  "mcpServers": {
    "rest-api-browser": {
      "url": "https://example.invalid/jira/rest/restbrowser/1/mcp",
      "headers": {
        "Authorization": "Bearer <PERSONAL_ACCESS_TOKEN>"
      }
    }
  }
}
```

### Tools Exposed

All 16 tools accept an optional `maxChars` integer (`200..200000`) to cap returned text/Markdown payloads cleanly at a line boundary.

- **Licensed users (4 tools)**:
  - `search_operations` — search indexed operations (`q`, `method`, `path`, `module`, `plugin`, `access`, `deprecated`, `usesClass`, `limit`, `offset`, `format`, `maxChars`)
  - `resolve_url` — match a concrete URL against JAX-RS URI templates (`url`, `method`, `limit`, `format`, `maxChars`)
  - `get_catalog_summary` — retrieve current catalog hash, build progress, and modules (`format=json|brief`, `top`, `maxChars`)
  - `export_module_openapi` — generate OpenAPI 3.1.0 JSON for one module (`module`, `includeSchemas`, `schemaDepth`, `maxChars`)
- **System administrators (+12 tools, 16 total)**:
  - `investigate_operation_context` — one-shot context bundle (`POST /code/context`)
  - `inspect_operation` — combined reflection details, OSGi provenance, and handler source (`GET /code/operation`)
  - `get_dto_schema` — Draft 2020-12 JSON Schema + example payload (`GET /code/schema`)
  - `inspect_class` — fields, enums, annotations, and bytecode outlines (`GET /code/class`)
  - `find_implementations` — live OSGi services + concrete bytecode subtypes (`GET /code/implementations`)
  - `find_callers` — constant-pool caller lookup across wired bundles (`GET /code/callers`)
  - `grep_bytecode` — constant-pool string/UTF-8 grep (`GET /code/grep`)
  - `decompile_source` — Vineflower or CFR decompilation with line slicing (`GET /code/source`)
  - `traverse_graph` — typed BFS reference traversal (`GET /code/graph`)
  - `search_classes` — class name search across active bundles (`GET /code/search`)
  - `inspect_plugin` — plugin dependencies, modules, and OSGi bundle metadata (`GET /code/plugin`)
  - `read_bundle_resource` — list or read UTF-8 descriptors/templates inside a bundle (`GET /code/resource`)

### Resources & Templates Exposed

- **Static resources (`resources/list`)**:
  - `rab://llms.txt` (`text/markdown`) — compact discovery guide
  - `rab://llms-full.txt` (`text/markdown`) — full reference with `curl` & MCP config
  - `rab://catalog/brief` (`text/plain`) — concise cluster/module triage brief
  - `rab://catalog/summary` (`application/json`) — current catalog hash, product info, and module list
  - `rab://openapi/self` (`application/json`) — OpenAPI 3.1.0 spec for REST API Browser's own endpoints
- **URI templates (`resources/templates/list`)**:
  - `rab://catalog/openapi/{module}` (`application/json`, all licensed users) — OpenAPI 3.1.0 spec for one URL-encoded module ID
  - `rab://code/class/{fqcn}` (`application/json`, `@SystemAdminOnly`) — reflection metadata & bytecode outline
  - `rab://code/source/{fqcn}` (`application/json`, `@SystemAdminOnly`) — decompiled Java source
  - `rab://code/plugin/{pluginKey}` (`application/json`, `@SystemAdminOnly`) — plugin metadata & OSGi bundle details

### Prompts Exposed

- `explore-endpoint-payload` (all licensed users, optional `query`) — document a REST endpoint's permissions, parameters, and DTO payload
- `debug-stuck-endpoint` (`@SystemAdminOnly`, optional `target`) — read-only investigation workflow for slow/stuck REST endpoints
- `trace-rest-error` (`@SystemAdminOnly`, optional `error`) — trace an unexpected REST error string back to bytecode callers and handlers

## Content Negotiation, ETag Caching & Error Recovery

- **Formats**: Endpoints with Markdown or text views accept `?format=markdown` (or `Accept: text/markdown`) and `?format=text` (or `Accept: text/plain`).
- **ETag / `304 Not Modified`**: `/catalog`, `/catalog/index/current`, `/catalog/openapi`, `/openapi` (`/openapi.json`), `/code/class`, `/code/plugin`, `/code/source`, `/code/schema`, and `/code/resource` emit strong `ETag` headers and return `304` on matching `If-None-Match` (ignoring volatile timing/cache telemetry like `inspectMs`, `decompileMs`, and `cached`).
- **Actionable errors**:
  - `unknown-hash` (`404`): suggests `/catalog/index/current` or `/catalog/operations`.
  - `not-started` (`503`): provides the exact probe URL and `POST /catalog/started?module={id}` recovery call.
  - `unknown-operation` (`404`) and `class-not-found` (`404`): return `hint` and fuzzy `suggestions` with closest valid operation keys or class names.
  - `xsrf-check-failed` (`403`): reminds callers to add `X-Atlassian-Token: no-check` on cookie/form `POST` requests.

## Quick `curl` Examples

```bash
# 1. Search endpoints cleanly (Markdown)
curl -H "Authorization: Bearer $PAT" -H "Accept: text/markdown" \
  "https://example.invalid/jira/rest/restbrowser/1/catalog/operations?q=issue&method=GET&limit=10"

# 2. Resolve a live URL to an operation key + pathParams
curl -H "Authorization: Bearer $PAT" \
  "https://example.invalid/jira/rest/restbrowser/1/catalog/resolve?method=GET&url=/rest/api/2/issue/PROJ-123"

# 3. Export OpenAPI 3.1.0 for one module
curl -H "Authorization: Bearer $PAT" \
  "https://example.invalid/jira/rest/restbrowser/1/catalog/openapi?module=com.atlassian.rest:api&includeSchemas=true"

# 4. One-call investigation context (metadata + schemas + decompiled method + impls)
curl -X POST -H "Authorization: Bearer $PAT" -H "X-Atlassian-Token: no-check" \
  -H "Content-Type: application/json" \
  -d '{"url":"/rest/api/2/issue/PROJ-123","maxLines":250,"format":"markdown"}' \
  "https://example.invalid/jira/rest/restbrowser/1/code/context"
```

## Example Agent Prompts

These ready-to-use prompts match what the Admin Intro page (`/plugins/servlet/rest-api-browser/admin`) pre-fills with the live instance base URL.

### Debug a Slow or Stuck REST Endpoint (Read-Only)

```text
Investigate why a REST endpoint on https://example.invalid/jira is slow or getting stuck (read-only).
Target URL or symptom: <PASTE REQUEST URL / THREAD DUMP SYMPTOM HERE>

Steps (use REST API Browser MCP tools, or REST endpoints with Authorization: Bearer <PAT>):
1. Resolve the endpoint to its operation key (`op`): call `resolve_url` (or `GET /rest/restbrowser/1/catalog/resolve?url=<path>`).
2. Fetch handler details, request/response schemas, handler source, and OSGi service implementations in one shot:
   call `investigate_operation_context` with `op`, `maxLines=400`, `lineNumbers=true` (or `POST /rest/restbrowser/1/code/context` with `X-Atlassian-Token: no-check`).
3. Trace downstream collaborators without JDK/library noise: inspect interfaces via `find_implementations` (`/code/implementations`) and walk domain call/field edges via `traverse_graph` (`preset=domain`, `depth=2`, `/code/graph`). Decompile suspicious classes/methods via `decompile_source` (`/code/source?decompiler=vineflower`, falling back to `cfr` if warnings appear).
4. Check bundle configuration and thread/timeout/filter wiring with `read_bundle_resource` (`/code/resource` on `atlassian-plugin.xml`, Spring XML, or `.properties`).
5. Summarize root-cause hypotheses with exact class/method/line references, lock/I-O/query bottlenecks, and safe remediation steps without executing mutating REST calls.
```

### Explore an Undocumented Endpoint & Generate Payload

```text
Document and construct a valid request for an undocumented or internal REST endpoint on https://example.invalid/jira.
Search term or URL: <PASTE KEYWORD OR /rest/... URL HERE>

1. Find candidate operations with `search_operations` (`GET /rest/restbrowser/1/catalog/operations?q=...&format=markdown`) or `export_module_openapi` (`/catalog/openapi?module=...`).
2. Inspect access requirements (`access` annotation), parameters, and synthesized request/response JSON Schema + example payload via `get_dto_schema` (`/code/schema?op=...`).
3. Read validation branches in the handler via `decompile_source` (`/code/source?op=...&scope=method&lineNumbers=true`).
4. Return required permissions, exact query/path/body fields, edge-case constraints, and a ready-to-run `curl` command.
```

### Trace an Error Message to Its Plugin & Handler

```text
Trace an unexpected REST error message, status code, or response header on https://example.invalid/jira back to its owning plugin and Java handler.
Error text or identifier: <PASTE ERROR STRING / LOG FRAGMENT HERE>

1. Search constant-pool string and UTF-8 literals across active OSGi bundles via `grep_bytecode` (`GET /rest/restbrowser/1/code/grep?q=...`).
2. Inspect matching classes and their owning plugin via `inspect_class` (`/code/class?outline=true`) and `inspect_plugin` (`/code/plugin?view=compact`).
3. Find upstream REST handlers calling the helper with `find_callers` (`/code/callers`) and cross-reference via `search_operations` (`usesClass=...`).
4. Explain the exact condition triggering the error and which REST endpoints can reach it.
```

## UI Deep Links & Dual-MCP Workflow with Live Scalpel

- **Direct browser deep links**: `?op=<key>` opens an operation, `?supportedOnly=1` enables the supported API filter, and sysadmin links `?class=<fqcn>&method=<name>&line=<n>&fromBundle=<bundleId>` open `SourceDialog` directly on that class/line (handy when jumping from Live Scalpel flame graphs or stack frames).
- **Companion integration (`liveScalpel` / `nodeId`)**: When Live Scalpel is enabled on the node, sysadmin catalog responses set `liveScalpel: true`, the UI header displays the cluster `nodeId` badge plus **Trace in Scalpel**, and `/plugins/servlet/rest-api-browser/admin` emits a ready-to-copy dual-MCP client configuration pairing `rest-api-browser` (static REST/bytecode intelligence) with `live-scalpel` (live thread/CPU/allocation traces).
- **Zero-dependency Python CLI**: [`client/rab.py`](../client/rab.py) wraps all catalog, code, and MCP operations (`python client/rab.py --url ... --token ... brief`, `search`, `resolve`, `context`, `source`, `impls`, `callers`, `grep`, `mcp`).

## Implementation Map

- REST resources & auth: [`CatalogResource.java`](../src/main/java/com/atlassian/labs/restbrowser/rest/CatalogResource.java), [`CodeResource.java`](../src/main/java/com/atlassian/labs/restbrowser/rest/CodeResource.java), [`OpenApiResource.java`](../src/main/java/com/atlassian/labs/restbrowser/rest/OpenApiResource.java), [`McpResource.java`](../src/main/java/com/atlassian/labs/restbrowser/rest/McpResource.java), [`EchoResource.java`](../src/main/java/com/atlassian/labs/restbrowser/rest/EchoResource.java), [`RestAuth.java`](../src/main/java/com/atlassian/labs/restbrowser/rest/RestAuth.java)
- Servlets: [`LlmsTxtServlet.java`](../src/main/java/com/atlassian/labs/restbrowser/servlet/LlmsTxtServlet.java), [`AdminIntroServlet.java`](../src/main/java/com/atlassian/labs/restbrowser/servlet/AdminIntroServlet.java) (plus buffered rendering in [`RequiresLoginServlet.java`](../src/main/java/com/atlassian/labs/restbrowser/servlet/RequiresLoginServlet.java))
- Catalog queries, Markdown & OpenAPI export: [`CatalogQuery.java`](../src/main/java/com/atlassian/labs/restbrowser/catalog/CatalogQuery.java), [`OpenApiExporter.java`](../src/main/java/com/atlassian/labs/restbrowser/catalog/OpenApiExporter.java), [`AgentMarkdown.java`](../src/main/java/com/atlassian/labs/restbrowser/catalog/AgentMarkdown.java), [`OperationSource.java`](../src/main/java/com/atlassian/labs/restbrowser/catalog/OperationSource.java)
- Bytecode & OSGi inspection: [`ClassFileInspector.java`](../src/main/java/com/atlassian/labs/restbrowser/inspect/ClassFileInspector.java), [`ClassGraphTraverser.java`](../src/main/java/com/atlassian/labs/restbrowser/inspect/ClassGraphTraverser.java), [`DtoSchemaInspector.java`](../src/main/java/com/atlassian/labs/restbrowser/inspect/DtoSchemaInspector.java), [`OsgiImplementationFinder.java`](../src/main/java/com/atlassian/labs/restbrowser/inspect/osgi/OsgiImplementationFinder.java), [`OsgiBundleResourceReader.java`](../src/main/java/com/atlassian/labs/restbrowser/inspect/osgi/OsgiBundleResourceReader.java), [`OsgiBytecodeScanner.java`](../src/main/java/com/atlassian/labs/restbrowser/inspect/osgi/OsgiBytecodeScanner.java)
