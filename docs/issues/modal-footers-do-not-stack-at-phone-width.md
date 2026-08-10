---
id: modal-footers-do-not-stack-at-phone-width
title: Only two of the app's ~30 Modal footers stack full-width at phone width - the rest keep a squeezed side-by-side row
type: improvement
severity: med
status: open
area: dashboard
created: 2026-08-06
refs: dashboard/src/routes/contact/Modal.module.css:78, dashboard/src/routes/listing/ListingDetail.tsx:1307, dashboard/src/routes/listing/ListingDetail.tsx:1392, dashboard/src/routes/listing/ListingDetail.module.css:396, dashboard/src/routes/shared/RosterConfirmDialog.module.css:76
---

**Problem.** `routes/contact/Modal` renders its `footer` prop into a bare flex
row (`Modal.module.css:78-85`: `display: flex; align-items: center;
justify-content: flex-end; gap: var(--sp-2)`) with no wrap and no breakpoint. At
360px the dialog is 328px wide and the footer's content box ~296px, so two
buttons stay side by side and shrink toward their min-content width instead of
stacking - readable, but a squeezed, small-target row on exactly the surface a
confirm needs to be unambiguous on.

Two callers now opt OUT of that by wrapping their buttons in a private stacking
div with a `@media (max-width: 860px)` rule (`flex: 1 1 100%`,
`flex-direction: column-reverse`, `align-items: stretch`, `> * { width: 100% }`),
which stacks them full width with the DEFAULT on top:

- `routes/shared/RosterConfirmDialog.module.css:76-94` `.actions` (the roster
  confirms - open-the-group-text, add-to-live-group)
- `routes/listing/ListingDetail.module.css:396-413` `.confirmActions` (the
  "Remove the primary contact?" confirm), added by contact-rosters spec 6.7

That is 2 of the 30 `<Modal` usages across 22 files. The other ~28 keep the bare
row - including two in the very file that gained the wrapper:
`ListingDetail.tsx:1307` ("Delete property?") and `:1392` ("Remove photo?"). So a
phone user meets two different footer behaviours in one page.

This is the correct scope for the branch that surfaced it: contact-rosters spec
6.7 verifies its OWN surfaces at 360px and deliberately did not widen to the
app's other dialogs. But the second hand-rolled copy of the same rule is the
signal that it wants to live one level down.

**Suggested fix.** Move the stacking into `Modal.module.css` `.footer` itself
(the same `@media (max-width: 860px)` block: `flex-wrap: wrap` /
`column-reverse` + full-width children), then delete both private wrappers.
`column-reverse` puts the LAST DOM child on top, which is already the house
convention for a Modal footer (the destructive/confirm action is written last so
desktop reads Cancel-then-confirm left to right), so most callers would inherit
the right order for free. Two things to check before doing it blind:

1. every footer with more than two children, or with a non-Button child (a
   status message, a checkbox), lands somewhere sensible when stacked;
2. `ui/Button.module.css`'s `width: 100%` is opt-in via `.block` (`:84-86`), so
   the stacking rule must set the width on the footer's children, exactly as both
   existing wrappers do.

860px is the right breakpoint - it is `ui/twoPaneShell.ts:17`
`TWO_PANE_BREAKPOINT_PX`, the same one both wrappers use.
