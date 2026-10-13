---
id: contact-list-rule-duplication-and-fake-drift
title: The contact-list seat, claim and primary rules are written out in several places, and the FakeWorld hand copies can drift from the real repo
type: debt
severity: low
status: open
area: app
created: 2026-10-13
refs: app/src/routes/units.ts:1220, app/src/routes/units.ts:1226, app/src/repos/unitsRepo.ts:922, app/src/repos/unitsRepo.ts:937, app/src/routes/units.ts:467, app/src/repos/unitsRepo.ts:1312, app/src/repos/unitsRepo.ts:1021, app/src/repos/unitsRepo.ts:1060, app/src/repos/unitsRepo.ts:1111, app/src/services/contactTypeGuards.ts:71, app/src/services/contactTypeGuards.ts:88, app/src/routes/units.ts:148, app/src/routes/units.ts:1196, app/src/routes/contacts.ts:1532, app/test/helpers/twilioWebhookHarness.ts:2839, app/test/helpers/twilioWebhookHarness.ts:2944, app/test/helpers/twilioWebhookHarness.ts:3125
---

**Problem.** Found by the caseworker-integrity final review (A7,
`docs/superpowers/reviews/2026-10-12-caseworker-integrity/final-review/adversarial.md`
finding 7). Rules the contact list depends on are written out by hand in
more than one place, so a change to one copy can silently miss another:

- The SEAT and CLAIM definitions exist twice: the contact-list route's
  pre-checks (`app/src/routes/units.ts:1220`, `:1226-1227`) and the repo's
  per-attempt decision in `addContact` (`app/src/repos/unitsRepo.ts:922-926`,
  `:937-938`).
- "The cleared landlord was the primary" exists twice: the route's
  `soleLandlordToPromote` (`units.ts:467-468`) and the repo's
  `restoreWithLandlord` (`unitsRepo.ts:1312-1313`).
- The routing-pointer test (`phone_ref === true || email_ref === true`) is
  repeated in `app/src/services/contactTypeGuards.ts:71`, `:88`,
  `units.ts:148-149` (`autoRoutingEligible`), `:1196` and
  `app/src/routes/contacts.ts:1532`.
- The FakeWorld `addContact` and `restoreWithLandlord`
  (`app/test/helpers/twilioWebhookHarness.ts:2944`, `:3125`) are
  line-for-line hand copies of the real repo's, so a rule changed in the repo
  and not in the fake still passes every FakeWorld route test. The fix waves
  kept them in step by hand (FW2-1, FW2-11, FW2-12, FWF-3).
- FakeWorld's `unitsRepo.getById` returns the LIVE map object
  (`twilioWebhookHarness.ts:2839-2841`), so a route test that simulates a
  concurrent change by mutating `unit.contacts` in place passes an
  `isDeepStrictEqual` guard vacuously - both sides are the same reference.
  Fix wave FW3-2 had to read the restore route's contact list once, before
  its awaits, for this reason (`listRead`).

The review's fifth point - `addContact`'s per-attempt refusals were decided
on an eventually consistent read - was fixed in fix wave FWF-5 (that read is
consistent now). Its re-read after a lost write, which can refuse
`landlord_reassignment_required` before any retry, is consistent too since
final review round 2 R2-4 (fix wave FWF2, `app/src/repos/unitsRepo.ts:1021`).
`removeContact`'s reads are still eventually consistent: its per-attempt read
(`unitsRepo.ts:1060`), which throws `CannotRemoveLandlordOfRecordError` and
the "not on the roster" 404 with no write to confirm them (`:1069-1080`), and
its re-read after a lost write (`:1111`). Pre-existing and untouched by this
branch; a lagging replica can answer a spurious 409 or 404 that a retry
corrects.

**Suggested fix.** Export one pure `contactListDecision(unit, contactId,
role, facts)` from `unitsRepo` and call it from both the route's pre-check
and the repo's attempt loop; likewise an `oldLandlordWasPrimary(unit,
contactId)` helper and an `isRoutingPointer(contact)` helper (contacts
repo). Have the fake call the same pure helpers instead of copying them, and
have its `getById` return a `structuredClone`. Deferred by the planner's
ruling because the shared-helper refactor and the clone change touch many
tests.
