# New UI: plan

Status: step 0 (spike) done: the Jersey runtime model works on Jira 11.3.13 and Confluence 10.2.20 and matches every
WADL that loads. Step 1 is implemented (backend, `/catalog` API, Preact page, `src/test/product` checks). Draft,
reviewed once (Gemini 4 Neon, notes worked in). The classic AngularJS UI stays at its URL, unchanged; the new UI gets
its own page.

**[verify]** marks an assumption about the Atlassian platform that the step 0 spike confirms or refutes.

## 1. Goals

- **Systemic and elegant**: few concepts, each with one home.
- **Extensible**: new description sources (OpenAPI, class scanning), new products and new features plug in without
  rework. A new backend REST API is part of the design.
- **No lags** with ~200 REST modules and ~6,600 resources (Jira 11): first paint, search, switching endpoints,
  large responses.

Facts that shape it:
- **WADLs carry structure only.** On a production-like Jira 11.3.13 (207 REST modules), they contain no
  descriptions or examples: 0 of 7,866 resources and no methods are documented.
- **Confluence 10.2 can't describe 26 of its REST modules as WADL**, because it lacks a JAXB jar.
- **The classic UI is slow to start.** It fetches and parses every WADL in the browser on each page load.

## 2. Architecture

The server owns a normalized **catalog** of the instance's REST API, built in memory and kept current by plugin
events. The browser never fetches or parses a WADL: it reads the catalog and sends requests.

Four concepts:

| Concept | Home | Job |
|---|---|---|
| Discovery | backend | which REST modules exist and who provides them (today's `RestBrowserServlet` logic) |
| Source | backend interface | describe one module's operations |
| Catalog | backend, served by REST | merged, normalized, immutable snapshot; the only thing the UI reads |
| Stores | frontend | the catalog, requests and the user's own data, behind three small interfaces the UI uses |

```
 BACKEND (per node, in memory)                                    BROWSER
 Discovery --> Sources (ordered) --> CatalogBuilder --> Snapshot --REST--> CatalogStore  RequestRunner
 (plugins,     JerseyModelSource     per module         (JSON +            UserStore     Router
  events,      later: ClassScan,                         hash)                  |
  adapters)    OpenApi, Wadl                                                  Shell (UI)
```

### 2.1 Backend

**Discovery**: today's `PluginAccessor` + reflection logic, moved out of the servlet into a `ModuleDiscovery` bean.
It adds two facts per module:
- **origin**: product, bundled or user-installed, via `PluginMetadataManager` **[verify]**, falling back to the
  vendor.
- **stability**: supported, internal or app.

Product differences live behind one small **`ProductAdapter`** per product:
- the stability path-prefix rules, as data, moved from `rest_resources_service.js`;
- later, context-path, permission and decorator quirks.

This keeps "if Jira" checks out of the rest of the code.

**Sources**, behind one internal interface, ordered, Spring beans:

```java
interface SpecSource {
    String id();                                  // "jersey", "wadl", ...
    Optional<ModuleSpec> describe(RestModule m);  // empty = not mine; exception = recorded failure for this module
}
```

The builder asks the sources in order. In the first version there is one source, so each module records the
`source` that described it. When a second source arrives, the structural source owns paths and parameters, and
OpenAPI owns descriptions and schemas.

A module is `ok` if one source succeeded, otherwise `failed`, with a short reason code. Details are logged and shown
to admins only.

**Rules for every source:**
- **Return plain data only.** Copy everything into strings and records inside `describe()`. The catalog, errors and
  logs never keep a `Class`, `Method`, Jersey `Resource` or `Plugin` reference. Holding one would keep a disabled or
  upgraded app's classloader in memory.
- **Isolate each module** with a timeout, so a hung or broken app can't stall the build.

1. **JerseyModelSource** (primary). It reads each module's Jersey runtime resource model (`Resource`,
   `ResourceMethod`, `Parameter`) by reflection, as the servlet already reads `getBasePath`.
   - **What it gives:** this is the model the WADL generator walks, so it yields exactly what is served: paths,
     methods, parameters, defaults, media types. It needs no JAXB.
   - **What the WADL never had:** from the Java handler method come the access annotations (`@AdminOnly`,
     `@AnonymousSiteAccess`...), `@Deprecated`, and the request body's Java type.
   - **[verify]**
     - how to get from the module descriptor to its Jersey `ResourceConfig`;
     - whether lazily started REST modules must be initialized first;
     - whether sub-resource locators (methods with only `@Path`, returning another resource) appear in the model or
       must be expanded;
     - whether any module still runs on REST v1 (`javax.ws.rs`, a different model).
