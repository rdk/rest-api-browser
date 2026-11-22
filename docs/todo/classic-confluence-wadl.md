# Classic UI on Confluence 10: WADLs that answer 500

Status: limitation · Area: classic UI · Effort: M (investigation first) · Added: 2026-11-23

## Goal

The classic page lists Confluence 10's public API (`/rest/api`) and the other modules whose WADL fails today, or
says clearly that they are only in the new UI.

## Why

On Confluence 10.2, about a fifth of the WADLs the classic page loads answer 500, `/rest/api/application.wadl`
among them, so its "public APIs" list stays empty. `smoke.py` reports it as two failed checks and `ui.js` as three.
The new UI does not use WADLs and lists those modules.

## Approach

1. Find why Confluence fails to generate those WADLs (its log at the time of the request): a missing JAXB context, a
   resource class the WADL generator cannot introspect, or REST v2 modules without a WADL generator.
2. If it is not fixable from the plugin: on Confluence, the classic page links the failed modules to the new UI
   ("Open in the new UI") instead of leaving them out, and the README says so.

## Risks and open questions

- The cause may be in Confluence itself; then only the second step applies.

## Done when

- The classic page on Confluence 10 either lists `/rest/api` or links it to the new UI; `smoke.py` and `ui.js`
  expect that behaviour and pass.
