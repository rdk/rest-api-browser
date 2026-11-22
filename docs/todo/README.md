# TODO conventions

[`TODO.md`](../../TODO.md) at the root is the short list; every item's details live in one file in this folder.

## The list (`TODO.md`)

- One line per item: a checkbox, the title linked to its file, an em dash and one short sentence saying why it
  matters. Nothing else: no steps, no estimates, no discussion.
- Three sections, in this order: **Next** (agreed, to be done soon), **Later** (worth doing, not scheduled),
  **Known limitations** (accepted gaps that users may run into; an item may move up when it starts to hurt).
- Within a section, the most useful item first.
- Keep it short: about a screen. When it grows, prune or merge items rather than adding sections.

## An item's file (`docs/todo/<slug>.md`)

- The name is the item's slug: lowercase words joined by hyphens, from its title (`decompile-analysis.md`).
- It starts with the title as a heading and one metadata line:

  ```markdown
  # Decompiled method in the Java tab

  Status: later · Area: backend, Java tab · Effort: M (2–3 days) · Added: 2026-11-23
  ```

  - **Status**: `next`, `later` or `limitation`, the same as the section of `TODO.md` it is listed in.
  - **Area**: where the work is (backend, catalog, new UI, classic UI, tests, build, docs).
  - **Effort**: S (up to a day), M (a few days), L (a week or more), with a rough number of days.
  - **Added**: the date the item was written, as YYYY-MM-DD.
- Then these sections, each as short as it can be:
  - **Goal**: what a user gets.
  - **Why**: the problem or the evidence (what was seen, where, with numbers when there are some).
  - **Approach**: the plan, in steps, with the files and classes it touches.
  - **Risks and open questions**: what could make it harder, and what has to be decided first, by whom.
  - **Done when**: the checks that show it works: unit tests, `smoke.py`, `ui_next.js`, both products.
- Write for someone who knows the code but not the history: link to files (`src/...`) and earlier commits.

## Working with items

- Starting an item: move its line to **Next** if it is not there, set `Status: next`.
- Finishing an item: delete its line and its file in the commit that does the work, and name the slug in the
  commit message (`todo: decompile-analysis`). Git keeps the history; the list holds open work only.
- Dropping an item: delete it the same way, with the reason in the commit message.
- Like everything in this repository: no host names, accounts, customer names or other private details.
