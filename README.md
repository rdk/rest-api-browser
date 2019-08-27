Atlassian REST API Browser
==========================

The Atlassian REST API Browser add-on allows a developer to browse, discover, and test Atlassian's rich REST and JSON-RPC APIs. You can install the REST API Browser into your Atlassian product through the UPM.

To allow anonymous access to the REST API Browser, start the product with the system property 'rest.api.browser.anonymous' set to 'true'.



Notes on the fork
=================

This fork contains fix for duplicated url root bug on Jira 8.
See https://jira.atlassian.com/browse/JRASERVER-68844


Making changes to javascript
============================

If you make changes to any javascript you need to manually recompile rest-api-browser.min.js 

In `src/resources/assets/rab` execute:

~~~
npm install grunt --save-dev
npm install grunt-contrib-uglify --save-dev
grunt     
rm -rf node_modules
~~~