2. **Later, as additional sources**, each only when the Jersey model falls short somewhere:
   - **ClassScanSource:** the first fallback. It reads the JAX-RS annotations in an app's bundle classes with ASM,
     without loading them. It doesn't depend on Jersey internals, and it also covers the modules whose WADL fails.
     It can miss resources registered at runtime, so it complements the Jersey source rather than replacing it.
   - **WadlSource:** last resort. Its in-process route (a synthetic request through the filter chain) is brittle,
     and its loopback route breaks behind proxies. WADLs also lack the access annotations and body types, and some
     fail on Confluence.
   - **OpenApiSource:** for products or apps that ship a spec **[verify any does at runtime]**. It fills the detail
     tier (descriptions, schemas, examples).
   - **JsonRpcSource:** if any product brings JSON-RPC back. Today none provides it.

**Catalog cache**:
- **Per node, in memory, no cluster replication.** Every node derives the same catalog from the same plugins.
- **Stored as serialized JSON** plus a small summary. Pre-gzipped bytes only if the spike shows REST JSON isn't
  compressed.
- **Built on first use** by one background thread, module by module, with a short pause between modules (thread
  priority alone does little on Linux). Not at product start, so a tool few people open doesn't initialize 207
  REST modules on every node.
- **During the first build**, the published snapshot is updated in batches (every few seconds), not after every
  module. A final snapshot follows when the build is complete.
- **Plugin events** (enabled, disabled, upgraded, module events) mark only the affected modules stale. After a
  debounce, those are rebuilt and the hash changes.

**The hash is the same on every node for the same catalog.** It is computed over sorted content plus this plugin's
version and the catalog format version. So a node behind a different load balancer route agrees, and an upgrade of
this plugin always changes it.

**REST API** (new REST module `/rest/restbrowser/1`; `devtools/1` stays for the classic UI):

```
GET  /catalog                        small, per user, ETag = catalog hash (304 when unchanged), no-cache
     { product{name,version,build}, hash, complete, progress{done,total},
       modules[{ id, path, baseUrl, origin, stability, source, state: ok|pending|failed, reason?, opCount,
                 plugin{key, name, version (admins only)}, error (admins only) }] }
GET  /catalog/index/{hash}           every operation, compact, user-independent
POST /catalog/refresh[?module=]      sysadmin, XSRF-checked: rebuild now
```

**Caching of `index/{hash}`**:
- **The node's current complete hash:** `Cache-Control: private, max-age=31536000, immutable`. `private`, so no
  proxy ever serves it to someone else.
- **The node's current partial hash** (first build): `private, no-cache`.
- **Any other hash:** `404` with `no-store`. The client fetches `/catalog` again and follows the new hash. This also
  covers a request landing on another node.

**Access**: logged-in users only, like the page. The catalog shows every endpoint, as the WADLs already do. Java
handler names, plugin versions and error details are for admins only.

The index holds everything needed to navigate, search **and render the request form**. With no docs in the WADLs,
that is nearly all there is.

**Deferred**: `GET /catalog/detail/{module}/{hash}` (descriptions, schemas, examples). It gets built together with
the first source that has such data (OpenAPI), so richer data never makes the index bigger.

### 2.2 Shared model

```
Catalog   { product, hash, modules[] }
Module    { id, path, baseUrl, origin, stability, plugin, source, state, hash }
Operation { key, moduleId, method, pathTemplate, consumes[], produces[], handler? (admins), access?, deprecated?,
            params[] { name, in: path|query|header|matrix|form, type, required, default?, options[]?, repeating },
            body?    { javaType?, schema? } }
```

- **Operation key**: `moduleId:METHOD:path`, with every template written as `{}`
  (`jira-rest:GET:api/2/issue/{}/comment`). Two modules can serve the same path, so the module is part of the
  key. When one path has several handlers for the same method, told apart by media type or by a regular
  expression in the template, the key gets a suffix (`#json`, `#multipart`, or a counter). It's the identity for
  deep links, history and pins, and it doesn't depend on how a source names its parameters.
