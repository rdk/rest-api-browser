Atlassian REST API Browser
==========================

> [!NOTE]
> **Unofficial fork** of Atlassian's archived [rest-api-browser](https://bitbucket.org/atlassian/rest-api-browser) 4.0.0 (Platform 8, Jakarta).
> It builds again (against Platform 8.0.0 instead of the 8.0.0-m01 milestone, which no longer resolves) and is tested
> on Jira Data Center 11.3.13; see [Testing](#testing). The crossed-out notice below is Atlassian's.

## ~~Archived notice~~

~~This repository is no longer in active use. Branch `3.2.x` is still used together with Platform 7 and should EOL at the same time.~~

## Description

The Atlassian REST API Browser add-on allows a developer to browse, discover, and test Atlassian's rich REST and JSON-RPC APIs.

## Compatibility

| Product | This fork (4.0.0-SNAPSHOT) | Atlassian's latest release | Officially compatible with |
|---|---|---|---|
| Jira Software, Jira Service Management | 11.x, tested on Jira 11.3.13 | 3.2.8 | 9.4 – 10.x |
| Confluence | 10.x (untested) | 3.2.8 | 7.19 – 9.x |
| Bitbucket | 10.x (untested) | 3.2.8 | 8.9 – 9.x |
| Bamboo | 12.x (untested) | 3.2.8 | 9.2 – 10.x |
| Crowd | 7.x (untested) | 3.2.8 | 6.x |
| Fisheye / Crucible | none (not on Atlassian's Platform 8 list) | 3.2.8 | 4.8 |

- **This fork** needs Platform 8 (Spring 6, Jakarta EE 10) and Java 21. Only Jira 11.3.13 is tested. The other versions
  are the ones Atlassian [moved to Platform 8](https://developer.atlassian.com/platform/marketplace/dc-apps-platform-8);
  they run on Java 21 only, which is what the plugin is compiled for. Atlassian's next majors (Jira 12, Confluence 11,
  Bitbucket 11, Bamboo 13, Crowd 8) move to Spring 7 and Jakarta 11, so the fork may not run on them.
- **Atlassian's latest release** is 3.2.8 (July 2024), in Atlassian's Maven repository; its Marketplace listing has been
  removed. Atlassian also published two 4.0.0 pre-releases but no final 4.0.0: 4.0.0-94f0bee (July 2024, Platform 7)
  and 4.0.0-jakarta-m001 (February 2025, a Platform 8 milestone).
- **Officially compatible with**: from the oldest versions that the build of 3.2.8 declares as supported
  (`*.eldest-supported.version` in its `pom.xml`) up to the Platform 7 versions (Jira 10, Confluence 9, Bitbucket 9,
  Bamboo 10, Crowd 6), which Atlassian's archived notice assigns to the 3.2.x line.

## Install

There is no download: [build](#build) the jar, then upload `target/rest-api-browser-4.0.0-SNAPSHOT.jar` in the product
under **Manage apps → Upload app**.

## Usage

Open `<base URL>/plugins/servlet/restbrowser` (or `<base URL>/restbrowser`) and log in; the product's administration
pages link to it too. The sidebar lists the REST resources of the product and its apps; **Show only public APIs**, on by
default, limits it to the product's public APIs. Select a resource to see its methods, fill in the parameters and
**Send** the request as the logged-in user.

Users who are not logged in are sent to the login page. Starting the product with `-Drest.api.browser.anonymous=true`
lets them use the page too, so anyone who can reach the product can open it.

## Build

Needs JDK 21 and Maven 3.9. The `pom.xml` declares no repositories, so Maven has to reach Atlassian's repository
(`https://maven.atlassian.com/repository/public`) through `~/.m2/settings.xml`, or you build with `atlas-mvn` from the
Atlassian Plugin SDK, which is set up for it.

```bash
mvn -B clean package -DskipTests   # target/rest-api-browser-4.0.0-SNAPSHOT.jar
mvn -B verify                      # also runs the integration test against the refapp
```

## Testing

`mvn verify` runs the integration test against the refapp. To check the plugin on a real Jira Data Center (Jira 11.3.13 by default), see [src/test/jira/README.md](src/test/jira/README.md):

```bash
mvn -B clean package -DskipTests
src/test/jira/jira.sh start
python src/test/jira/smoke_jira.py --expect-jira 11.3.13
node src/test/jira/ui_jira.js
src/test/jira/jira.sh stop
```

## Changing the JavaScript

Outside dev mode the page loads `src/main/resources/assets/rab/rest-api-browser.min.js`, a bundle of the scripts listed
in `Gruntfile.js` next to it, which the Maven build does not regenerate. After changing a script, rebuild the bundle and
commit only the `.min.js`:

```bash
cd src/main/resources/assets/rab
npm install && npx grunt
```

In dev mode (`-Datlassian.dev.mode=true`, which the Atlassian Plugin SDK sets for the products it starts, including the
Jira of `src/test/jira`) the page loads the scripts one by one instead. The committed bundle dates from 2020 and does
not contain Atlassian's 2024 change to `process-wadl.js` yet.

## License

Apache License 2.0, see [LICENSE](LICENSE). The original code is © Atlassian.
