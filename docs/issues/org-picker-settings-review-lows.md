---
id: org-picker-settings-review-lows
title: Org pickers and the organization Settings tab - low findings from the final independent review (stale lists, dialog edges, a11y, keyboard, e2e debt)
type: debt
severity: low
status: open
area: dashboard
created: 2026-10-07
refs: dashboard/src/routes/orgs/OrgPicker.tsx, dashboard/src/routes/orgs/NewOrgDialog.tsx, dashboard/src/routes/orgs/useOrgList.ts, dashboard/src/routes/settings/OrgListSection.tsx, dashboard/src/routes/settings/NotOnListSection.tsx, dashboard/src/routes/contact/ContactEditForm.tsx, dashboard/src/routes/listing/ListingEditForm.tsx, dashboard/src/routes/listing/UnitCreateForm.tsx, dashboard/src/routes/broadcasts/AudienceFilters.tsx, e2e/tests/dashboard-next/org-lists.spec.ts
---

**Problem.** The final independent review of `feat/clean-org-names` (plan-blind dashboard
reader; report `docs/superpowers/reviews/2026-10-06-clean-org-names/final-review/adversarial-frontend.md`,
rulings in `final-review/adjudications.md`) found these LOW items. None changes stored
data: the server refuses every duplicate and every off-list value regardless. Grouped here
because they share one area and one review; pick them off individually.

Pickers and the "Is this really new?" dialog:

1. **Lists go stale (L1).** Each picker reads the org list once per mount and never
   re-reads it - not even after the server answers 422 `org_not_on_list` for a name the
   picker offered (renamed or deleted meanwhile); the composer cannot see an entry added
   after it mounted; provisional names (`useOrgList.ts` noteAdded) never expire. Re-read on
   a 422 and on dialog open.
2. **A false "Couldn't load" (L2).** When a RE-read fails while a list is already in hand,
   the tenant and property pickers still show the load alert although the list in hand
   serves them (`ContactEditForm.tsx`, `ListingEditForm.tsx`, `UnitCreateForm.tsx`).
3. **"Yes, add it" enabled early (L3).** In `NewOrgDialog.tsx` a stale `failedFor` from an
   earlier failed close-name check enables the add button before the current check lands,
   and leaves the old failure alert beside a fresh answer - a near-duplicate can be added
   without seeing the close names. (The server still refuses an exact or normalized
   duplicate; Merge repairs a near one.)
4. **Cancel loses the typed text (L4).** Choosing "Add ... as new" empties the field before
   the dialog opens (`OrgPicker.tsx`), so Cancel leaves the field blank. Restore the text on
   Cancel.
5. **A hung `/check` never recovers (L5).** No timeout on the close-name check: the dialog
   or the suggestion chip can stay stuck (`NewOrgDialog.tsx`, `ContactDetail.tsx`). A
   timeout with "could not check - add anyway?" copy.
6. **Keyboard gaps (L9).** ArrowDown does not reopen a dismissed listbox, and the
   highlighted option is never scrolled into view.
7. **A 403 reads as "try again" (L11).** A `forbidden` answer gets the generic retry copy.

Settings tab:

8. **Status changes are not announced (L7).** The Run-again notice, the polled status line
   and a repeated identical 422 have no live region, so a screen reader hears nothing.
9. **Ambiguous row-button names (L8).** "Clear" and "Show records" in the Not-on-the-list
   rows do not name the value they act on (accessible name = the bare verb).
10. **Stale rows stay actionable (L10).** After a failed details re-read, the
    Not-on-the-list rows remain and nothing shows the error.
11. **Settle buttons do not wrap at 360 px (I5).** The row's four actions widen the table
    (it scrolls inside its wrapper; no page overflow).

E2E debt:

12. **16 older specs still create units with the `atlanta_housing` slug** through
    `POST /api/units` (conformance review; frontend I6). They pass only because the slug
    normalizes to the seeded spelling "Atlanta Housing" and the server stores the exact
    name - if that spelling is ever removed on Settings in the lean world the specs break
    far from the cause. Sweep them to `'Atlanta Housing Authority'`.
13. **`org-lists.spec.ts` gaps (L12).** A fixed 1.5 s wait as a negative check (can only
    false-pass), a row lookup by text substring that can match another row, and no coverage
    of 360 px, the page's own polling, or the composer's 422 path.

**Suggested fix.** One small-fix branch (items 1-11 are dashboard-only; 12-13 are
e2e-only and can ride along). Items 1, 3 and 4 first - they are the ones a staff member
meets.
