# Guidelines

Rules for changing the plugin, most of them learned from bugs that reviews found. Each rule has a test, a shared
helper or a CSS token behind it; use those rather than solving the same problem again.

## Code layout

- Logic that can be pure goes into `src/main/frontend/src/core/` with a unit test (vitest); `ui/` renders it. A fix
  gets a test that fails without it: a unit test, or a check in `src/test/product/ui_next.js` for behaviour in the page.
- What a tab shows, copies and downloads comes from one function (`textOf` in `Response.tsx`), so the three never
  differ.

## State, effects, listeners

- A promise that resolves after the component is gone must not set state or start timers: use a live flag, or
  `useFlash` in `bits.tsx` for the short "Copied" and "Failed" states.
- Every `document` listener is removed in a cleanup, including those added during a drag: keep the detach function in a
  ref and call it on unmount.
- A component that keeps local state (a filter, a fold) gets a `key` when what it shows changes: two pages with the
  same component in the same place otherwise share the state.
- Effects list everything they read, or read it through a ref on purpose. Values the first paint needs (skin, colour
  mode, layout) are read synchronously in `useState` initialisers, not in an effect.

## Keyboard, focus, accessibility

- One owner per key: lists, find boxes and menus leave modified keys (Ctrl, Cmd, Alt) alone unless their shortcut uses
  them. Ctrl+Enter sends the request from anywhere.
- Escape closes the innermost thing first: an open menu or tooltip, then the text of a search box, then a running
  request, then a box on the whole screen.
- What an overlay covers is `inert`. A tooltip can be dismissed with Escape. A list has one tab stop (roving
  `tabIndex`), and the keyboard's position follows the focus.
- Every control has an accessible name: `aria-label` when its label is in another cell. Tabs point to their panel
  (`Tabs` with `panelId`), separators have `aria-valuemin` and `aria-valuemax`, outcomes are in a live region.

## Data from the server and from links

- JSON is never round-tripped through `JSON.parse` for display, copy or format: big numbers and duplicate keys
  change. Use `formatJson` and `buildLines` (`core/jsonlines.ts`).
- Downloads save the bytes as received. Text is decoded with the response's charset.
- Dictionaries built from URL input are null-prototype objects (`?toString=1` must not throw). A URL from a
  plugin descriptor is a link only when it is http(s) (`safeHref`).
- Validation and request building agree on what is sent (whitespace, required values), and only declared parameters
  are sent.
- A failed module and a module left out on purpose (`excluded`, `rest-v1`; `isSkipped`) look different.

## Secrets

- Header names: one whole-word rule, the same in `EchoResource.secret` and `userstore.isCredentialHeader`. Change both
  together, with their tests.
- Parameter names: a narrow list, so that `pageToken` or `author` are still stored. Request bodies are stored with
  secret-looking values removed, and history is kept per user.

## CSS and skins

- Colours come from tokens (`--rab-*`, defined from `--ds-*` with fallbacks). Literal colours appear only in token
  definitions.
- A skin's rule (`html .rab-n[data-skin=…]`, 0,2,1) beats the base dark theme (`[data-color-mode="dark"] .rab-n`,
  0,2,0). So every token a skin sets for light mode gets a dark value in the skin's dark block, unless it is built
  from tokens that switch by themselves.
- Text on a bold fill keeps 4.5:1 at both ends of its gradient. In dark mode the product's bold fills are light: pair
  them with `--ds-text-inverse`.
- A detail one skin wants different becomes a token with the old value as its fallback (`--rab-spinner-accent`,
  `--rab-grad-side-head`), not an override per skin.
- Two rules with the same specificity: the later one wins. Prefer a more specific selector to relying on order.
  Delete the rules a restyle replaces (for example `lozenges.css` replaced the old `.rab-n-tag` rules).
- The same control looks and behaves the same everywhere: all copy buttons show done and failed, every quiet icon is
  a `.rab-n-tool`, every count goes through `plural()`.
- Check a visual change in all three skins, in light and dark (`ui_next.js` switches them), at a narrow width.

## Before a commit

`cd src/main/frontend && npx tsc --noEmit -p . && npx vitest run`, then `mvn -B package`. For changes to the page,
also run `ui_next.js` on Jira and Confluence (see `src/test/product/README.md`).
