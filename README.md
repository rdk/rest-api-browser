REST API Browser
================

> [!NOTE]
> **Unofficial fork** of Atlassian's archived [REST API Browser](https://bitbucket.org/atlassian/rest-api-browser) 4.0.0 (Platform 8, Jakarta).
> It builds again (against Platform 8.0.0 instead of the 8.0.0-m01 milestone, which no longer resolves) and is tested
> on Jira Data Center 11.3.13; see [Testing](#testing). The crossed-out notice below is Atlassian's.

## ~~Archived notice~~

~~This repository is no longer in active use. Branch `3.2.x` is still used together with Platform 7 and should EOL at the same time.~~

## Description

The REST API Browser add-on allows a developer to browse, discover, and test Atlassian's rich REST and JSON-RPC APIs.

## Compatibility

| Product | This fork (4.0.5 and later) | Atlassian's latest release | Officially compatible with |
|---|---|---|---|
| Jira Software, Jira Service Management | 11.x, tested on Jira 11.3.13 | 3.2.8 | 9.4 – 10.x |
| Confluence | 10.x from 4.1.1, tested on Confluence 10.2.20 (see below) | 3.2.8 | 7.19 – 9.x |
| Bitbucket | 10.x (untested) | 3.2.8 | 8.9 – 9.x |
| Bamboo | 12.x (untested) | 3.2.8 | 9.2 – 10.x |
| Crowd | 7.x (untested) | 3.2.8 | 6.x |
| Fisheye / Crucible | none (not on Atlassian's Platform 8 list) | 3.2.8 | 4.8 |

- **This fork** needs Platform 8 (Spring 6, Jakarta EE 10) and Java 21. Only Jira 11.3.13 and Confluence 10.2.20 are
  tested. The other versions are the ones Atlassian
  [moved to Platform 8](https://developer.atlassian.com/platform/marketplace/dc-apps-platform-8); they run on Java 21
  only, which is what the plugin is compiled for. Atlassian's next majors (Jira 12, Confluence 11, Bitbucket 11,
  Bamboo 13, Crowd 8) move to Spring 7 and Jakarta 11, so the fork may not run on them.
- **Confluence 10**: 4.0.5 and 4.1.0 fail there (the page answers 500: Atlassian's code looked for Confluence's SOAP
  modules, which Confluence 10 removed). From 4.1.1 the page works, but Confluence 10.2.20 itself cannot describe 26 of
  its 134 REST modules, its core REST API `/rest/api` among them: its WADL generator needs JAXB's `txw2`, which
  Confluence does not ship (Jira 11 does). With "Show only public APIs" the sidebar is therefore empty; unchecked, it
  shows the other modules' resources. Copying `txw2-4.0.5.jar` (`org.glassfish.jaxb:txw2:4.0.5` on Maven Central, the
  version of Confluence's `jaxb-runtime`) into Confluence's `confluence/WEB-INF/lib` and restarting fixes this, but it
  is a change to Confluence that Atlassian does not support.
- **Atlassian's latest release** is 3.2.8 (July 2024), in Atlassian's Maven repository; its Marketplace listing has been
  removed. Atlassian also published two 4.0.0 pre-releases but no final 4.0.0: 4.0.0-94f0bee (July 2024, Platform 7)
  and 4.0.0-jakarta-m001 (February 2025, a Platform 8 milestone).
- **Officially compatible with**: from the oldest versions that the build of 3.2.8 declares as supported
  (`*.eldest-supported.version` in its `pom.xml`) up to the Platform 7 versions (Jira 10, Confluence 9, Bitbucket 9,
  Bamboo 10, Crowd 6), which Atlassian's archived notice assigns to the 3.2.x line.

## Install

Download `rest-api-browser-<version>.jar` from [Releases](https://github.com/rdk/rest-api-browser/releases) (or
[build](#build) it), then upload it in the product under **Manage apps → Upload app**. Products disable uploads by
default: start the product with the JVM flag `-Dupm.plugin.upload.enabled=true` first. The plugin keeps Atlassian's
plugin key, so it replaces Atlassian's REST API Browser if that is installed.

## Usage

Open `<base URL>/plugins/servlet/restbrowser` (or `<base URL>/restbrowser`) and log in; the product's administration
pages link to it too. The sidebar lists the REST resources of the product and its apps; **Show only public APIs**, on by
default, limits it to the product's public APIs. Select a resource to see its methods, fill in the parameters and
**Send** the request as the logged-in user.

Users who are not logged in are sent to the login page. Starting the product with `-Drest.api.browser.anonymous=true`
lets them use the page too, so anyone who can reach the product can open it.

## Build

Needs JDK 21 and Maven 3.9; `pom.xml` declares Atlassian's public Maven repository, where the dependencies are.

```bash
mvn -B clean package -DskipTests   # target/rest-api-browser-<version>.jar
mvn -B verify                      # also runs the integration test against the refapp
```

GitHub Actions builds every push. Pushing a tag such as `4.0.5` (the version in `pom.xml`) builds that jar and
creates a draft release with it.

## Testing

`mvn verify` runs the integration test against the refapp. To check the plugin on a real Jira Data Center (Jira 11.3.13 by default), see [src/test/product/README.md](src/test/product/README.md); with `RAB_PRODUCT=confluence` the same scripts check it on Confluence 10.2.20:

```bash
mvn -B clean package -DskipTests
src/test/product/product.sh start
python src/test/product/smoke.py --expect-version 11.3.13
node src/test/product/ui.js
src/test/product/product.sh stop
```

## Changing the JavaScript

Outside dev mode the page loads `src/main/resources/assets/rab/rest-api-browser.min.js`, a bundle of the scripts listed
in `Gruntfile.js` next to it, which the Maven build does not regenerate. After changing a script, rebuild the bundle and
commit only the `.min.js`:

```bash
cd src/main/resources/assets/rab
npm install && npx grunt
```

In dev mode (`-Datlassian.dev.mode=true`, which the Atlassian Plugin SDK sets for the products it starts) the page loads
the scripts one by one instead. Since 4.1.0 the bundle holds the same scripts as dev mode, including underscore and
Atlassian's 2024 change to `process-wadl.js`; 4.0.5 and earlier ship a bundle built in 2020.

## License

Apache License 2.0, see [LICENSE](LICENSE). The original code is © Atlassian.
