---
id: tours-placements-no-contact-type-check
title: Tours, placements, a property's landlord of record and its contact list check no contact type, so a caseworker can be given what the conversion refused
type: bug
severity: low
status: resolved
resolved: 2026-10-12
area: app/tours
created: 2026-10-08
refs: app/src/routes/tours.ts, app/src/routes/placements.ts, app/src/services/statusTransition.ts:336, app/src/jobs/tourReminders.ts:1093, app/src/routes/tourReminders.ts:1027, app/src/routes/units.ts, app/src/lib/unitFields.ts, app/src/repos/unitsRepo.ts, app/src/services/contactTypeGuards.ts
---

**Problem.** The caseworker conversion (`feat/caseworkers`, spec D19)
refuses a contact with an open tour or placement, but those are reads before
its write and nothing re-checks later: neither the tours routes nor the
placements routes check the contact's type when a tour or placement is
created or reopened, so a caseworker can be given an open tour or placement
afterwards (the race between the conversion's reads and its write is the same
gap, narrower). Then: `deriveTenantStatus` (`statusTransition.ts:335`) writes
TENANT statuses (searching, placing, ...) onto whatever contact a placement
names, a caseworker included; and a tour reopened after a conversion has NO
reminder thread - the conversion re-typed the contact's thread to
`partner_1to1`, and reminders look only for `tenant_1to1` or `unknown_1to1`
(`jobs/tourReminders.ts:1093`, `routes/tourReminders.ts:1027`), so every rung
finds no conversation. The same holds for the conversion's other two
refusals (plan review R1 ruling A4): a property's landlord of record and its
contact list. The units routes set `landlordId` (create, and the unit PATCH -
`app/src/routes/units.ts`, validated only as a non-empty string by
`app/src/lib/unitFields.ts`) without reading that contact's type, and the
roster edits (`app/src/services/rosterEdits.ts`, which pass the owner's type
through but never check the added contact's) add any contact to a
property's contact list - so after a conversion refused "landlord of
record" or "on a property's contact list", staff can make the caseworker
exactly that. Pre-existing guard gaps; accepted for branch B.

**Suggested fix.** Refuse a tour or placement whose tenant is not typed
`tenant` (or `unknown`, for triage) on create and reopen, with a sentence
naming the contact's kind; make `deriveTenantStatus` skip a contact that is
not a tenant. Decide (Sam and Cameron) whether a caseworker may be a
property's landlord of record or sit on its contact list: if not, the unit
create / PATCH `landlordId` write and the roster add refuse a contact for
which `isCaseworker` (`app/src/lib/caseworkers.ts`) holds, with a sentence
naming why. Related: `contact-retype-skips-caseworker-refusals`.

**Resolution (2026-10-12).** Fixed on `fix/caseworker-integrity` (spec
`docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md`, D3;
Cameron's rulings 2026-10-12), with the shared checks in
`app/src/services/contactTypeGuards.ts` (consistent contact reads):

- Tours and placements are for tenants ONLY. The "(or `unknown`, for
  triage)" suggested above was declined: no flow gives an unknown contact a
  tour or placement (the pickers load tenants only), so `unknown` is refused
  like every other non-tenant. `POST /api/tours`, a tour PATCH that moves a
  canceled tour to an open status, `POST /api/tours/:id/reopen`,
  `POST /api/placements`, `POST /api/placements/from-tour`, and a placement
  move from `lost` / `moved_in` to an open stage (checked in the transition
  service, so every caller is covered) answer 404 `tenant_not_found` for a
  missing contact and 409 `{ error: 'contact_not_tenant', contactKind }` for
  one not typed `tenant`; the dashboard says "Tours and placements are for
  tenants. This contact is a landlord." (or a partner, a caseworker, a
  team member, not classified yet). `deriveTenantStatus` writes nothing onto a
  non-tenant. A team member's page no longer offers "+ Schedule" or "+ Start
  placement".
- A property's landlord of record: `POST /api/units`, a unit PATCH that
  changes `landlordId`, and a Landlord-role contact-list add that claims a
  vacant slot refuse a contact not typed `landlord` with 409
  `landlord_not_landlord` (a missing contact is 404 `landlord_not_found` on
  unit create and PATCH; the contact-list add keeps its 404
  `contact_not_found`). Restoring a deleted property whose landlord is no
  longer a landlord answers 409 `restore_needs_landlord`, and the property
  page asks: Restore with this landlord (a landlords-only picker) or Restore
  without a landlord.
- Its contact list: `POST /api/units/:id/contacts` refuses a caseworker a NEW
  seat (409 `contact_list_caseworker`), and the Add contact search no longer
  offers caseworkers. Seats held before the deploy stay editable.

**Correction to the record above.** The property contact-list add is
`POST /api/units/:id/contacts` in `app/src/routes/units.ts` (repo
`addContact`, `app/src/repos/unitsRepo.ts`), not
`app/src/services/rosterEdits.ts`, which edits tour and placement RELAY
rosters. And the reopen gap named above was wider for placements: a placement
can leave `lost` or `moved_in` for ANY stage with no guard at all. This
branch adds only the tenant check on that path; whether the exit should be
allowed is filed as `placement-terminal-stage-exit-unguarded`. Also out of
scope and filed: the importer's re-type and `landlordId` writes
(`import-bypasses-contact-type-rules`). Limits: the checks are reads before
writes, not locks (spec L1), and records made before the deploy were not
swept (L2).
