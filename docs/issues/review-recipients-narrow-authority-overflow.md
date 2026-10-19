---
id: review-recipients-narrow-authority-overflow
title: On a narrow screen, a long housing authority name runs past its Review recipients row and the list scrolls sideways
type: bug
severity: low
status: open
area: dashboard/broadcasts
created: 2026-10-19
refs: dashboard/src/routes/broadcasts/RecipientPreview.module.css:224-229, app/src/lib/orgStartingList.ts
---

**Problem.** In the Matching composer's Review recipients list, the NARROW
(stacked, review pane under 768 px) layout puts status, housing authority and
last heard from in a wrapping flex row (`.cellFacts`), but `.cellAuthority` is
`flex: 0 0 auto` (`dashboard/src/routes/broadcasts/RecipientPreview.module.css`,
the `.cellStatus, .cellAuthority, .cellHeard` rule), so the authority cannot
shrink or wrap: a name wider than the row runs past it and the list scrolls
sideways. Measured on a hermetic lane (feat/matching-blast-rules self-QA,
2026-10-19) with a 99-character stress name: the row was 654 px wide in a
280 px list at a 360 px viewport. The longest real list name, "HUD-Veterans
Affairs Supportive Housing (HUD-VASH)" (50 characters,
`app/src/lib/orgStartingList.ts`), is long enough to do it on a phone. The
wide layout is fine (the column ellipsizes).

Pre-existing: the stacked layout came with the last-heard-from columns; the
matching-blast-rules branch fixed the same pattern for the row TAGS (its
self-QA finding QA-L1, commit c3e8118b) but left this cell alone as out of
its scope.

**Suggested fix.** In the stacked layout only, let the authority shrink and
wrap: `.cellAuthority { flex: 0 1 auto; min-width: 0; }` under the
`@container (max-width: 767.98px)` query (the wide layout keeps its ellipsis).
Measure at 360 / 414 / 600 px with the 50-character name before and after.
