# Playwright E2E Testing Guidelines for Agents

Rules and conventions for writing and maintaining Playwright tests in [src/test/product/e2e/](../src/test/product/e2e/fixtures.ts)
against real Jira Data Center and Confluence Data Center instances. Read [GUIDELINES.md](GUIDELINES.md) alongside this
file before changing product tests or UI test hooks.

---

## 1. Where a test belongs (test pyramid)

Put each check at the lowest layer that genuinely exercises the behaviour:

- **JUnit (`src/test/java`) & Vitest (`src/main/frontend/src/core/*.test.ts`, `src/main/frontend/src/ui/*.test.tsx`)**:
  pure frontend logic, JSON formatting/redaction, OpenAPI synthesis, bytecode/DTO inspection, Preact component state,
  and keyboard/focus unit behaviour with mocks. Fast and hermetic — prefer these first.
- **Playwright E2E (`src/test/product/e2e/*.spec.ts`)**: cross-stack flows against real Jira and Confluence servers —
  Atlassian page decorators, auth routing, full-screen shell hiding, real product catalogs, live `GET` requests,
  downloaded artifacts, multi-overlay keyboard/focus choreography, tabbed decompiler/code intelligence panels, and live
  `/rest/restbrowser/1/*` + `/mcp` contracts.
- **Zero-dependency CDP scripts ([src/test/product/ui.js](../src/test/product/ui.js), [src/test/product/ui_next.js](../src/test/product/ui_next.js), [src/test/product/cdp.js](../src/test/product/cdp.js))**:
  kept for restricted/offline hosts that only have Node 22+ and Chrome/Edge without npm packages. Do not delete or
  break `cdp.js` / `ui.js` / `ui_next.js`, and build new modular E2E specs in Playwright.

---

## 2. Harness setup and repository constraints

- **Always import from `./fixtures`**: write every spec with `import { expect, openNewUi, openOperation, test } from './fixtures';`
  so tests inherit `product`, `rabApi`, `rabPage`, URL resolution, selective Basic auth routing, and error gating. Never
  import `test` directly from `@playwright/test` in spec files.
- **Keep [package.json](../src/test/product/package.json) CommonJS**: never add `"type": "module"`. The fallback
  scripts (`ui.js`, `ui_next.js`, `cdp.js`) load cleanly via CommonJS `require('./cdp')` inside the same directory.
- **Keep [tsconfig.json](../src/test/product/tsconfig.json) TypeScript 7 compatible**: do not set
  `"moduleResolution": "node"` (removed in TypeScript 7). `"module": "commonjs"` resolves `@playwright/test` and Node
  types cleanly.
- **Use offline browser discovery**: [playwright.config.ts](../src/test/product/playwright.config.ts) picks up system
  Chrome or Edge via `RAB_BROWSER` or OS default paths (or `channel: 'chrome'`). Install npm dependencies without
  downloading browser binaries:
  ```bash
  cd src/test/product && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
  ```
- **Respect serial runner defaults**: `playwright.config.ts` runs with `workers: 1`, `retries: 0`, `timeout: 90_000`, and
  `expect.timeout: 15_000`. Do not mask flakiness by bumping `retries`; fix the test or selector so it passes cleanly on
  the first run.
- **Keep generated and private artifacts out of git**: never commit `src/test/product/node_modules/`, `test-results/`,
  `playwright-report/`, `shots/`, private host names, accounts, customer names, or screenshots.

---

## 3. Atlassian Data Center rules (Jira & Confluence)

### Auth routing: never attach Basic auth to static resources

Never set `Authorization` globally in `extraHTTPHeaders` on `BrowserContext` or Playwright `use`. Sending Basic
credentials on static CSS/JS/web-resource requests causes Jira and Confluence decorators to drop the user session
mid-load. [fixtures.ts](../src/test/product/e2e/fixtures.ts) attaches Basic auth in `rabPage` via `context.route('**/*', ...)`
strictly on **same-origin** requests whose `resourceType()` is `document`, `xhr`, or `fetch`.

