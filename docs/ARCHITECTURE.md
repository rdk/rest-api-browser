# Architecture Overview

REST API Browser is an Atlassian Data Center plugin (`Platform 8`: Java 21, Spring JavaConfig, REST v2, Preact + TypeScript)
serving a modern full-screen UI alongside the legacy AngularJS WADL UI, plus AI-agent REST, OpenAPI 3.1, MCP, and CLI
surfaces.

## 1. Module & Source Map

| Layer | Location | Responsibility |
|---|---|---|
| Spring & OSGi wiring | [src/main/java/.../spring/](../src/main/java/com/atlassian/labs/restbrowser/spring/LocalBeans.java) | Imports OSGi services (`PluginAccessor`, `UserManager`, `ApplicationProperties`, etc.), instantiates beans, reads cluster `nodeId` & `liveScalpel` availability reflectively. |
| Catalog build & search | [src/main/java/.../catalog/](../src/main/java/com/atlassian/labs/restbrowser/catalog/CatalogService.java) | `ModuleDiscovery`, `JerseyModelSource` + `JerseyAnnotationSupport` (walks Jersey `ResourceConfig` without WADL), `ProductAdapter`, immutable `CatalogSnapshot` + parity hash, `CatalogQuery` (`briefText`, search, JAX-RS template `resolve`), `OpenApiExporter` (3.1.0 self & per-module specs), and `OperationDetails`. |
| Code intel & decompilation | [src/main/java/.../catalog/OperationSource.java](../src/main/java/com/atlassian/labs/restbrowser/catalog/OperationSource.java) + [inspect/](../src/main/java/com/atlassian/labs/restbrowser/inspect/ClassFileInspector.java) + [decompile/](../src/main/java/com/atlassian/labs/restbrowser/decompile/VineflowerEngine.java) | Single-flight cached bytecode decompilation (Vineflower 1.12.0 default / CFR 0.152 fallback), `ClassTargetResolver`/`OperationTargetResolver`, `ClassMetadataSerializer`, `CodeInvestigationService` + `CodeSearchAndResourceService`, `ClassFileInspector` + `ClassFileDescriptorParser`, `OsgiBytecodeScanner`, `DtoSchemaInspector` + `DtoTypeResolver` + `DtoExampleGenerator`, `ClassGraphTraverser`, OSGi service lookup, and bundle resource reader. |
| REST & MCP endpoints (`/rest/restbrowser/1`) | [src/main/java/.../rest/](../src/main/java/com/atlassian/labs/restbrowser/rest/CatalogResource.java) | `CatalogResource` (`/catalog`, `/catalog/brief`, `/operations`, `/resolve`, `/openapi`, `/index/*`, `/started`, `/refresh`), `CodeResource` (`/code/*` `@SystemAdminOnly`, one-shot `/code/context` with `maxChars`), `McpResource` + `McpProtocolCatalog` (Streamable HTTP JSON-RPC 2.0, 16 tools with `maxChars`, 5 static resources incl. `rab://catalog/brief`, 4 URI templates, up to 4 prompts), `OpenApiResource`, `EchoResource`, `RestAuth`. |
| Servlets & Classic UI | [src/main/java/.../servlet/](../src/main/java/com/atlassian/labs/restbrowser/servlet/AdminIntroServlet.java) | `/plugins/servlet/rest-api-browser` (full-screen Preact shell), `/admin` (`AdminIntroServlet` with AUI decorator, single & dual Live Scalpel MCP configs), `/llms.txt` & `/llms-full.txt`, and legacy Classic AngularJS WADL UI at `/plugins/servlet/restbrowser`. |
| Preact UI (`core/`, `lib/`, `ui/`) | [src/main/frontend/src/](../src/main/frontend/src/ui/App.tsx) | `core/` holds pure state/API/routing (`catalog.ts`, `details.ts`, `codeintel.ts`, `router.ts` incl. `?class=` & `?supportedOnly=1` + `popstate`, `prefill.ts`, `search.ts`); `lib/` holds lossless JSON formatter, Java tokenizer & formatter (`javaformat.ts` + `javaformat-scan.ts`), HTTP redaction, overlay/focus helpers; `ui/` renders Preact views (`TopBar`, `Sidebar`, `Operation`, `ResponseView`, `JavaTab`, `SourceDialog` + `SourceDialogChrome`, `CodeIntelPanels` + `CodeIntelSearchPanels` + `BundleResourcePanels`) styled via `ui/styles/` (incl. `java.css` & `source-dialog.css`). Built by Vite into `target/classes/assets/next/`. |
| Python Agent Client & CLI | [client/rab.py](../client/rab.py) | Zero-dependency Python 3.9+ stdlib CLI (`brief`, `search`, `resolve`, `context`, `source`, `schema`, `impls`, `callers`, `grep`, `graph`, `resource`, `plugin`, `mcp`) with Bearer PAT/Basic auth, sticky cookies, XSRF headers, and `--max-chars`. |

## 2. Testing Pyramid

1. **Java unit tests (`src/test/java`)**: `mvn -q -B test-compile -Dskip.npm -Dskip.installnodenpm && mvn -q -B surefire:test` (~7s; use `mvn -B package -Pfast` for quick deploy JARs)
2. **Frontend lint, typecheck & Vitest (`src/main/frontend`)**: `npm run lint:all && npx tsc --noEmit -p . && npx vitest run` (~3s)
3. **Python CLI tests (`client/test_rab.py`)**: `python -B -m unittest discover -s client -v` (~2s)
4. **Offline browser mock E2E (`src/test/harness/` + `src/test/product/e2e-mock/`)**: loads built `target/classes/assets/next/next.js` against deterministic `mock.js` via `cd src/test/product && npm run typecheck && npm run test:mock` (runs in CI on release tags via `release.yml` and manual full dispatch via `build.yml`, while push/PR `build.yml` runs fast `mode: fast` unit + lint + CLI checks)
5. **Live Jira / Confluence verification (`src/test/product/`)**: `smoke.py`, `mcp_pat_check.py`, Playwright `e2e/*.spec.ts` (`npm test` or `-g "<spec>"` during feature work), and frozen zero-dependency CDP fallbacks (`ui.js`, `ui_next.js`).

> [!NOTE]
> The original pre-implementation design spike is archived at [NEW-UI-PLAN.md](NEW-UI-PLAN.md).
