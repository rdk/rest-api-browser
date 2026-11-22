# Long lines in Pretty

Status: later · Area: new UI, response viewer · Effort: S (half a day) · Added: 2026-11-23

## Goal

A long JSON value (a base64 avatar, an HTML description) can be read in full in Pretty, by scrolling sideways or
by wrapping, instead of being cut.

## Why

`Response.tsx` cuts a Pretty line after 2,000 characters and adds "… N more characters (see Raw or Download)":
one DOM text node of megabytes would freeze the tab, and the virtual list needs fixed 20 px rows. Raw splits long
lines into rows instead, which keeps everything but breaks the layout of the value.

## Approach

1. Keep the virtual list's fixed rows; make the code area scroll horizontally (`white-space: pre` and a min-width
   from the longest visible line, measured in characters), up to a cap of, for example, 20,000 characters.
2. Past the cap, keep the cut, with a button that opens the whole value in a dialog (a `<textarea readonly>`,
   which handles megabytes).
3. A "Wrap" toggle in the find bar for those who prefer wrapping (the line's height then varies: render wrapped
   lines outside the virtual list only when the response is small).

## Risks and open questions

- Horizontal scroll and the fold buttons: the buttons should stay visible (sticky) while scrolling sideways.

## Done when

- A 10,000-character value scrolls in full in Pretty; a 1 MB value still opens without freezing the tab.
