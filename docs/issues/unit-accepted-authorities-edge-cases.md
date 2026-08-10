---
id: unit-accepted-authorities-edge-cases
title: accepted_authorities edge cases - a re-import flattens a curated list, and [''] reaches the public flyer
type: bug
severity: low
status: open
area: app
created: 2026-08-10
refs: app/src/lib/import/apply.ts:763,app/src/lib/import/apply.ts:797,app/src/lib/unitFields.ts:129,dashboard/src/routes/public/FlyerPage.tsx:249
---

**Problem.** Two independent low-severity edge cases in the unit `accepted_authorities` field
introduced by the tenant-list-visibility feature (spec section 8). Both are filed rather than fixed
because each needs a product decision, not a repair.

**1. A re-import silently flattens a hand-curated multi-authority list.** The import's unit writer
sets `accepted_authorities` as a plain SET (`app/src/lib/import/apply.ts:797-800`); only
`status` and `created_at` use `if_not_exists` (`:763-769`). The workbook column is single-valued, so
the importer can only ever write a ONE-item list - while the unit edit form is the only way a
plural list can exist at all. So a landlord's curated "accepts AHA, DCA and Fulton County" is
reduced to the single imported value by the next import run, with no warning. Re-importing IS a
supported operation.

**2. `['']` passes validation and renders a bare public "Accepts:".** `isStringArray`
(`app/src/lib/unitFields.ts:129-131`) accepts an array of empty strings, so
`accepted_authorities: ['']` is a legal PATCH value. Every internal consumer guards against it, but
the UNAUTHENTICATED public flyer does not (`dashboard/src/routes/public/FlyerPage.tsx:249-252`
checks list length, not member content), so the flyer renders an "Accepts:" label with nothing after
it. API-only: neither unit form can produce it, since both split on comma and drop empties.

**Suggested fix.** For (1), decide whether the importer should merge into or replace the stored list
- a union with the existing value preserves curation but makes a deliberate removal un-doable by
re-import, so this is the founder's call, and whichever way it goes the import summary should report
it. For (2), reject or strip empty members in the unit field validator (a `.filter(Boolean)` on the
parsed list, or a stricter `isStringArray` for this field) and pin it with a route test plus a flyer
render assertion.

Found by the adversarial reviewer (round 2, findings R2-3 and R2-4) during the
tenant-list-visibility mission.
