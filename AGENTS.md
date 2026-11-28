# AGENTS.md

REST API Browser: an Atlassian Data Center plugin (Java 21, REST v2) with a classic AngularJS page and a new
Preact + TypeScript UI in `src/main/frontend`.

- Fast inner loop (run only the layer you touched):
  - Frontend (`src/main/frontend`): `cd src/main/frontend && npm run lint:all && npx tsc --noEmit -p . && npx vitest run` (~3s).
  - Java backend (`src/main/java/`, `src/test/java/`): `mvn -q -B test-compile -Dskip.npm -Dskip.installnodenpm && mvn -q -B surefire:test` (~7s).
  - Python CLI (`client/rab.py`): `python -B -m unittest discover -s client -v` (~2s).
  - Fast local deploy JAR (skips `npm ci` and tests; requires existing `src/main/frontend/node_modules`): `mvn -B package -Pfast`.
- Full / pre-release verification:
  - Full build (all tests + Vite + JAR/OBR): `mvn -B package`.
  - Offline browser mock E2E (uses `target/classes/assets/next/` from `npm run build` or `mvn package`): `cd src/test/product && npm run typecheck && npm run test:mock` (harness at [src/test/harness/index.html](src/test/harness/index.html)).
  - In real products: [src/test/product/README.md](src/test/product/README.md) (`smoke.py`, `mcp_pat_check.py`, Playwright `e2e/*.spec.ts`, and frozen fallback `ui.js` / `ui_next.js`). For feature iteration, prefer targeted `npx playwright test -g "..."` instead of the full suite.
- Read [docs/GUIDELINES.md](docs/GUIDELINES.md) before changing code, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module layout, and [docs/PLAYWRIGHT-GUIDELINES.md](docs/PLAYWRIGHT-GUIDELINES.md) before adding or editing Playwright tests. Logic goes in `core/` with a unit test, and
  every fix comes with a test.
- Public repository: no private host names, accounts, customer names or screenshots in code, docs or commits.