- **Response types and schemas are not modelled.** Most Atlassian handlers return a plain `Response`, so they would
  almost always be empty. They come back with a source that knows them.
- **Shaped like OpenAPI**, so an OpenAPI source maps in directly and an OpenAPI export is a serializer.
- **One definition**: Java records on the server, and about 40 lines of hand-written TypeScript types. One golden
  JSON file, written by a Java test and read by a TypeScript test, catches drift.

### 2.3 Frontend

TypeScript and Preact, one bundle and one CSS file, built by Vite from Maven with a pinned Node version. Nothing
built is committed. The page is its own servlet page (`/plugins/servlet/restbrowser/next`), with no inline data
(CSP).

Three stores and a router, wired directly into the shell. There is no plugin mechanism for frontend features:
with a handful of first-party features it would only add indirection.

- `CatalogStore`:
  - Loads the summary and the index.
  - Answers `search`, `get` and `match(url)`. The route matcher behind `match` is built on first use, not at boot.
  - Nothing else knows the wire format.
  - **Progressive loading**: while `complete` is false, it polls `/catalog` with backoff (1, 2, 4 s..., paused
    while the tab is hidden) and follows a changed hash.
- `RequestRunner`:
  - Builds the request: URL encoding; path, query, header, matrix and form placement; `X-Atlassian-Token` on
    writes.
  - Sends it with `fetch`, same origin, abortable. Switching operation aborts the running request.
  - **Reads the body as a stream with a byte cap.** Above the cap it offers a download instead of building a
    string.
  - Recognizes a login page or a `401` with `X-Seraph-LoginReason` as "session expired".
- `UserStore`:
  - History, pins and remembered values per instance and user, in browser storage behind an async interface. A
    server-backed version can replace it later.
  - **Never stores `Authorization`, `Cookie` or other credential headers**, and stores response bodies truncated
    (or not at all).
- `Router`: `?op=<key>` plus prefill values namespaced by location (`path.x=`, `q.x=`, repeatable
  `q.expand=a&q.expand=b`), with the History API. Deep links never send a request by themselves.

| New thing | Where it goes | Elsewhere |
|---|---|---|
| OpenAPI, class scanning | a `SpecSource` | nothing changes |
| Body skeleton from the Java body type | the Jersey source fills `body.schema`; a button in the Body tab | nothing changes |
| New product | a `ProductAdapter` | nothing changes |
| History, Copy as curl, remembered values, link-following | shell code using the stores and `match` | nothing changes |
| Snapshot diff, OpenAPI export | read two `index` documents | nothing changes |

## 3. UX

The unit is the **operation** (method + path). Everything is listed: supported modules come first and rank first in
search, and one click filters to them. Nothing is hidden by default.

```
+-------------------------------------------------------------------------------------------------+
| [product header]                                             REST API Browser   [Classic UI]    |
+-----------------------------+-------------------------------------------------------------------+
| [ search: post issue      ] | GET  api/2/issue/{issueIdOrKey}        Supported · Jira  [Copy curl]|
| [Supported only] [GET][POST]| https://host/rest/api/2/issue/PROJ-42?fields=summary [Copy] [Send]|
| [PUT][PATCH][DEL][Other]    +-------------------------------------------------------------------+
|-----------------------------| [Params 3] [Body] [Headers] [History 4]                           |
| v Jira: api/2 (412)         |  issueIdOrKey *  string   [ PROJ-42             ]   path           |
|    GET    /issue/{id}     < |  fields           string   [ summary            ]   query          |
|    PUT    /issue/{id}       |  expand           string   [                    ]   query          |
|    DELETE /issue/{id}       |  automatic: Accept: application/json                               |
|    POST   /issue            +-------------------------------------------------------------------+
| > Jira: agile/1.0 (96)      | 200 OK  142 ms  18.4 KB      [Pretty] [Raw] [Headers]  [find...]   |
| > Bundled: Tempo (31)       | { "id": "10421",                                                  |
| > Installed: my-app (19)    |   "self": "https://host/rest/api/2/issue/10421",                  |
|   (virtualized list)        |   "fields": { ... }                                               |
+-----------------------------+-------------------------------------------------------------------+
```

