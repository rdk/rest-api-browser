# Form parameters

Status: next · Area: new UI, request building · Effort: S (1 day) · Added: 2026-11-23

## Goal

Operations that take form parameters (`@FormParam`, `application/x-www-form-urlencoded`) get an input per field,
and Send encodes them as the body; multipart file uploads get a file input.

## Why

The Params tab lists form parameters as disabled rows ("Form fields are not supported yet: send a body instead").
Jira 11.3 has about 160 and Confluence 10.2 about 150 form parameters; for each, the user has to write the encoded
body by hand.

## Approach

1. `core/request.ts`: `values.form`, encoded with `URLSearchParams` into the body when the operation consumes
   `application/x-www-form-urlencoded`; `FormData` for `multipart/form-data` (the browser sets the boundary).
2. `Operation.tsx`: form rows become inputs (a file input for multipart parts), with the same checks
   (`core/validate.ts`) and undo steps (`core/formhistory.ts`); the Body tab says that the form makes the body.
3. `core/router.ts`: deep links carry form values like query values (`form.<name>=`), never files.
4. Tests: `request.test.ts` for both encodings, `ui_next.js` fills a form operation that is safe to call (a GET
   with form parameters, or a POST answered with 400 for a value that cannot exist).

## Risks and open questions

- XSRF: Atlassian products reject form posts without `X-Atlassian-Token: no-check`; the app already sends it for
  writes. Check that multipart uploads keep it.
- File uploads can be large: no size cap is needed for the request, but the history must not keep the file.

## Done when

- A form operation is sent with an encoded body built from the inputs, on both products; tests pass.
