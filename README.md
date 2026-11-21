REST API Browser
================

> [!NOTE]
> **Unofficial fork** of Atlassian's archived [REST API Browser](https://bitbucket.org/atlassian/rest-api-browser) 4.0.0 (Platform 8, Jakarta).
> It builds again (against Platform 8.0.0 instead of the 8.0.0-m01 milestone, which no longer resolves) and is tested
> on Jira 11.3.13 and Confluence 10.2.20; see [Testing](#testing). The crossed-out notice below is Atlassian's.

## ~~Archived notice~~

~~This repository is no longer in active use. Branch `3.2.x` is still used together with Platform 7 and should EOL at the same time.~~

## Description

The REST API Browser add-on allows a developer to browse, discover, and test Atlassian's rich REST and JSON-RPC APIs.

## Compatibility

Which release to install depends on the product's version:

| Product | This fork (latest release) | Atlassian's 3.2.8 |
|---|---|---|
| Jira | 11.x, tested on 11.3.13 | 9.4 – 10.x |
| Confluence | 10.x, tested on 10.2.20 (see below) | 7.19 – 9.x |
| Bitbucket | 10.x, untested | 8.9 – 9.x |
| Bamboo | 12.x, untested | 9.2 – 10.x |
| Crowd | 7.x, untested | 6.x |
| Fisheye / Crucible | not supported | 4.8 |

- **Untested** products are built on the same Atlassian platform as Jira 11 and Confluence 10
  ([Platform 8](https://developer.atlassian.com/platform/marketplace/dc-apps-platform-8): Spring 6, Jakarta EE 10,
  Java 21), so the fork should run on them too. Fisheye and Crucible were not moved to it. The next major versions
  (Jira 12, Confluence 11, Bitbucket 11, Bamboo 13, Crowd 8) move to Spring 7 and Jakarta EE 11, so the fork may not
  run on them.
- **Confluence 10** needs 4.1.1 or later: 4.0.5 and 4.1.0 answer 500 there. Even then the sidebar is empty while "Show
  only public APIs" is checked: Confluence 10.2.20 cannot describe 26 of its REST modules, its core REST API
  `/rest/api` among them, because it does not ship JAXB's `txw2`. Copying `txw2-4.0.5.jar`
  (`org.glassfish.jaxb:txw2:4.0.5` on Maven Central) into `confluence/WEB-INF/lib` and restarting fixes that, but
  Atlassian does not support this change.
- **Atlassian's 3.2.8** (July 2024) is Atlassian's last release. It is in Atlassian's Maven repository but no longer on
  the Marketplace. Its range starts at the oldest versions its build declares as supported and ends at the Platform 7
  versions, which Atlassian's archived notice assigns to 3.2.x. Atlassian never released a final 4.0.0, the version
  this fork is based on.

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