For direct HTTP/REST/MCP tests that do not drive the browser UI, use `rabApi` (`APIRequestContext`), which scopes the
header cleanly to direct API calls (see [agent-api-and-mcp.spec.ts](../src/test/product/e2e/agent-api-and-mcp.spec.ts)).

### Context paths: always use `product.url(...)`

Atlassian products commonly mount under a context path (`/jira`, `/confluence`). Never pass leading-slash paths raw to
`page.goto('/plugins/...')`: Playwright resolves a leading slash relative to the origin root and strips `/jira` or
`/confluence`. Always pass paths through `product.url('/...')`:

```ts
await rabPage.goto(product.url('/plugins/servlet/rest-api-browser/admin'));
```

### Never execute mutating requests against real instances

Real Jira/Confluence test instances may be shared environments.
- Only click **Send** on idempotent, read-only operations (`product.search` -> `GET`, e.g., `api/2/serverInfo` or
  `api/user/current`).
- When verifying write forms (`POST`/`PUT` Body tab, **Generate example**, DTO synthesis, prefill), assert the form and
  generated JSON value and verify **no request was sent** (`await expect(rabPage.getByTestId('response')).toHaveCount(0)`),
  as done in [catalog-and-request.spec.ts](../src/test/product/e2e/catalog-and-request.spec.ts).

### Make specs work across both Jira and Confluence

- Prefer `product` (`ProductProfile`) fields (`search`, `title`, `coreName`, `coreRe`, `answerRe`, `methodName`) or
  discover an eligible operation dynamically via `rabApi` from `/rest/restbrowser/1/catalog` and
  `/rest/restbrowser/1/catalog/index/{hash}` instead of hardcoding a single product's REST path.
- Account for Confluence 10's missing `txw2`: in Classic WADL UI, Confluence may show `#rab-wadl-fallback` instead of
  `#searchTextResults li a` when public WADLs fail (see [admin-intro-and-classic.spec.ts](../src/test/product/e2e/admin-intro-and-classic.spec.ts)).

---

## 4. Locators: what to use and what to avoid

Follow this locator priority strictly:

1. **Test IDs and semantic `data-*` attributes** (best for Preact UI):
   - Use `page.getByTestId('send')`, `dlg.getByTestId('source-panel-callers')`, or attribute-scoped selectors when
     disambiguating rows (`page.locator('[data-testid="op"][data-method="GET"][data-path="..."]')`).
   - If a new interactive Preact control needs a Playwright test and has no durable `data-testid` or accessible role,
     add a concise `data-testid` in `src/main/frontend/src/ui/` instead of writing a structural CSS selector in the spec.
2. **Accessible roles and names** (prefer within a clear scope when tab labels repeat):
   - e.g., `rabPage.getByRole('tab', { name: /^Pretty/ })`, `rabPage.locator('.rab-n-request [role="tab"]', { hasText: 'Java' })`.
3. **Stable semantic IDs on Classic / server-rendered pages**:
   - e.g., `#rab-admin-intro`, `#rab-open-fullscreen`, `#rab-mcp-config`, `#rab-prompt-stuck`, `#searchField`,
     `#publicOnlyFilter`, `#rab-wadl-fallback`.

### Locator anti-patterns to avoid

- **Unscoped strict-mode collisions**: Confluence exposes both `GET` and `PUT` for `api/user/current`. Matching only by
  `data-path` fails strict mode. Always include `[data-method="..."]` when selecting an operation row, and reserve
  `.first()` for explicitly sampling a list (e.g., first annotation token or first bundle file item).
- **`.or(...)` across CSS-hidden DOM nodes**: Classic UI renders both `#searchTextResults` and `#rab-wadl-fallback` in
  the DOM while toggling `ng-hide`, so `publicItems.or(fallbackBox)` can fail strict mode when both match. Wait for a
  clear settled marker (`#rab i` containing `all the APIs`), then branch on `await publicItems.count()`.
