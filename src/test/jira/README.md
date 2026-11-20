# Real-Jira checks

End-to-end checks of the REST API Browser on a **real, standalone Jira Data Center** started with the Atlassian Plugin
SDK. They complement `mvn verify`, whose integration test (`RestApiBrowserSmokeTest`) runs against the refapp only:
the refapp does not show whether the plugin runs on Jira (Jira's REST modules and their WADLs, Jira's decorator, AUI
and Seraph login, UPM install).

| File | What it does |
|---|---|
| `jira.sh` | Starts, waits for, shows and stops a throwaway Jira (`atlas-run-standalone`) in its own work directory and port. |
| `smoke_jira.py` | Installs the plugin jar through UPM and checks it over HTTP: all modules enabled, the page as admin (search field, checkbox, Jira's decorator, product name), the list of REST modules on the page and **every WADL on it** (the sidebar is built from them), the plugin's web resources and Angular views, its REST resources (`/rest/devtools/1/ewadl`, `jsonrpc/{key}/wadl`, 404 for an unknown plugin), the pretty URL `/restbrowser`, the redirect of an anonymous user to the login page, and no error or stack trace of the plugin in `atlassian-jira.log` since the run started. |
| `ui_jira.js` | The page in headless Edge/Chrome: Angular starts, the public APIs load into the sidebar with `api/2` among them, the "Show only public APIs" checkbox is on by default and can be turned off (what `RestApiBrowserSmokeTest` checks on the refapp), all APIs then load, search narrows the list, `api/2/serverInfo` shows its `GET` method and **Send** shows Jira's answer; no JavaScript exception from the plugin and no failed request for its resources or the WADLs. Screenshots in `shots/` (git-ignored). |

## Prerequisites

- Atlassian Plugin SDK **9.11+** (AMPS 9.11, needed for Jira 11): `atlas-run-standalone` on the `PATH`, or set
  `JIRA_SDK_HOME` to the SDK's directory. `jira.sh` ignores `ATLAS_HOME`, so an older SDK there is not picked up by
  accident.
- JDK **21** (Jira 11 runs on Java 21 only): set `JIRA_JAVA_HOME`, else `JAVA_HOME` is used. `jira.sh` warns about
  another version.
- Machine-specific settings can go into `src/test/jira/local.env` (git-ignored), which `jira.sh` sources, for example:

  ```bash
  JIRA_SDK_HOME="/path/to/atlassian-plugin-sdk-9.11.2"
  JIRA_JAVA_HOME="/path/to/jdk-21"
  ```
- Python 3.9+ (standard library only), Node 22+ and Edge or Chrome for `ui_jira.js`.
- Git Bash on Windows (or any bash on Linux/macOS).
- Network access to `maven.atlassian.com` on the first start (Jira's WAR is about 500 MB, then cached in the local
  Maven repository).

## Run

From the project root:

```bash
mvn -B clean package -DskipTests                       # target/rest-api-browser-<version>.jar
src/test/jira/jira.sh start                            # Jira 11.3.13 at http://localhost:2992/jira, admin/admin
python src/test/jira/smoke_jira.py --expect-jira 11.3.13
node src/test/jira/ui_jira.js
src/test/jira/jira.sh stop                             # or keep it running for the next build
```

`jira.sh start` returns when Jira answers and its base URL matches the port (see *Things to know*). The first start
of a work directory downloads the WAR, Tomcat and dependencies and sets up Jira (about 10 minutes, Jira itself about
5); later starts take about 2 minutes. `jira.sh run` does the same in the foreground (for a terminal
of its own, or a CI job that keeps it as a background step); `jira.sh wait` then waits for it. `jira.sh status` shows the URL, the work directory, the listening PID, state and version.

Settings (environment or `local.env`): `JIRA_VERSION` (default `11.3.13`), `JIRA_HTTP_PORT` (`2992`),
`JIRA_AJP_PORT` (`8020`), `JIRA_WORKDIR` (`$HOME/jira-rab-$JIRA_VERSION-$JIRA_HTTP_PORT`), `JIRA_SDK_HOME`,
`JIRA_JAVA_HOME`, `JIRA_START_TIMEOUT` (seconds, `1800`). For another Jira version, set `JIRA_VERSION` for both:

```bash
JIRA_VERSION=11.3.8 JIRA_HTTP_PORT=2993 JIRA_AJP_PORT=8021 src/test/jira/jira.sh start
JIRA_URL=http://localhost:2993/jira python src/test/jira/smoke_jira.py --expect-jira 11.3.8
JIRA_URL=http://localhost:2993/jira node src/test/jira/ui_jira.js
```

The checks take `JIRA_URL` (default `http://localhost:2992/jira`), `JIRA_USER` and `JIRA_PASSWORD` (default
`admin`/`admin`, the SDK Jira's account, no secret). `smoke_jira.py` options:

- `--jar PATH`: the jar to install (default: the newest `target/rest-api-browser-*.jar`);
- `--no-install`: check the installed plugin only;
- `--uninstall`: uninstall it at the end (by default it stays installed, so the page can be tried by hand at
  `http://localhost:2992/jira/plugins/servlet/restbrowser`);
- `--expect-jira VERSION`: fail unless Jira reports that version;
- `--jira-log PATH`: the `atlassian-jira.log` to scan (default: the `jira.sh` one,
  `$JIRA_WORKDIR/amps-standalone-jira-<version>/target/jira/home/log/atlassian-jira.log`);
- `--allow-remote`: it installs and removes plugins, so it refuses a host other than localhost without it.

Both scripts print one `PASS`/`FAIL` line per check (`WARN` and `SKIP` lines do not count) and end with
`N checks, N passed, N failed`. Exit code 0 all passed, 1 a check failed, 2 not run (Jira not reachable, no jar, no
browser).

## Ports and work directories

Other SDK Jiras usually run on 2990, the SDK's default. A second AMPS instance in the same work directory redeploys
and stops the first one, so this project uses its own work directory and port 2992. Delete `$JIRA_WORKDIR` to start
again from a fresh Jira.

`jira.sh stop` closes AMPS's standard input (a `tail -f /dev/null` keeps it open; AMPS shuts Jira down on EOF) and,
if Jira still listens after 2 minutes, kills the process listening on the port **by PID** with its child processes.
Never `taskkill /IM java.exe`: it would also kill every other Java process.

## Last verified

2026-11-20, Jira 11.3.13 (build 11030014) on JDK 21, SDK 9.11.2 (AMPS 9.11.2, Tomcat 10.1.61), plugin
4.0.0-SNAPSHOT built against Platform 8.0.0: `smoke_jira.py` 28 checks passed (116 REST modules on the page, 114
WADLs loaded, all served), `ui_jira.js` 13 checks passed (261 public resources, 1360 in all). `ui_jira.js` prints two
`WARN failed request` lines that are Jira's own (`/rest/qr/batching` 404, `/rest/analytics/1.0/publish/bulk` 401).

## Things to know

- **Base URL**: AMPS's Jira test data has the base URL `http://localhost:2990/jira` whatever the port. The page builds
  every WADL URL from the base URL, so on port 2992 it would load the WADLs from another Jira on 2990, or from none.
  `jira.sh start`/`wait` sets it to the URL under test (`PUT /rest/api/2/settings/baseUrl` with the **raw** URL as the
  body: a JSON string answers 400 "The specified URL is not valid."), and `smoke_jira.py` fails first when they differ.
- Jira 11 refuses an anonymous `/rest/api/2/serverInfo` (an empty error object), so the scripts ask as `admin`.
- Git Bash gives a `.bat` no executable bit, so `jira.sh` tests the SDK launcher with `-f`.
- `jira.sh` reads itself while it runs (bash does): editing it while `jira.sh run` is running can end that run with a
  syntax error after Jira stops.
- Jira keeps the higher version of a plugin key and drops a lower upload while UPM still reports success.
  `smoke_jira.py` checks that Jira runs the jar's own version afterwards; when it does not, run once with `--uninstall`
  (or uninstall the app in *Manage apps*) and again.
- UPM answers `406` to `Accept: application/json` on `/rest/plugins/1.0/{key}-key`; the script asks for
  `application/vnd.atl.plugins.plugin+json`.
- `ui_jira.js` sends Basic credentials only with the page and its XHRs (the WADLs). With Basic credentials on every
  static resource request Jira's decorator drops the session mid-response.
- The SDK starts Jira in dev mode (`atlassian.dev.mode=true`), in which the page loads its scripts one by one: the
  checks do not cover `rest-api-browser.min.js`, the bundle a Jira outside dev mode serves.
- The standalone Jira does not set `-Drest.api.browser.anonymous=true` (the refapp of `mvn verify` does), so an
  anonymous user is sent to the login page; that is what `smoke_jira.py` expects.
