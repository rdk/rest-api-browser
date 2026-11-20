Atlassian REST API Browser
==========================

> [!NOTE]
> **Unofficial fork** of Atlassian's archived [rest-api-browser](https://bitbucket.org/atlassian/rest-api-browser) 4.0.0 (Platform 8, Jakarta).
> It builds again (against Platform 8.0.0 instead of the 8.0.0-m01 milestone, which no longer resolves) and is tested
> on Jira Data Center 11.3.13; see [Testing](#testing). The crossed-out notice below is Atlassian's.

# ~~Archived notice~~

~~This repository is no longer in active use. Branch `3.2.x` is still used together with Platform 7 and should EOL at the same time.~~

# Description

The Atlassian REST API Browser add-on allows a developer to browse, discover, and test Atlassian's rich REST and JSON-RPC APIs. You can install the REST API Browser into your Atlassian product through the UPM.

To allow anonymous access to the REST API Browser, start the product with the system property 'rest.api.browser.anonymous' set to 'true'.

# Testing

`mvn verify` runs the integration test against the refapp. To check the plugin on a real Jira Data Center (Jira 11.3.13 by default), see [src/test/jira/README.md](src/test/jira/README.md):

```bash
mvn -B clean package -DskipTests
src/test/jira/jira.sh start
python src/test/jira/smoke_jira.py --expect-jira 11.3.13
node src/test/jira/ui_jira.js
src/test/jira/jira.sh stop
```
