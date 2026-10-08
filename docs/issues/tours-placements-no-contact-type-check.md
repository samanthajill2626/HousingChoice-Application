---
id: tours-placements-no-contact-type-check
title: Tours, placements, a property's landlord of record and its contact list check no contact type, so a caseworker can be given what the conversion refused
type: bug
severity: low
status: open
area: app/tours
created: 2026-10-08
refs: app/src/routes/tours.ts, app/src/routes/placements.ts, app/src/services/statusTransition.ts:335, app/src/jobs/tourReminders.ts:1093, app/src/routes/tourReminders.ts:1027, app/src/routes/units.ts, app/src/lib/unitFields.ts, app/src/services/rosterEdits.ts
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