- **Layout:**
  - fills the viewport under the product header, so there are no double scrollbars;
  - both dividers are draggable;
  - the window may be as narrow as 1024 px.
- **Left pane: two modes.**
  - **Browsing** (empty search box): a list grouped by module. Product modules come first, then bundled apps, then
    installed apps. Groups are collapsible and show counts.
  - **Searching:** a flat list of operations, ranked with supported ones first and path-segment matches first.
    Each row carries a small module and stability badge.
  - Both modes are one virtualized list of rows (module rows and operation rows) with a fixed row height, so the
    arrow keys and virtualization share one index.
  - **Search:** `/` to focus; several words AND-ed across method, path and app; no query syntax.
  - **Filters:** supported only; method (GET, POST, PUT, PATCH, DELETE, Other).
- **Right pane, top:**
  - the operation header with stability and access lozenges and Copy as curl;
  - the **live URL**, which updates as parameters change, with Copy URL.
- **Request editor tabs:**
  - **Params:** typed inputs, required ones marked, defaults shown. Empty optional parameters are left out of the
    request. A repeating parameter gets one input per value, with "+".
  - **Body:** a textarea with Format and a JSON error indicator. A media type selector (`Content-Type`), filled
    from the operation's `consumes`. Form and multipart bodies are deferred.
  - **Headers:** custom headers and `Accept` (from `produces`). The automatic headers, such as
    `X-Atlassian-Token`, are shown and can be switched off, for testing.
  - **History:** this operation's past requests. Since no WADL documents anything, the call that worked yesterday
    is the best example; one click restores it.
- **Right pane, bottom:**
  - **Response line:** status, time and size.
  - **Content-type views:** JSON gets a pretty view, collapsible and searchable; XML and text get text with find;
    HTML gets a warning plus the source; binary gets Download.
  - **Large bodies:** formatted in a Worker above about 1 MB. Above the byte cap: the start of the body and
    Download.
  - **Tabs:** raw and headers.
- **States:**
  - **No operation selected:** short hints (search, keyboard) and the counts.
  - **No search results:** if "Supported only" hid matches, one click "Include internal and app endpoints".
  - **Catalog still building:** "Indexing 142 of 207 modules" in the list header; admins get Refresh.
  - **Failed module:** a row with the reason; admins can expand the detail.
  - **Session expired:** a banner with a login link, instead of a login page shown as a response.
  - **Request failed** (network or abort): shown in the response area, with the request still editable.
- **Writes are marked:** POST, PUT and DELETE are colored differently, and Send says what it will do.
- **Keyboard:** `/` search, arrows move in the list, Enter opens, Ctrl+Enter sends, Esc cancels a running request.
- **Theme:** only Atlassian design tokens (`--ds-*`) with fallbacks, so light and dark follow the product.
- **Left out:** collections, environments, auth managers, schema-generated forms, code snippets beyond curl, test
  scripts, a request proxy.

## 4. No lags

| Moment | How | Target |
|---|---|---|
| Server, first use on a node | background build; `/catalog` says `complete:false` and which modules are pending; the UI shows what's there and picks up the new hash | never blocks a request |
| Page load | shell from the web-resource cache, paint at once; `GET /catalog` (usually 304); `index/{hash}` from the HTTP cache (immutable) | < 100 ms to a usable list when cached |
| Index to usable | parse ~2-3 MB JSON (~250 KB gzipped) and build search rows | < 100 ms; Worker only if measured slower |
| Search keystroke | linear scan of ~12k precomputed lowercase strings, ranked | 1-3 ms, no debounce |
| List | virtualized, fixed row height | constant |
| Switching endpoint | data already in memory; detail fetched lazily, never blocks the form | one frame |
| Large response | body streamed with a byte cap; Worker formatting above ~1 MB; virtualized rows; above the cap, start + Download | the tab never freezes |

Invalidation is one chain with no time limits: module hash, then catalog hash, then the index URL.

