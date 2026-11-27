# AGENTS.md

REST API Browser: an Atlassian Data Center plugin (Java 21, REST v2) with a classic AngularJS page and a new
Preact + TypeScript UI in `src/main/frontend`.

- Build: `mvn -B package`. Frontend only: `cd src/main/frontend && npx tsc --noEmit -p . && npx vitest run`.
- Java tests without the frontend: `mvn -q -B test-compile -Dskip.npm -Dskip.installnodenpm && mvn -q -B surefire:test '-Dtest=!it/**'`.
- In real products: [src/test/product/README.md](src/test/product/README.md) (`smoke.py`, `mcp_pat_check.py`, Playwright `e2e/*.spec.ts`, and zero-dependency `ui.js` / `ui_next.js`).
- Read [docs/GUIDELINES.md](docs/GUIDELINES.md) before changing code, and [docs/PLAYWRIGHT-GUIDELINES.md](docs/PLAYWRIGHT-GUIDELINES.md) before adding or editing Playwright tests. Logic goes in `core/` with a unit test, and
  every fix comes with a test.
- Public repository: no private host names, accounts, customer names or screenshots in code, docs or commits.