- **Structural/CSS/XPath chains**: avoid `div > div:nth-child(3) > button`, XPath selectors, or internal layout classes.

---

## 5. Waiting, assertions, and UI interactions

### Use web-first auto-retrying assertions

Always use `await expect(locator)...` matchers (`toBeVisible`, `toBeHidden`, `toHaveText`, `toContainText`, `toHaveValue`,
`toHaveAttribute`, `toHaveCount`, `toBeFocused`, `toBeChecked`, `not.toContainText`) with bounded timeouts where initial
product boot/decompilation takes longer (`openNewUi` waits up to `60_000` / `90_000`).

### Distinguish CSS-hidden from detached DOM

- **CSS-hidden elements** stay in the DOM: assert `await expect(rabPage.locator('#header')).toBeHidden()` when verifying
  the product header is hidden in full-screen mode.
- **Unmounted Preact overlays/previews/menus** leave the DOM when closed: assert
  `await expect(preview).toHaveCount(0)` or `await expect(dlg).toHaveCount(0)`.

### Avoid brittle waits and race conditions

- **Never use `page.waitForTimeout(...)`**: hardcoded sleeps slow down passing suites and flake when Jira/Confluence or
  decompilation runs slightly slower.
- **Never use `page.waitForLoadState('networkidle')`**: Jira and Confluence Data Center keep analytics, polling, and
  long-lived background requests active; wait on specific UI markers (`search` visible + `status` contains `operations`)
  instead.
- **Never inspect one-shot state before an async UI settles**: avoid `expect(await loc.isVisible()).toBe(true)`. (One-shot
  `page.evaluate(...)` DOM geometry reads such as `documentElement.scrollHeight` are fine *after* `openNewUi` has settled.)
- **Attach event listeners before clicking**: for downloads (response JSON, OpenAPI 3.1 export) or popups, wrap
  `waitForEvent` and the click in `Promise.all`:
  ```ts
  const [download] = await Promise.all([
    rabPage.waitForEvent('download'),
    rabPage.getByTestId('download').click(),
  ]);
  ```
- **Wait out intermediate loading labels**: in `SourceDialog` panels ([decompiler-and-intel.spec.ts](../src/test/product/e2e/decompiler-and-intel.spec.ts)),
  assert `not.toContainText('Scanning OSGi bundles…')`, `not.toContainText('Searching callers…')`, or
  `not.toContainText(/^Loading /)` before checking contents or sending `Escape`.
- **Keyboard & focus tests**: explicitly clear/assign focus (`blur()` before pressing `/`, or `search.focus()` before
  `Escape`), assert `await expect(search).toBeFocused()`, and verify stacked `Escape` closes the innermost layer first
  (resource preview closes while source code stays open; next `Escape` minimizes `SourceDialog` and keeps `classes-tab-count`
  at `2`).

---

## 6. Isolation, error gating, and debugging

- **Keep every `test(...)` standalone**: each test must pass on its own (`npx playwright test -g "<title>"`) and leave
  no modified product state behind.
- **Split API vs. UI coverage**: use `rabApi` in [agent-api-and-mcp.spec.ts](../src/test/product/e2e/agent-api-and-mcp.spec.ts)
  for HTTP discovery (`llms.txt`, `llms-full.txt`, OpenAPI 3.1), `ETag` `304`, and MCP JSON-RPC calls. Reserve `rabPage`
  for behaviour that needs a browser DOM.
- **Do not weaken `rabPage` error gates**: [fixtures.ts](../src/test/product/e2e/fixtures.ts) asserts empty plugin
  `pageerror` and unexpected `>= 400` plugin response lists in fixture teardown. If a new negative test intentionally
  triggers an expected plugin 4xx/409 response (like starting a non-startable module), add only a narrow URL/status filter
  in `fixtures.ts` rather than silencing failures globally.
- **Skip truthfully, never `return` silently**: if a catalog lacks a required candidate (e.g., no JSON DTO write op), call
  `test.skip(!dtoOp, 'No JSON DTO body operation found in this catalog')` so the report records the skip accurately.
