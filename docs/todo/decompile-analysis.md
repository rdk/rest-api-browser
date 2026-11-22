# Decompiled method in the Java tab

Status: later · Area: backend, Java tab · Effort: M (2–3 days) · Added: 2026-11-23

## Goal

The Java tab (system administrators only) shows the source of the method behind an operation, decompiled on
demand, under the method's signature: what it checks, what it calls, which service does the work.

## Why

The WADLs carry no documentation, and annotations only tell what an endpoint accepts. The code answers "what does
this endpoint really do, and what does it check?", which matters most for internal and undocumented endpoints.
The tab already has the method, its class and its bundle (`OperationDetails`); the bytes of the class are one step
away.

## Approach

1. Read the class bytes through the class's own loader: `type.getClassLoader().getResourceAsStream(name + ".class")`
   (the bundle's loader for plugin classes); inner classes and lambdas (`Outer$1`, `lambda$x$0`) when the method uses
   them.
2. Embed a decompiler in the plugin jar:
   - [CFR](https://github.com/leibnitz27/cfr): MIT, one jar of about 2 MB, can decompile a single method
     (`methodname` option); the first choice.
   - [Vineflower](https://github.com/Vineflower/vineflower) (Fernflower's fork): Apache 2.0, larger, often more
     readable output.
3. A new endpoint, `GET /rest/restbrowser/1/catalog/details/source?op=<key>`, `@SystemAdminOnly`, next to
   `details` in `CatalogResource`; it resolves the handler as `details` does
   (`JerseyModelSource.handler`), decompiles, caches the text per class and bundle revision (small LRU), and answers
   `{ "source": "...", "decompiler": "CFR 0.152" }`.
4. In `JavaTab.tsx`: a "Source" block, loaded only when opened (a button), with light Java colouring and Copy.
5. Tests: unit tests on a class of the test sources; `ui_next.js` opens the source of `serverInfo` and finds the
   method's name in it.

## Risks and open questions

- **Licensing, to be decided first by the maintainer**: Atlassian's licence agreement and many app vendors' terms
  restrict reverse engineering and decompiling. Showing decompiled product or app code inside the product may not
  be allowed even for administrators. Possible answers: an opt-in system property, off by default; or apps only,
  never the product's own code; or not at all.
- The plugin jar grows from about 1.3 MB to about 3.5 MB; check that the decompiler's packages do not leak into the
  OSGi exports (`Export-Package` is `com.atlassian.labs.restbrowser.*`, so they stay private).
- Decompiling takes 100–500 ms per class: on demand only, cached, never part of the catalog build.
- Kotlin and Scala classes decompile into hard-to-read Java; Spring proxies (`$$SpringCGLIB$$`) must be resolved to
  the target class first.

## Done when

- The licensing question has an answer, written here and in the README.
- Opening "Source" on Jira's `serverInfo` and Confluence's `user/current` shows their methods; a non-system
  administrator gets 403 from the endpoint.
- Unit tests, `smoke.py` and `ui_next.js` pass on both products.