**The JSON viewer is the one hard frontend piece.** It must fold, search and virtualize 10 MB of JSON. The plan is
a flat line model, built in a Worker (each line carries its depth and fold range), rendered by the same virtualized
list. If that proves costly, the fallback is a read-only CodeMirror 6, loaded only when a response is shown.

- **[verify]** Whether a REST resource can set long-lived cache headers on Jira and Confluence. If not, `CatalogStore`
  keeps the index in IndexedDB keyed by hash; nothing else changes.
- **[verify]** Whether REST JSON is gzipped. If not, the resource serves gzipped bytes itself.

## 5. Steps

**Step 0, spike** on Jira 11.3.13 and Confluence 10.2, before any UI. It answers:
- whether the Jersey runtime model can be reached for every module type;
- whether sub-resource locators are included, and whether any module runs on REST v1;
- how long a cold build of all modules takes: CPU, memory, and side effects of initializing lazily started
  modules;
- how many operations there are, the index size raw and gzipped, and operation-key collisions;
- caching and gzip of REST responses;
- whether `PluginMetadataManager` can be imported.

The Jersey source is compared with every WADL that works. Where it can't reach a module, `ClassScanSource` becomes
that module's source; nothing else in the design changes.

**Step 0 results.** Jira 11.3.13: 116 modules, 114 described, 1,754 operations, equal to the WADLs' 1,754; the two
failures are Crowd's `appmanagement` and `usermanagement`, which need application credentials. Confluence 10.2.20:
134 modules, 132 described, including `/rest/api` (183 operations), whose WADL Confluence cannot generate. A cold
build takes under 15 s locally. The product gzips REST JSON, and the immutable cache header survives.

**Before step 1**, in the existing code:
- remove the dead SOAP/JSON-RPC code and the `ewadl` endpoint;
- move discovery into `ModuleDiscovery`;
- set up the Vite build from Maven.

**Step 1, first version, the whole spine with one source:**
- **Backend:**
  - discovery, `ProductAdapter` for Jira and Confluence, `JerseyModelSource`, builder, cache, event invalidation;
  - `/catalog`, `/catalog/index`, `/catalog/refresh`;
  - failed modules with reason codes;
  - Java unit tests, including the golden JSON file.
- **Frontend:**
  - shell, the stores, the two-mode list, search, filters;
  - operation form with live URL, media types, Send/Cancel;
  - response viewer with content-type views and the byte cap;
  - Copy as curl, deep links, History tab, all UI states;
  - tokens, links to and from the classic UI;
  - unit tests for search, route matching and request building.
- **End-to-end:** `src/test/product` gains checks for the new page, including two-node caching on a cluster where
  one is available.

**Then, in this order** (each step independent):
1. Remembered parameter values, paste a URL, link-following in responses (one route matcher).
2. Access and deprecation lozenges; body skeleton from the Java body type; form and multipart bodies.
3. Pins, a history list across operations, observed response shapes.
4. `ClassScanSource` where the Jersey model falls short; `OpenApiSource` together with the detail tier where specs
   exist; `WadlSource` only if both fail somewhere.
5. Catalog snapshot export and diff, OpenAPI export.
6. Server-side `UserStore`, admin settings (who may open it), Bitbucket, Bamboo and Crowd adapters.

## 6. Risks

1. **Reaching the runtime model.** It goes through non-exported platform internals by reflection, and may differ
   between products or break in a platform update.
   - *Mitigation:* spike first; sources are ordered fallbacks behind one interface; failures are per module and
     visible; class scanning is an independent route.
   - *Memory:* sources return plain data only, so no app classloader is ever retained.
2. **Cold build and invalidation in production.** The build may initialize lazily started REST modules; plugin
   events can come in bursts during startup and upgrades; cluster nodes build on their own.
   - *Mitigation:* build on first use only, on one paced thread with a timeout per module; debounce; batched
     snapshots; the `complete` flag; manual refresh; measure in the spike.
   - *Cluster:* nodes compute the same hash, and a mismatch is handled by `404` and a refetch.
3. **Too much machinery for a small plugin.**
   - *Mitigation:* the first version has exactly one source, no detail tier, no frontend plugin mechanism and no
     type generation. Every later step is optional.
   - *Decided deliberately:* the catalog shows every endpoint to any logged-in user, as the WADLs already do.
     Handler names, plugin versions and error details go to admins only.
