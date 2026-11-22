# OpenAPI annotations as documentation

Status: next · Area: catalog, new UI · Effort: M (2 days) · Added: 2026-11-23

## Goal

Operations show the summary and description their authors wrote: the summary in the list's hover card and under
the operation's title, the description in the operation view, and each parameter's description beside its input.

## Why

The WADLs carry no `<doc>` at all, but many resources of Jira 11 carry OpenAPI (Swagger v3) annotations: the Java
tab shows, for `api/2/serverInfo`,
`@Operation(summary="Get general information about the current Jira server", description="Returns general
information about the current Jira server.")` and `@ApiResponse(description="Returns a full representation of
the server info in JSON format.", responseCode="200")`. The documentation is in the running product already.

## Approach

1. In `JerseyModelSource.operation`, read from the definition method (and its class, for `@Tag`) by annotation
   class name, through reflection, as the access annotations are read:
   `io.swagger.v3.oas.annotations.Operation` (`summary`, `description`, `deprecated`),
   `io.swagger.v3.oas.annotations.Parameter` on parameters (`description`, `example`),
   `io.swagger.v3.oas.annotations.responses.ApiResponse` (`responseCode`, `description`).
2. Add `summary`, `description` and per-parameter `description` to `OperationSpec` and `Param`, write them in
   `CatalogSnapshot` (bump the index `format` if a client could misread it), cap their length.
3. Search: include the summary in the search text (`core/search.ts`, `hay`).
4. UI: the summary in `RowCard` and under the title in `Operation.tsx`, the description below it (collapsed when
   long), parameter descriptions as a quiet line under each input.
5. Golden catalog test (`GoldenCatalogTest`) and `search.test.ts` updated; `ui_next.js` finds the serverInfo
   summary.

## Risks and open questions

- How many operations have them: count on Jira 11 and Confluence 10 first (a quick probe over the catalog), to
  know whether it is worth showing an empty space for the rest.
- The catalog's index grows; descriptions can be long. Cap per field (for example 2,000 characters) and measure the
  index size before and after.
- Confluence's and apps' resources may use other annotations (Swagger v2 `io.swagger.annotations.ApiOperation`);
  support them in the same place if they are common.

## Done when

- Jira's `serverInfo` shows its summary in the hover card and its description in the operation view.
- The index grows by a measured, acceptable amount; the golden test and both products' checks pass.