- **Debug interactively instead of guessing**:
  - Watch Chrome/Edge live: `npm run test:headed` or `RAB_HEADED=1 npm test`
  - Playwright interactive UI: `npm run test:ui`
  - Single spec or test: `npx playwright test e2e/catalog-and-request.spec.ts -g "Pretty Wrap"`
  - Inspect failed trace/report: `npx playwright show-trace test-results/<dir>/trace.zip` and `npm run report`

---

## 7. Quick reference: what to avoid

| Avoid | Why it breaks | Do instead |
|---|---|---|
| Adding `"type": "module"` to [package.json](../src/test/product/package.json) | Breaks CommonJS `require('./cdp')` in `ui.js` & `ui_next.js` | Leave `"type"` unset in `src/test/product/package.json` |
| Setting `"moduleResolution": "node"` in [tsconfig.json](../src/test/product/tsconfig.json) | Invalid under TypeScript 7 (`tsgo`) | Keep `"module": "commonjs"` without `moduleResolution` |
| Downloading Playwright browsers on offline hosts | Fails behind air-gapped/corporate networks | Install with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install` |
| Global `extraHTTPHeaders: { Authorization }` on `BrowserContext` | Product decorators drop the session on static resources | Use `rabPage` (`context.route` on `document`/`xhr`/`fetch`) |
| `page.goto('/plugins/...')` without `product.url(...)` | Drops `/jira` or `/confluence` context paths | Always call `product.url('/...')` |
| Clicking **Send** on `POST`/`PUT`/`DELETE` ops in live products | Mutates shared Jira/Confluence state | Test body synthesis/validation and assert `response` count `0` |
| Hardcoding single-product paths when cross-product works | Fails on Confluence vs. Jira | Use `product` (`ProductProfile`) or inspect `/catalog` via `rabApi` |
| `page.waitForTimeout(...)` or `waitForLoadState('networkidle')` | Flaky/slow; DC background polling prevents `networkidle` | Use web-first `expect(locator)` assertions on UI state |
| Non-retrying `expect(await loc.isVisible()).toBe(true)` | Races with Preact/Angular rendering | `await expect(loc).toBeVisible()` |
| `locA.or(locB)` across `ng-hide` / CSS-hidden nodes | Strict mode sees multiple matching DOM nodes | Wait for settled state, check `count()`, then assert branch |
| `getByTestId('op')` by `data-path` alone | Ambiguous when multiple HTTP methods share a path | Match `[data-testid="op"][data-method="..."][data-path="..."]` |
| Clicking a download button before starting `waitForEvent` | Misses fast download events | `Promise.all([rabPage.waitForEvent('download'), btn.click()])` |
| Disabling `rabPage` `pageerror` / HTTP error assertions | Hides real plugin runtime regressions | Keep teardown assertions intact; allowlist only exact negative URLs |
| Early `return` on missing optional catalog data | Reports false pass instead of skipped precondition | Use `test.skip(condition, reason)` |
| Committing `node_modules/`, reports, or private hosts/accounts | Pollutes public repository / leaks secrets | Keep `.gitignore` clean and check hygiene before committing |

---

## 8. Agent checklist before committing Playwright changes

1. Typecheck specs without running browsers: `cd src/test/product && npm run typecheck`
2. If you touched the fallback runner, syntax-check it: `node --check src/test/product/cdp.js` (and `ui.js` / `ui_next.js`)
3. Run against both products when instances are available:
   - `RAB_PRODUCT=jira npm test` (and watch live changes with `RAB_HEADED=1`)
   - `RAB_PRODUCT=confluence npm test`
4. Verify no private hostnames, accounts, customer names, screenshots, or untracked build artifacts (`node_modules/`,
   `test-results/`, `playwright-report/`, `shots/`) are staged.
5. Run `mvn -B package` whenever you also added `data-testid` hooks or changed `src/main/**`.
