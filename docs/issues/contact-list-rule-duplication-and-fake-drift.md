---
id: contact-list-rule-duplication-and-fake-drift
title: The contact-list seat, claim and primary rules are written out in several places, and the FakeWorld hand copies can drift from the real repo
type: debt
severity: low
status: open
area: app
created: 2026-10-13
updated: 2026-10-13
refs: app/src/routes/units.ts:1869, app/src/routes/units.ts:1875, app/src/repos/unitsRepo.ts:922, app/src/repos/unitsRepo.ts:937, app/src/routes/units.ts:467, app/src/repos/unitsRepo.ts:1312, app/src/repos/unitsRepo.ts:1021, app/src/repos/unitsRepo.ts:1060, app/src/repos/unitsRepo.ts:1111, app/src/services/contactTypeGuards.ts:71, app/src/services/contactTypeGuards.ts:88, app/src/routes/units.ts:148, app/src/routes/units.ts:1846, app/src/routes/contacts.ts:1532, app/test/helpers/twilioWebhookHarness.ts:2839, app/test/helpers/twilioWebhookHarness.ts:2944, app/test/helpers/twilioWebhookHarness.ts:3125
---

**Problem.** Found by the caseworker-integrity final review (A7,
`docs/superpowers/reviews/2026-10-12-caseworker-integrity/final-review/adversarial.md`
finding 7). Rules the contact list depends on are written out by hand in
more than one place, so a change to one copy can silently miss another:

- The SEAT and CLAIM definitions exist twice: the contact-list route's
  pre-checks (`app/src/routes/units.ts:1869`, `:1875-1876`) and the repo's
  per-attempt decision in `addContact` (`app/src/repos/unitsRepo.ts:922-926`,
  `:937-938`).
- "The cleared landlord was the primary" exists twice: the route's
  `soleLandlordToPromote` (`units.ts:467-468`) and the repo's
  `restoreWithLandlord` (`unitsRepo.ts:1312-1313`).
- The routing-pointer test (`phone_ref === true || email_ref === true`) is
  repeated in `app/src/services/contactTypeGuards.ts:71`, `:88`,
  `units.ts:148-149` (`autoRoutingEligible`), `:1846` and
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

**Update (2026-10-13, `feat/primary-contact-integrity`): the PRIMARY half
is shared now; the seat and claim half and the live-object `getById` are
still open.** What changed:

- "The cleared landlord was the primary" is ONE shared pure rule,
  `landlordWasPrimary(roster, landlordId)` (`app/src/repos/unitsRepo.ts`),
  called by `restoreWithLandlord`, the restore route (`clearedLandlordHeir`,
  which replaced `soleLandlordToPromote`) and the FakeWorld (commits
  11b05393, d7991940). It no longer reads the `primary_contact` scalar.
- Every PRIMARY decision in the FakeWorld's `addContact`, `removeContact`,
  `restoreWithLandlord` and new `handOffPrimaryFrom` calls the same pure
  functions as the real repo - `autoPrimaryLivenessIds` /
  `decideAutoPrimary` (`unitsRepo.ts`) and `chooseHeir` / `applyPrimary`
  (`app/src/lib/propertyContact.ts`) - instead of copying them, and
  `app/test/primaryHandoffParity.integration.test.ts` pins the real repo and
  the fake to the same result on nine cases - five removes, two delete
  hand-offs, a restore swap and an add (f44a4c3a).
- `removeContact`'s per-attempt read and its re-read after a lost write are
  consistent now (b198e2e0), so the spurious 409 / 404 from a lagging replica
  described above is gone.

Still open: the SEAT and CLAIM definitions are still written out in the
route's pre-checks and again in the repo's per-attempt decision, and the
fake's `addContact` still hand-copies them - joined by a third hand-written
rule, the 409 `primary_contact_deleted` refusal (route, repo and fake each
decide it; plan ruling R8). The routing-pointer test moved rather than
merged: `units.ts` `autoRoutingEligible` is now `isAutoRoutingEligible` in
`app/src/lib/propertyContact.ts` (c28493f5, bcb6f834), and the copies in
`contactTypeGuards.ts`, the contact-list route and `routes/contacts.ts`
remain. FakeWorld's `unitsRepo.getById` still returns the live map object.
The refs above are the pre-change locations.
