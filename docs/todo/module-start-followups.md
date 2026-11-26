# Starting modules: follow-ups

Status: later · Area: catalog, new UI · Effort: S–M (1–3 days in all) · Added: 2026-11-23

## Goal

The list never offers to start a module that a click cannot start, the catalog recovers from a build that failed,
and the start's last rough edges are gone.

## Why

4.2.1 lets a user start a Confluence module that has not started (`CatalogStore.startModule` in
`src/main/frontend/src/core/catalog.ts`, `CatalogResource.started` and `CatalogService.readStarted`). The reviews of
that work (2b3e183) left these open on purpose:

1. **Modules a session cannot start.** `token-auth/*` modules start only for their own (OAuth) login. The list still
   offers *start*; a click costs one OPTIONS request and an immediate 409 `still-not-started`, then the row says *did
   not start*. The welcome page counts them as waiting, and `ui_next.js` skips them by matching their path.
2. **A build that throws.** `CatalogService.build()` logs the error and waits for the next change or refresh, so the
   catalog stays incomplete and every open page polls it every 8 s until then. This was so before 4.2.1;
   `publishDone` now also keeps a read from claiming complete while modules are unread.
3. ~~**RichTip's target has no role.**~~ *(Done: `RichTip` sets `role="button"` and `aria-pressed` when `clickPin` is enabled.)*
4. ~~**An admin's rebuild costs a full re-serialisation at once.**~~ *(Done: `CatalogSnapshot.incomplete()` reuses index bytes and hash.)*
5. ~~**Duplicated test setup.**~~ *(Done: shared via `CatalogTestSupport.failedModule`.)*

## Approach

1. Remember on the server, per node and per module, that a start found its application still not running after the
   request (`StartOutcome.STILL_NOT_STARTED`), and send it in the summary (a reason such as `not-startable`, or a flag
   on the entry). The row then shows *needs its own login* without the action, the welcome page leaves it out, and
   `ui_next.js` picks a module by that field. Clear it when the module starts later (an OAuth request starts it).
2. In `build()`, schedule one retry after a failure (with a growing delay, a few tries), and publish the snapshot as
   complete with the failed modules marked `error` when the retries are spent.
3. Make the target a `<button type="button">` that pins the tooltip (`usePin` would return a setter), or give the
   status chip a role that fits; decide with a screen reader at hand.
4. Keep `complete` out of the hash input, so `incomplete()` and progress updates reuse the index bytes and hash; the
   summary's ETag tells complete from incomplete already (`progress()`).
5. Move the helpers; no behaviour change.

## Risks and open questions

- 1: a module that did not start for a passing reason (the node was busy) must not stay marked for good: clear the
  mark on the next rebuild, or after a while.
- 2: a build that fails every time must not retry forever or fill the log.
- 4: clients that cached an index under the old hash scheme: none, the hash is not persisted.

## Done when

- Unit tests for each change (`CatalogServiceTest`, `CatalogResourceTest`, `catalog.test.ts`).
- On a freshly started Confluence: `token-auth` modules show that they need their own login, without *start*, after
  one attempt; `ui_next.js` passes without the path match.
- `smoke.py` and `ui_next.js` pass on Jira and Confluence.
