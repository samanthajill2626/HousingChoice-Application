# RF2 - invariant sweep findings: I3, I4, ownerless properties

Reader RF2 (read-only invariant sweep), 2026-10-12. Branch
`fix/caseworker-integrity` @ 670fb701, base main @19607658 (product code
identical to main). Full inventory (writers and readers per protected state,
with file:line and classification):
`.superpowers/sdd/research/RF2-invariants-I3-I4-reference.md`.

Result: no BLOCKER, no CORRECTION. Every writer of `landlordId`, of
contact-list seats and of `primary_contact` that real code can reach is
listed by the spec or plan (create, PATCH, roster claim, restore,
restore-with-landlord; importer OOS; seeds 5.1; `primary_contact` on
create/PATCH filed as `unit-primary-contact-unchecked`). Of 37 readers of the
protected state (22 app, 15 dashboard), exactly one crashes on an ownerless
live unit - `ListingDetail.tsx:473` - and plan Task 4.13 covers it. Three
NOTEs follow.

---

## N1 - NOTE - The ownerless "Remove the primary contact?" notice states a fallback that does not exist

- Where: `dashboard/src/routes/listing/ListingDetail.tsx:478` (copy inside
  `promotionNotice`, :471-479). Plan Task 4.13 Step 1 (plan line ~12476) adds
  a test pinning that sentence for the ownerless case; the existing test
  `names the NO-primary outcome ...` (`ListingDetail.test.tsx:1467`) pins it
  with `landlordId: ''`. Origin: contact-rosters plan
  (`docs/superpowers/plans/2026-08-04-contact-rosters.md:479-483`).
- The sentence: "This property will have no primary contact - tours fall back
  to the landlord of record." That branch renders ONLY when the property has
  no landlord of record (`landlordOfRecord.length > 0` is false; for any
  non-empty value `promoted` is always defined). With no primary row and no
  `landlordId`, every resolver finds NO property contact
  (`app/src/lib/rosterResolution.ts:292-297`, `app/src/lib/tourContacts.ts:124-129`,
  `app/src/services/rosterProvision.ts:230-236`): relay groups are too thin to
  open and landlord-led tour reminders fall back to the self-guided copy. So
  the sentence is false every time it shows.
- Reachable path: restore a property without a landlord (spec section 4) whose
  contact list keeps another row marked primary (for example a property
  manager), then Edit contacts -> Remove that row. Before this branch only
  legacy ownerless properties (importer-created, `apply.ts:1507-1510`) reached
  it, and the dialog crashed there; after Task 4.13 it renders this sentence in
  a state the branch makes routine.
- Recommended handling: an in-scope one-line copy fix if the planner / Cameron
  accept it (for example "This property will have no primary contact - tours
  and placements on it will have no property contact until one is added."),
  updating the expected text in the 4.13 test and the existing test at
  `ListingDetail.test.tsx:1467`. Otherwise file it as a low copy issue. Not
  blocking: the crash fix stands either way.

## N2 - NOTE - `PATCH /api/units/:id` with a changed `landlordId` leaves the contact list's landlord row stale

- Where: `app/src/routes/units.ts:1466` (`units.update(unitId, validation.fields)`)
  -> `app/src/repos/unitsRepo.ts:662-705` (SETs only the supplied keys;
  `contacts[]` and `primary_contact` untouched). Contrast `addContact`
  (`unitsRepo.ts:780-824`, landlord row role-pinned, primary kept consistent)
  and the branch's own restore-with-landlord (spec section 4: old landlord's
  row removed, a role-`landlord` row for the new one, primary kept
  consistent, in one conditional write).
- Reachable path: API only. No dashboard screen sends `landlordId` on a PATCH
  (`ListingEditForm.tsx:140-215`, `PlacementDetail.tsx:622`) and no e2e
  fixture does. `PATCH { landlordId: Y }` on a property whose stored
  `contacts[]` holds the old owner X (role `landlord`, often primary): after
  plan Task 4.3 (Y must be typed landlord) the write lands with Y absent from
  the contact list, and X still seated as "Landlord", still primary, and no
  longer the landlord of record - so X's row becomes removable and D2 lets X be
  re-typed while still seated as "Landlord". Readers then disagree:
  `unitContacts` serves only X's row (the property page never lists Y; relay
  groups and reminders route to X as the primary); removing X's primary row
  names "Y" by raw id in the dialog and sets `primary_contact` to Y with no row
  carrying the flag (`unitsRepo.ts:899-906`).
- No invariant breaks (I3: Y is a landlord; I4: no caseworker), and the state
  is recoverable in the dashboard (Add contact Y with role Landlord seats Y's
  pinned row). Pre-existing; unlisted because spec section 4 / plan 4.3 asks
  this surface only for the type check, as specified.
- Recommended handling: no code change in this branch (reassignment is a
  non-goal, spec section 10). Add one sentence to the Problem paragraph of the
  filed `landlord-of-record-no-reassign-ui` (plan S5 Step 3): today's API
  PATCH reassign changes `landlordId` without the row swap, so the future
  "Change landlord of record" action should reuse `restoreWithLandlord`'s
  single conditional write (or a row-swap helper extracted from it), not the
  bare PATCH.

## N3 - NOTE - Spec section 5 names one seat writer; the branch adds a second

- Where: spec section 5, "Contact-list seats: `POST /api/units/:id/contacts`
  only." The branch's restore-with-landlord (spec section 4; plan Task 4.5)
  also gives a seat: a role-`landlord` row for the new landlord. Separately,
  every `landlordId` writer is an implicit seat writer on a unit with no stored
  `contacts[]` (the derived row, `unitsRepo.ts:296-305`).
- I4 still holds on every one: the restore seat and every derived seat require
  a contact typed `landlord`, and a caseworker is a `partner`
  (`app/src/lib/caseworkers.ts:86`). The importer is the only exception, and it
  is out of scope (filed).
- Recommended handling: no action. This only corrects the record; nothing in
  the plan depends on the "only".
