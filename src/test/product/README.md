# Real-product checks

End-to-end checks of the REST API Browser on a **real, standalone Jira Data Center** or **Confluence Data Center**
started with the Atlassian Plugin SDK; Jira is the default, see [Confluence](#confluence) for the other. They
complement `mvn verify`, whose integration test (`RestApiBrowserSmokeTest`) runs against the refapp only: the refapp
does not show whether the plugin runs on a product (its REST modules and their WADLs, its decorator, AUI and login, UPM
install).

| File | What it does |
|---|---|
| `product.sh` | Starts, waits for, shows and stops a throwaway Jira or Confluence (`atlas-run-standalone`) in its own work directory and port. |
| `smoke.py` | Installs the plugin jar through UPM and checks it over HTTP: all modules enabled, the page as admin (search field, checkbox, the product's decorator, product name), the decorated admin intro page `/plugins/servlet/rest-api-browser/admin` (launch CTA, agent links, prompt blocks, anonymous redirect), the list of REST modules on the page and **every WADL on it** (falling back to `#rab-wadl-fallback` on Confluence 10 when `txw2` is absent), the plugin's web resources and Angular views, the pretty URL `/restbrowser`, the redirect of an anonymous user to the login page, and no error or stack trace of the plugin in the product's log since the run started. It also checks **the new UI and its catalog API**: the page (`/plugins/servlet/rest-api-browser` and `/next` redirect), the summary (format, hash, ETag, `no-cache`, 304, 401 for anonymous), a complete catalog with at least 95% of the modules ok and the product's core module supported, the index (`immutable`, 404 with `no-store` for a wrong hash), the catalog's operations equal to every loadable WADL's methods, `refresh`, and MCP `resources/*` & `prompts/*`. |
| `mcp_pat_check.py` | Verifies `POST /rest/restbrowser/1/mcp` using **only** `Authorization: Bearer <PAT>` (no cookies, no Basic Auth, no `X-Atlassian-Token`), testing `initialize`, `notifications/initialized`, `ping`, `tools/*`, `resources/*`, `prompts/*`. Creates a temporary 1-day PAT via `/rest/pat/latest/tokens` and revokes it on exit when `--pat` is omitted. |
| `package.json` / `playwright.config.ts` | Playwright Test (`@playwright/test`) runner configured for system Chrome/Edge (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` friendly, `RAB_URL`, `RAB_PRODUCT`, `RAB_HEADED=1`, `RAB_BROWSER`, `RAB_BROWSER_ARGS`), HTML report, and trace-on-failure. |
| `e2e/*.spec.ts` | Modular Playwright specs sharing `e2e/fixtures.ts` (`admin-intro-and-classic.spec.ts`, `agent-api-and-mcp.spec.ts`, `catalog-and-request.spec.ts`, `decompiler-and-intel.spec.ts`) covering Jira and Confluence with per-test JS/HTTP error gating. |
| `ui.js` | Zero-dependency Classic UI check in Edge/Chrome (`cdp.js`, no npm packages): Angular starts, the public APIs load into the sidebar with the product's core REST API among them (Jira's `api/2`), the "Show only public APIs" checkbox is on by default and can be turned off (what `RestApiBrowserSmokeTest` checks on the refapp), or shows the Confluence 10 WADL fallback list when public WADLs fail, search narrows the list, a core resource (Jira's `api/2/serverInfo`) shows its `GET` method and **Send** shows the product's answer, the view shows a resource's description (when no WADL documents one, as on Jira 11, the check sets one in the page), a path parameter's value is URL-encoded in the request (a `GET` of an issue or page that cannot exist); no JavaScript exception from the plugin, no failed request for its own resources, and (when `txw2` is present) at least 95% of the WADLs load. Screenshots in `shots/` (git-ignored). |
| `ui_next.js` | Zero-dependency new UI check (`/plugins/servlet/rest-api-browser`) in Edge/Chrome (`cdp.js`, no npm packages): the catalog loads, the header's base URL (in a new tab) and links (GitHub, releases, the classic UI), its tooltip and pinning it with Alt+P, no product header or footer and nothing to scroll, search, an operation's form (including enabled form-parameter inputs that drive the Body tab and **Generate example** DTO synthesis), **OpenAPI** module export, **Send** and the response viewer (no line numbers in Pretty, **Wrap** toggle, **View full** modal support, the find box at the right of its tab bar, Copy and Download taking what the open tab shows, the response's and the request's headers in a tab each, the browser's headers through the echo resource with cookie values hidden), history, the Java tab and floating tabbed decompiler dialog (method/class/bundle/plugin pages, coloured annotations, Vineflower/CFR switching, resizable method outline, **Impls**/**Callers**/**Grep**/**Files** panels with bundle resource preview, type tooltips, cross-class drill-down, ZIP export, maximize/minimize/close/undo; 404 for an unknown operation), the agent & MCP endpoints (`llms.txt`, `llms-full.txt`, OpenAPI 3.1 `/openapi`, `/openapi.json`, `/catalog/openapi`, `/catalog/operations`, `/catalog/index/current`, `/code/class` + `ETag` `304`, `/code/schema`, `/code/graph`, `/code/grep`, `/code/resource`, `POST /code/context`, `POST /mcp` tools/resources/prompts, `/code/source` text/markdown), the request and the response on the whole screen and back (what they cover inert meanwhile), URL encoding of a path parameter, the keyboard (`/`, arrows, Enter), the hover card, the menu (its skins, which leave it open and are kept after a reload, and light, dark and system; Send's text at 4.5:1 or more in each skin and mode; the tabs' panels), whole paths in a wide list, the form's marks (a warning sign, then a check), the URL's colors (a value keeps its template's), undo, redo and reset of the form, every row's ticks against the catalog, the module headers as tree nodes (a chevron that turns, a kind icon, no fill), the wheel reaching the list's end inside the window, the button that folds and unfolds all modules, "Supported only", a deep link that prefills without sending (and one with parameters named `toString` or `__proto__`), Copy curl disabled like Send while a value is missing, the status code's tooltip (outside the live region, Escape hides it), starting a module that has not started (or settling as *needs its own login*) with a click, the decorated admin intro page `/plugins/servlet/rest-api-browser/admin` (product chrome, full-screen CTA link, MCP config, stuck-endpoint prompt), and no error of the plugin. Screenshots in `shots/`. |
| `cdp.js` | Shared zero-dependency helper of `ui.js` and `ui_next.js`: launches Edge/Chrome (headless by default, or headed with `RAB_HEADED=1`), exposes `evalFn` and explicit CDP error reporting over Node's built-in WebSocket; not run on its own. |

## Prerequisites

- Atlassian Plugin SDK **9.11+** (AMPS 9.11, needed for Jira 11 and Confluence 10): `atlas-run-standalone` on the
  `PATH`, or set `RAB_SDK_HOME` to the SDK's directory. `product.sh` ignores `ATLAS_HOME`, so an older SDK there is not
  picked up by accident.
- JDK **21** (Jira 11 and Confluence 10 run on Java 21 only): set `RAB_JAVA_HOME`, else `JAVA_HOME` is used.
  `product.sh` warns about another version for Jira 11.
- Machine-specific settings can go into `src/test/product/local.env` (git-ignored), which `product.sh` sources, for
  example:

  ```bash
  RAB_SDK_HOME="/path/to/atlassian-plugin-sdk-9.11.2"
  RAB_JAVA_HOME="/path/to/jdk-21"
  ```
- Python 3.9+ (standard library only), Node 22+ and Edge or Chrome for Playwright (`e2e/*.spec.ts`) as well as the
  zero-dependency CDP fallback scripts (`ui.js`, `ui_next.js`). For Playwright on offline hosts or to reuse the
  installed system Chrome/Edge without downloading browsers, install npm dependencies once with
  `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install` inside `src/test/product`.
- Git Bash on Windows (or any bash on Linux/macOS).
- Network access to `maven.atlassian.com` on the first start (Jira's WAR is about 500 MB, Confluence's 1 GB, then
  cached in the local Maven repository).

## Run

From the project root:

```bash
mvn -B clean package -DskipTests                   # target/rest-api-browser-<version>.jar
src/test/product/product.sh start                  # Jira 11.3.13 at http://localhost:2992/jira, admin/admin
python src/test/product/smoke.py --expect-version 11.3.13
python src/test/product/mcp_pat_check.py             # MCP tools, resources, prompts over PAT auth
(cd src/test/product && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install && npm test)
node src/test/product/ui.js                        # zero-dependency CDP fallback (no npm packages)
node src/test/product/ui_next.js                   # zero-dependency CDP full suite (no npm packages)
src/test/product/product.sh stop                   # or keep it running for the next build
```

For the Playwright suite (`src/test/product`), use `npm run test:headed` (or `RAB_HEADED=1 npm test`) to watch a real
Chrome/Edge window, `npm run test:ui` for the interactive Playwright UI, `npm run typecheck` to check TypeScript specs,
and `npm run report` to open the HTML report (failures also retain a Playwright trace in `test-results/`). Before
adding or editing Playwright specs, follow [docs/PLAYWRIGHT-GUIDELINES.md](../../../docs/PLAYWRIGHT-GUIDELINES.md).

The SDK starts the product in dev mode, where the page loads its scripts one by one. To check what a production
instance serves, the bundle `rest-api-browser.min.js`, run the same outside dev mode:

```bash
RAB_DEV_MODE=false src/test/product/product.sh start
python src/test/product/smoke.py --expect-version 11.3.13 --expect-bundle
node src/test/product/ui.js
src/test/product/product.sh stop
```

`product.sh start` returns when the product answers and its base URL matches the port (see *Things to know*). The
first start of a work directory downloads the WAR, Tomcat and dependencies and sets up the product (for Jira about 10
minutes, Jira itself about 5); later starts take about 2 minutes. `product.sh run` does the same in the foreground (for
a terminal of its own, or a CI job that keeps it as a background step); `product.sh wait` then waits for it.
`product.sh status` shows the URL, the work directory, the listening PID, state and version.

Settings (environment or `local.env`): `RAB_PRODUCT` (`jira`, or `confluence`: see [Confluence](#confluence)),
`RAB_VERSION` (default `11.3.13`), `RAB_HTTP_PORT` (`2992`), `RAB_AJP_PORT` (`8020`), `RAB_WORKDIR`
(`$HOME/$RAB_PRODUCT-rab-$RAB_VERSION-$RAB_HTTP_PORT`), `RAB_SDK_HOME`, `RAB_JAVA_HOME`, `RAB_START_TIMEOUT` (seconds,
`1800`), `RAB_DEV_MODE` (`true`; `false` starts the product outside dev mode). A running instance keeps its mode: stop
it before starting it in the other one. For another version, set `RAB_VERSION` for both:

```bash
RAB_VERSION=11.3.8 RAB_HTTP_PORT=2993 RAB_AJP_PORT=8021 src/test/product/product.sh start
RAB_URL=http://localhost:2993/jira python src/test/product/smoke.py --expect-version 11.3.8
RAB_URL=http://localhost:2993/jira node src/test/product/ui.js
```

The checks take `RAB_URL` (default `http://localhost:2992/jira`, for Confluence `http://localhost:1992/confluence`),
`RAB_USER` and `RAB_PASSWORD` (default `admin`/`admin`, the SDK instance's account, no secret). Playwright and the CDP
scripts (`ui.js`, `ui_next.js`) also take `RAB_HEADED=1` (visible browser window instead of headless), `RAB_BROWSER`
(the Edge or Chrome executable), and `RAB_BROWSER_ARGS` (extra browser flags, for example `--ignore-certificate-errors`
for an instance whose certificate authority the browser does not trust). `smoke.py` options:

- `--product jira|confluence`: the product (default `RAB_PRODUCT`, else `jira`);
- `--jar PATH`: the jar to install (default: the newest `target/rest-api-browser-*.jar`);
- `--no-install`: check the installed plugin only;
- `--uninstall`: uninstall it at the end (by default it stays installed, so the page can be tried by hand at
  `http://localhost:2992/jira/plugins/servlet/restbrowser`);
- `--expect-version VERSION`: fail unless the product reports that version;
- `--expect-bundle`: fail unless the page loads the bundle `rest-api-browser.min.js` (outside dev mode);
- `--log PATH`: the product's log to scan (default: the `product.sh` one,
  `$RAB_WORKDIR/amps-standalone-jira-<version>/target/jira/home/log/atlassian-jira.log`, for Confluence
  `$RAB_WORKDIR/amps-standalone-confluence-<version>/target/confluence-LATEST.log`);
- `--allow-remote`: it installs and removes plugins, so it refuses a host other than localhost without it.

Both scripts print one `PASS`/`FAIL` line per check (`WARN` and `SKIP` lines do not count) and end with
`N checks, N passed, N failed`. Exit code 0 all passed, 1 a check failed, 2 not run (product not reachable, no jar, no
browser).

## Confluence

`RAB_PRODUCT=confluence` makes the three scripts work on a Confluence instead (default Confluence 10.2.20 at
`http://localhost:1992/confluence`, AJP port 8022, work directory `$HOME/confluence-rab-<version>-<port>`, admin/admin);
the other `RAB_*` settings apply to it too:

```bash
RAB_PRODUCT=confluence src/test/product/product.sh start
RAB_PRODUCT=confluence python src/test/product/smoke.py --expect-version 10.2.20
RAB_PRODUCT=confluence python src/test/product/mcp_pat_check.py
(cd src/test/product && RAB_PRODUCT=confluence npm test)
RAB_PRODUCT=confluence node src/test/product/ui.js
RAB_PRODUCT=confluence node src/test/product/ui_next.js
RAB_PRODUCT=confluence src/test/product/product.sh stop
```

On Confluence the checks use its core REST API `/rest/api` instead of Jira's `/rest/api/2` (the UI check searches,
opens and sends `api/user/current`) and scan `confluence-LATEST.log` in AMPS's `target` directory (AMPS's Confluence
logs there, not to `atlassian-confluence.log`). A Jira and a Confluence can run at the same time.

**On Confluence 10.2.20 as Atlassian ships it**, Confluence cannot generate the WADL of 26 of its 134 REST modules,
its core `/rest/api` among them (500, `NoClassDefFoundError: com/sun/xml/txw2/TxwException`). Jersey's WADL generator
has JAXB write XML schemas for the resources' beans, and JAXB's schema writer `txw2` is not in Confluence's
`WEB-INF/lib` (Jira 11 ships `txw2-4.0.6.jar` with the same JAXB 4). Since 4.4.0, Classic UI displays those failed
modules in a fallback panel with a link to inspect them in the new UI instead of leaving the sidebar empty, and
`smoke.py` / `ui.js` verify that fallback. To restore full classic WADLs in a local test instance, copy the `txw2`
matching Confluence's `jaxb-runtime` into `WEB-INF/lib` and restart:

```bash
lib="$HOME/confluence-rab-10.2.20-1992/amps-standalone-confluence-10.2.20/target/confluence/webapp/WEB-INF/lib"
ls "$lib" | grep jaxb-runtime                      # org.glassfish.jaxb.jaxb-runtime-4.0.5.jar
curl -fo "$lib/txw2-4.0.5.jar" https://repo.maven.apache.org/maven2/org/glassfish/jaxb/txw2/4.0.5/txw2-4.0.5.jar
RAB_PRODUCT=confluence src/test/product/product.sh stop && RAB_PRODUCT=confluence src/test/product/product.sh start
```

AMPS keeps the jar across restarts of the same work directory.

## Ports and work directories

Other SDK instances usually run on the SDK's default ports (Jira 2990, Confluence 1990). A second AMPS instance in the
same work directory redeploys and stops the first one, so this project uses its own work directories and ports 2992 and
1992. Delete `$RAB_WORKDIR` to start again from a fresh instance (after `product.sh stop`; the JVM can hold its files
for a few seconds after the port closes).

`product.sh stop` closes AMPS's standard input (a `tail -f /dev/null` keeps it open; AMPS shuts the product down on
end of input) and, if the product still listens after 2 minutes, kills the process listening on the port **by PID**
with its child processes. When AMPS exits, its run kills its own `tail` (also after a failed start) and no other, so
`product.sh stop` followed at once by `product.sh start` is safe.
Never `taskkill /IM java.exe`: it would also kill every other Java process.

## Last verified

Jira 11.3.13 (build 11030014) on JDK 21, SDK 9.11.2 (AMPS 9.11.2, Tomcat 10.1.61), plugin 4.0.5 and 4.1.0
(2026-11-20) and the released 4.1.1 jar (2026-11-21), all built against Platform 8.0.0, with the same results:

- dev mode: `smoke.py` 28 checks passed (116 REST modules on the page, 114 WADLs loaded, all served),
  `ui.js` 14 checks passed (261 public resources, 1360 in all);
- outside dev mode (`RAB_DEV_MODE=false`; the bundle from 2020 in 4.0.5, the rebuilt one from 4.1.0):
  `smoke.py --expect-bundle` 29 checks passed (113 of 114 WADLs served), `ui.js` 14 checks passed (261 public
  resources, 1344 in all), with a `WARN` for the OAuth 2.0 WADL (see *Things to know*).

`ui.js` also prints two `WARN failed request` lines that are Jira's own (`/rest/qr/batching` 404,
`/rest/analytics/1.0/publish/bulk` 401).

2026-11-21, Confluence 10.2.20 (build 23584) on the same JDK and SDK, the released 4.1.1 jar (4.1.0 and earlier: the
page answers 500 on Confluence 10, see the commit "Fix the page failing on Confluence 10"):

- as shipped, dev mode: `smoke.py` 25 of 27 checks passed (134 REST modules on the page, 106 WADLs served),
  `ui.js` 11 of 14 (no public resource, 816 in all): the missing `txw2`, see [Confluence](#confluence);
- with `txw2-4.0.5.jar` added, dev mode (4.1.1-SNAPSHOT): `smoke.py` 27 checks passed (132 of 134 WADLs served),
  `ui.js` 14 checks passed (148 public resources, 1431 in all);
- with `txw2-4.0.5.jar` added, outside dev mode: `smoke.py --expect-bundle` 28 checks passed (131 of 134 WADLs
  served), `ui.js` 14 checks passed (148 public resources, 1415 in all).

`smoke.py` warns on Confluence about the two WADLs of `/rest/token-auth/api`, which answer 200 with an empty body
(the browser counts them as loaded), and about the ERROR line Confluence logs when it refuses the anonymous request
(see *Things to know*).

As of 2026-11-26 (`4.3.3-SNAPSHOT`), `ui_next.js` (including the tabbed decompiler, form-parameter handling, OpenAPI 3.1,
`/mcp`, `llms.txt` / `llms-full.txt`, and `/code/*` checks) and cluster catalog-hash parity passed on both multi-node
Jira `11.3.13` (`build 11030014`; `smoke.py` and `ui.js` also passed in full) and multi-node Confluence `10.2.20` (`build
23584`; `smoke.py` and `ui.js` failed only on the known missing-`txw2` WADL 500s / empty Classic public list above).
`4.4.0` adds `mcp_pat_check.py`, Classic Confluence 10 fallback UI verification, `not-startable` / Pretty `Wrap` /
**Generate example** / **OpenAPI** / **SourceDialog** code-intel UI checks, and MCP `resources/*` & `prompts/*`.

As of 2026-11-27 (`4.4.0` with the Playwright `e2e/*.spec.ts` suite and improved `cdp.js`):

- multi-node Jira `11.3.13` (`build 11030014`, `208/208` modules, `8,264` ops, hash `823d591a1568224b7ee6781a`):
  Playwright `8 passed` (`19.4s`, system Chrome), `smoke.py` `47/47` (`1 skipped` log, `3` warnings),
  `mcp_pat_check.py` `13/13`, `ui.js` `16/16`, `ui_next.js` `72/72` (`1 skipped` lazy-start module);
- multi-node Confluence `10.2.20` (`build 23584`, `171/171` modules, `2,577` ops): Playwright `8 passed` (`23.4s`,
  system Chrome), `smoke.py` `47/47` (`1 skipped` log, `37` warnings), `mcp_pat_check.py` `13/13`, `ui.js` `14/14`
  (Classic `#rab-wadl-fallback`), `ui_next.js` `71/71`.

## Things to know

- **Base URL**: AMPS's Jira test data has the base URL `http://localhost:2990/jira` whatever the port. The page builds
  every WADL URL from the base URL, so on port 2992 it would load the WADLs from another Jira on 2990, or from none.
  `product.sh start`/`wait` sets it to the URL under test (`PUT /rest/api/2/settings/baseUrl` with the **raw** URL as
  the body: a JSON string answers 400 "The specified URL is not valid."), and `smoke.py` fails first when they differ.
- Confluence gets the base URL `http://<server>:<port>/confluence` from AMPS when AMPS creates its home, and AMPS's
  `server` defaults to the machine's host name (not `localhost`, whatever the SDK's help says): the page would load
  every WADL from another origin. `product.sh` passes `--server localhost`. A home created without it keeps the host
  name: `product.sh` then stops with an error, and deleting the work directory fixes it.
- Jira 11 refuses an anonymous `/rest/api/2/serverInfo` (an empty error object), so the scripts read the version and
  the base URL from the application links manifest (`/rest/applinks/1.0/manifest`), which Jira and Confluence serve
  anonymously.
- Git Bash gives a `.bat` no executable bit, so `product.sh` tests the SDK launcher with `-f`.
- `product.sh` reads itself while it runs (bash does): editing it while `product.sh run` is running can end that run
  with a syntax error after the product stops.
- Jira keeps the higher version of a plugin key and drops a lower upload while UPM still reports success.
  `smoke.py` checks that Jira runs the jar's own version afterwards; when it does not, run once with `--uninstall`
  (or uninstall the app in *Manage apps*) and again.
- UPM answers `406` to `Accept: application/json` on `/rest/plugins/1.0/{key}-key`; the script asks for
  `application/vnd.atl.plugins.plugin+json`.
- `ui.js` sends Basic credentials only with the page and its XHRs (the WADLs). With Basic credentials on every
  static resource request Jira's decorator drops the session mid-response.
- **Dev mode**: AMPS starts Jira with `-Datlassian.dev.mode=true` unless the Maven JVM already has that property.
  `RAB_DEV_MODE=false` sets it through `ATLAS_OPTS` (the SDK's launcher replaces `MAVEN_OPTS` with
  `-Xms512M -Xmx768M $ATLAS_OPTS`). Outside dev mode UPM refuses uploads ("Plugins cannot be installed via upload"),
  so `product.sh` also starts Jira with `-Dupm.plugin.upload.enabled=true`, passed as AMPS's `jvmargs` property: the
  SDK's `--jvmargs` option would split it at the `=` on Windows.
- Outside dev mode Jira's OAuth 2.0 module refuses its WADL over HTTP (400 "Please ensure that your server is using
  HTTPS…"), so both scripts print a `WARN` for `/rest/oauth2/1.0/application.wadl`. Jira's
  `/rest/projects/1.0/application.wadl` now and then answers 500 (an error in Jira's WADL generator, in
  `atlassian-jira.log`); it is one of the few WADLs both scripts tolerate.
- The standalone Jira does not set `-Drest.api.browser.anonymous=true` (the refapp of `mvn verify` does), so an
  anonymous user is sent to the login page; that is what `smoke.py` expects.
- Confluence 10 itself sends an anonymous user to the login page before the plugin's servlet runs: the servlet is
  `@AnonymousSiteAccess`, and AMPS's Confluence does not allow anonymous access to the site. Confluence logs that as an
  ERROR ("Unhandled exception occurred whilst decorating page", `AuthorisationException`), which `smoke.py`
  reports as a `WARN`, not as an error of the plugin.
- Outside dev mode Confluence sends an admin to its post-upgrade landing page (`/pulp/pulp-render.action`) once; then
  `smoke.py` asks for the page again.
