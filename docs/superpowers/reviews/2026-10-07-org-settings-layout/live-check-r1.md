# Org settings layout - live check round 1

Date: 2026-10-07. Tip: `9715c677`, the cloud build, plus records `bbdcd023`.
Hermetic `npm run e2e:session` on lane 5, full reseed profile, with the same
eight off-list values planted through `POST /__dev/org-fixture` as in the
design review. Run as dev-login admin (founder) and VA. The session was stopped
afterwards. Screenshots are `.playwright-mcp/org-built-*.png` (gitignored).

## Gates on this tip

- `npm run e2e` (full suite): **329 passed (18.4m), exit 0**. This includes
  the rewritten Settings and "Not on the list" org-lists specs, which the cloud
  agent could not run.

## Matches the mockup (Option B)

- 1280 admin: segments with counts (12 / 7 / 8), a search box, the list with
  per-row totals ("28 records" / "Not used"), and a placeholder panel. Picking
  Atlanta moves focus to the panel `h2` and the URL becomes
  `/settings/organizations/org-seed-01`. Spellings render as five chips, with
  "Atlanta, aha, Atlanta housing" as one chip. The actions are labeled
  buttons with Delete set apart.
- "Not on the list": `DCA / Step Up` round-trips as `value=DCA+%2F+Step+Up`.
  The settle radios are in `settleChoices` order with Clear set apart. Picking
  Split shows the inline confirm with both pickers prefilled.
- 1920: the page fills the main column; the panel's notes stay at reading
  width.
- 390 admin: one pane at a time; the segments sit in one row with the count
  under each label. No horizontal scroll (document, main scrollWidth = 390).
  "Back to Housing authorities" returns focus to the row link.
- VA: a value panel has no settle group and no radios; an entry panel offers
  only "Edit notes". Admin controls are absent, not disabled.
- Full width on other tabs at 1920: Templates' textareas stop at about 770px
  and the quick-reply input at about 510px. Team's invite email is about 385px,
  and Role sizes to its options. Neither stretches.

## Reproduced live

- **F2 confirmed:** add "Zeta Review Agency" (the panel opens), Delete it (the
  list shows), then browser Back to `/settings/organizations/<id>`. The panel
  renders the deleted entry with a live "Delete Zeta Review Agency" button,
  instead of "Name not found".

## New minor finding

- M7. The phone Back link's accessible name is "‹ Back to Housing
  authorities": the decorative chevron is read aloud. Mark the glyph
  `aria-hidden`.

F1 (an in-flight settle is not locked) was not reproduced live. The window is
a single request's latency on a local stack. It stands on the code reading in
`code-review-r1.md`.
