---
id: contact-list-checks-outside-roster-write-loop
title: The contact-list add decides the caseworker-seat and landlord-claim rules outside the roster write's retry loop
type: bug
severity: low
status: resolved
resolved: 2026-10-12
area: app
created: 2026-10-12
refs: app/src/repos/unitsRepo.ts:162, app/src/repos/unitsRepo.ts:916, app/src/routes/units.ts:1207, app/src/routes/units.ts:1210, app/test/helpers/twilioWebhookHarness.ts:2963, app/test/unitsRepoContactListRules.integration.test.ts, app/test/unitsApiRosterTypeChecks.test.ts:265, docs/superpowers/plans/2026-10-12-caseworker-integrity.md:9252
---

**Resolution (2026-10-12).** Fixed on `fix/caseworker-integrity`, fix wave 2
item FW2-1 (the R2 code review's challenge B-1 was accepted: auto-primary had
already put a contact-list rule inside the roster write's loop, and it widened
both races below - the re-seated caseworker or the claiming tenant also became
the property's primary contact). `unitsRepo.addContact` now takes the facts
the route read about the contact, `ContactListFacts { caseworker,
landlordTyped }` (`app/src/repos/unitsRepo.ts:162`), and decides both rules
on EACH attempt's own read of the unit, before the reassignment refusal
(`:916-917`): a NEW seat for a caseworker throws `ContactListCaseworkerError`,
and a claim of the vacant landlord slot by a contact not typed landlord throws
`LandlordClaimNotLandlordError`. The route keeps its pre-checks unchanged (the
no-race answer, in the spec's order), passes `{ caseworker:
isCaseworker(contact), landlordTyped: contact.type === 'landlord' }` from its
consistent contact read (`app/src/routes/units.ts:1207`) and maps the two
errors to the same 409s, `contact_list_caseworker` and `landlord_not_landlord`
(`:1210-1225`). The FakeWorld fake mirrors it
(`app/test/helpers/twilioWebhookHarness.ts:2963-2964`). The write is
conditioned on the roster and `landlordId` the attempt read, so the unit side
of both rules is now atomic with the write; only the contact's TYPE is still a
read before it (spec L1). Tests, each red with the fix reverted:
`app/test/unitsRepoContactListRules.integration.test.ts` (DynamoDB Local: the
I4 race in the route's window and in the add's own window - the second pins
the per-attempt decision - and the I3 race) and the two route probes in
`app/test/unitsApiRosterTypeChecks.test.ts:265` (FakeWorld, the race injected
after the route's reads: 409 with the right code, nothing written). Line
references in this paragraph are at the end of fix wave 2 (534f971d); the ones
below are as filed, before the fix.

**Problem.** `POST /api/units/:unitId/contacts` refuses a caseworker taking a
NEW seat (409 `contact_list_caseworker`, invariant I4) and a non-landlord
claiming a property's vacant landlord-of-record slot (409
`landlord_not_landlord`, I3). Both are decided on the route's consistent reads
(`app/src/routes/units.ts:1107` the unit, `:1116` the contact; the checks at
`:1131-1143`) before it calls `unitsRepo.addContact` (`:1149`). But
`addContact` (`app/src/repos/unitsRepo.ts:788`) reads the unit again on every
attempt (`:792`), decides "claim" on that read (`:807`), turns an absent row
into a NEW row (`:838-839`), and on a lost condition re-reads and re-runs
(`:862-883`) - with neither rule. A change landing between the route's read
and the repo's write is therefore not seen by the rule. Found by the R1 code
review of `fix/caseworker-integrity` (backend finding 1); both races were
reproduced through the FakeWorld routes:

- I4. Property U lists caseworker CW (a seat held from before the rule, kept
  editable on purpose - spec L2). Staff A posts `{ contactId: CW, role: 'pm',
  primaryContact: true }`; the route sees CW seated, so nothing is refused.
  Staff B's `DELETE /api/units/U/contacts/CW` commits. A's `addContact` reads
  U without CW, adds CW as a NEW row, makes it the primary and points
  `primary_contact` at it; its write is conditioned on the roster it just
  read, so it commits. Durable outcome: B's removal is undone and a
  caseworker holds a NEW seat as the property's primary contact (the
  relay-group and masked-call party).
- I3. U is soft-deleted and its `landlordId` L is no longer a landlord. Staff
  A posts `{ contactId: T (a tenant), role: 'landlord' }`; the route read
  shows a `landlordId`, so this is not a claim and no type check runs. Staff
  B's `POST /api/units/U/restore { landlordId: null }` commits (U live and
  ownerless). A's `addContact` reads U with no `landlordId` and claims the
  vacant slot (`:807`, `:857`). Durable outcome: a tenant is the landlord of
  record of a LIVE property. (Had A's repo read been stale, it would have
  answered 409 `landlord_reassignment_required` instead.)

**Why this is narrower than spec L1.** L1 (spec
`docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md` section 6;
RUNBOOK "The contact-type checks are reads, not locks") is about index reads
that cannot be made consistent. Here both route reads are consistent, and the
repo's attempt loop is already fenced on exactly the roster and `landlordId`
it reads. The window exists only because the rule is evaluated outside that
loop, so closing it needs no lock.

**Why it was built this way.** The plan kept both checks in the route on
purpose: its S4 contract issue 1
(`docs/superpowers/plans/2026-10-12-caseworker-integrity.md:9252`) names this
residual window, and the planner ruled it "ACCEPT (L1 class)" (ruling S4-1,
`docs/superpowers/reviews/2026-10-12-caseworker-integrity/plan-research/plan-assembly-rulings.md:64`).
The plan's rejected alternative is the fix below - it changes the core of a
shared repo method and needs a parity change in its fake - and the spec
prescribes "both before the repo call" (section 4, "Contact list"). So this is
a design change for Cameron to decide, not a defect of that build.

**Suggested fix.** Carry the rule into `addContact`'s attempt loop: an input
such as `{ newSeatAllowed: !isCaseworker(contact), claimAllowed:
contact.type === 'landlord' }`, checked on EACH attempt's read and throwing
typed errors that the route maps to the same two 409s
(`contact_list_caseworker`, `landlord_not_landlord`). Keep the route's
pre-checks for the common no-race answer, and mirror the change in the
FakeWorld fake (`app/test/helpers/twilioWebhookHarness.ts:2941`, its
`addContact`). Regression test: a DynamoDB Local case in the style of the
`racingRepo` helper in `app/test/unitsRepoRestoreWithLandlord.integration.test.ts`
that removes CW's row (or the `landlordId`) right after the first
`GetCommand`, expecting the typed refusal and an unchanged roster; it fails
with the fix reverted.
