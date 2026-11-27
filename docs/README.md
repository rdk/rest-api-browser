# Documentation

| Where | What |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Current module & code map across Java backend, Spring/OSGi wiring, code intelligence, Preact UI, Python CLI, and the testing pyramid. |
| [GUIDELINES.md](GUIDELINES.md) | Rules for changing the code: state and listeners, keyboard and accessibility, data fidelity, secrets, CSS and skins. |
| [PLAYWRIGHT-GUIDELINES.md](PLAYWRIGHT-GUIDELINES.md) | Agent guidelines for writing Playwright E2E tests in `src/test/product/e2e/` and `e2e-mock/`: Jira/Confluence rules, locators, auto-waiting, error gating, and pitfalls to avoid. |
| [AGENT-API.md](AGENT-API.md) | Agent & automation REST API reference: discovery (`llms.txt`, `llms-full.txt`, OpenAPI 3.1), `/catalog/*`, `/code/*`, and the read-only `/mcp` server. |
| [NEW-UI-PLAN.md](NEW-UI-PLAN.md) | Historical design document (archived) covering initial goals, catalog design, and progressive steps. |
| [todo/](todo/) | One file per open item of [TODO.md](../TODO.md); [todo/README.md](todo/README.md) has the conventions. |
| [../src/test/product/README.md](../src/test/product/README.md) | Testing against real products: `product.sh`, `smoke.py`, `mcp_pat_check.py`, Playwright (`e2e/*.spec.ts`), and zero-dependency `ui.js` / `ui_next.js`. |

Conventions for everything here:

- One topic per file; the file name says what it is (`UPPER-CASE.md` for long-lived documents such as a plan,
  `lower-case-slug.md` for items that come and go).
- Plain Markdown that reads well on GitHub; links to the code as repository paths (`src/...`).
- Facts with their source and date when they can go stale (versions tested, counts measured).
- No host names, accounts, customer names or other private details.
