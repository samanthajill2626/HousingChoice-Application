# R1 adversarial code review - backend (app/) - fix/caseworker-integrity

- Round 1, adversarial, backend half. Branch `fix/caseworker-integrity`, base
  `19607658` (merge base with main) .. head `f11e46fb`; the change reviewed is
  `.superpowers/review/r1-backend.diff`, read in full against the worktree.
- Plan-blind: nothing under `docs/superpowers/` was opened (this file is the
  only thing written there). Intent was derived from the code, the tests,
  `docs/issues/` and `RUNBOOK.md`.
- Method: every consumer and mutator of the touched state was swept repo-wide
  (contact type/role/classification_revision writers; tour, placement and
  unit writers; ownerless-unit readers). Probes ran only after
  `.superpowers/sdd/logs/p3-e2e.exit` existed (`exit=0`, 345 passed), one
  vitest file at a time. Throwaway tests:
  `app/test/zz-review-advb-units-race.test.ts` (FakeWorld, through the real
  routes and service) and `app/test/zz-review-advb-restore-live.integration.test.ts`
  (real `unitsRepo` on DynamoDB Local). Each throwaway case asserts the
  behavior the invariant needs, so a FAILURE reproduces the defect. Mutants
  were applied with the Edit tool and reverted byte-identically (hashes at the
  end).

Counts: BLOCKER 0, HIGH 0, MEDIUM 0, LOW 2, INFO 8.

---

## 1. LOW - CONFIRMED - the contact-list add decides I4 (new seat) and I3 (vacant-slot claim) on the route's read, but `addContact` re-reads and re-decides without either rule

Location: `app/src/routes/units.ts:1107` (the route's consistent unit read),
`:1131-1143` (seat and claim checks on that read), `:1149` (repo call);
`app/src/repos/unitsRepo.ts:782` (the repo's own, eventually consistent read
on every attempt), `:797` (claim decided on the repo's read), `:807-830` (an
absent row becomes a NEW row), `:852-873` (on a lost condition: re-read and
re-run). The comment at `routes/units.ts:1123` says the checks are "decided
... with the repo's own definitions", but they are evaluated on a different
snapshot than the one the repo's conditional write is fenced on.

Interleavings (durable outcome in the last step):
- I4. Unit U lists caseworker CW (a seat held before these checks, kept
  editable by L2). Staff A: `POST /api/units/U/contacts {contactId: CW, role:
  'pm', primaryContact: true}`; the route reads U, CW is seated, no I4
  refusal. Staff B: `DELETE /api/units/U/contacts/CW` commits. A: `addContact`
  reads U without CW, pushes CW as a NEW row, makes it the primary and points
  `primary_contact` at it; its write is conditioned on the roster it just read,
  so it commits. B's removal is silently undone and a caseworker holds a new
  seat as the property's primary contact (the relay-group/masked-call party).
- I3. U soft-deleted, `landlordId` L (no longer a landlord). Staff A: `POST
  /api/units/U/contacts {contactId: T (a tenant), role: 'landlord'}`; the route
  read shows a `landlordId`, so it is not a claim and no type check runs. Staff
  B: `POST /api/units/U/restore {landlordId: null}` commits (U live and
  ownerless). A: `addContact` reads U with no `landlordId`, claims the vacant
  slot (`unitsRepo.ts:797`, `:847`) - T, a tenant, is the landlord of record of
  a LIVE property. (Had A's repo read been stale it would instead have answered
  409 `landlord_reassignment_required`.)

Evidence: `zz-review-advb-units-race.test.ts`, the two "roster add" cases (the
race injected right after the route's consistent read; the FakeWorld
`addContact` mirrors the real one). Both FAILED as predicted: I4 got `{status:
200, cwSeated: true, primary: 'c-cw'}`, expected `{409, false, 'c-owner'}`; I3
got `{status: 200, landlordId: 'c-ten', live: true}`.

Why this is not just L1 (RUNBOOK "reads, not locks"): both route reads are
consistent and the repo already runs an optimistic loop fenced on exactly the
roster and `landlordId` it read. The window exists only because the rule is not
evaluated inside that loop, so closing it needs no lock.

Fix: carry the rule into `addContact`'s attempt loop - e.g. an input like
`{ newSeatAllowed: !isCaseworker(contact), claimAllowed: contact.type ===
'landlord' }` checked on EACH attempt's read, throwing typed errors the route
maps to 409 `contact_list_caseworker` / `landlord_not_landlord` (keep the route
pre-checks for the common no-race answer). Regression test: a racing-doc
integration test in the style of `unitsRepoRestoreWithLandlord.integration.test.ts`
`racingRepo` that removes CW (or the `landlordId`) after the first
`GetCommand`, expecting the typed refusal and an unchanged roster; it fails
with the fix reverted (as the throwaway cases do today).

## 2. LOW - CONFIRMED - `unitsRepo.restoreWithLandlord` neither checks nor conditions on the unit still being soft-deleted

Location: `app/src/repos/unitsRepo.ts:1103-1164` - it reads at `:1107`, checks
only `landlordId` at `:1118`, REMOVEs `deleted_at` at `:1149` without requiring
it, and writes through `updateRosterIfCurrent`, whose condition covers only
`landlordId` and `contacts` (`:572-586`). The route decides "needs a landlord"
only for a deleted unit (`app/src/routes/units.ts:1615`, `:1624`) and calls it
at `:1678`. Its interface doc (`unitsRepo.ts:481`) says "restore a soft-deleted
property AND change its landlord of record"; the route says "restore must never
become a way to reassign a live property's landlord" (`routes/units.ts:1603`).

Interleaving: U soft-deleted, `landlordId` L, L typed tenant. Staff A: `POST
/api/units/U/restore {landlordId: X}`; the route reads U (deleted) and L
(tenant), so it needs a landlord; X passes `requireLandlordContact`. Staff B:
re-types L to landlord (allowed whenever L holds no open tour or placement - a
change TO landlord is never refused by units, `contactHoldings.ts`
`typeChangeRefusals`) and does a plain restore - U is live with L. A: `restoreWithLandlord(expect L, next X)` sees
`landlordId` still L, drops L's row, sets X, moves the primary to X, 200 with a
`landlordReplaced` audit. Durable: a LIVE property's landlord reassigned
through restore, overriding B's restore.

Evidence: `zz-review-advb-restore-live.integration.test.ts` (real repo,
DynamoDB Local) calls `restoreWithLandlord` on a never-deleted unit: both cases
FAILED as predicted - the swap returned and stored `landlordId: 'c-new'`; the
clear returned and removed `landlordId`. `zz-review-advb-units-race.test.ts`
"restore with a landlord" case (the interleaving above through the route)
FAILED as predicted: `{status: 200, landlordId: 'c-new'}`.

Fix: in `write()`, throw `RosterWriteConflictError` when `!isDeleted(unit)`,
and add `attribute_exists(deleted_at)` to the update condition (give
`updateRosterIfCurrent` an extra-conditions parameter) so a restore landing
between the read and the write also loses. Regression test: the throwaway
integration test above (expects `RosterWriteConflictError` and `landlordId`
unchanged) plus a `racingRepo` case that REMOVEs `deleted_at` after the read;
both fail with the fix reverted.

## 3. INFO - CONFIRMED - transitionPlacement's terminal-exit check is decided on a read the write is not conditioned on; the RUNBOOK frames the window as read lag, but a consistent read would not close it

Location: `app/src/services/statusTransition.ts:408` (placement read), `:420`
(the check, skipped when `from` is open), `:477` (the write);
`app/src/repos/placementsRepo.ts:347` (its only condition is
`attribute_exists(placementId)`).

Interleaving: placement P is open (`awaiting_inspection`), tenant T. A: a move
to `send_application` reads P (open) - no check. B: moves P to `lost` (into a
terminal stage: unchecked). C: re-types T to landlord (allowed: a lost
placement is not an open holding). A: writes `send_application`. Durable: an
open placement on a landlord-typed contact. A consistent read in A does not
help - A's read precedes B and C.

This sits in the acknowledged family (RUNBOOK, "The contact-type checks are
reads, not locks": "decides that the placement is leaving a closed stage from
an ordinary, eventually consistent read"), so it is INFO; the point is the
fix: condition the write on the stage read (`stage = :from`, a lost condition
answering 409 like the tours PATCH's `expectedStatus`, `routes/tours.ts:1421`),
which closes both the lag and the concurrent-move windows without a lock.
Evidence: `zz-review-advb-units-race.test.ts` "transitionPlacement" case
FAILED as predicted: `{outcome: 'moved', stage: 'send_application'}`, expected
`ContactNotTenantError` and `lost`. Regression test: that case, against a
`placementsRepo` fake/real that honors the new condition.

## 4. INFO - CONFIRMED (mutant survives) - restoreWithLandlord's "old landlord was primary by the scalar alone" rule is untested

Location: `app/src/repos/unitsRepo.ts:1127` (`|| unit.primary_contact ===
old`). Mutant: drop that disjunct. `npx vitest run
test/unitsRepoRestoreWithLandlord.integration.test.ts` -> 9/9 PASSED with the
mutant. The route tests run the FakeWorld's own copy
(`test/helpers/twilioWebhookHarness.ts`, `restoreWithLandlord`), so nothing
exercises the real disjunct. Without it, a unit whose scalar names the old
landlord while no roster row is flagged (the scalar is PATCH-writable,
`lib/unitFields.ts:104`) keeps `primary_contact` dangling at a contact who is
no longer on the list nor the landlord. Regression test: an integration case
with roster `[{c-old, landlord, primary: false}, {c-pm, pm, primary: false}]`
and `primary_contact: 'c-old'`, restored with `next: c-new` - expect
`primary_contact: 'c-new'` and c-new's row primary; it fails with the mutant.

## 5. INFO - CONFIRMED (mutant survives) - the lost-acknowledgement answer of a reclassification refusal is untested

Location: `app/src/repos/suggestionResolutionRepo.ts:930-937` (`return refusal`
when the mismatch transaction threw but the journal shows our own supersede).
Mutant: `return 'superseded_by_human_edit'` at `:936`.
`test/suggestionResolutionRepo.integration.test.ts` 32/32 and
`test/suggestionReclassification.integration.test.ts` 7/7 PASSED with it. The
stored outcome is the same either way; only the requester's code
(`suggestion_contact_reclassified` vs `suggestion_field_edited`) is unpinned.
Regression test: a repo integration case whose doc wrapper lets the supersede
`TransactWriteCommand` commit and then throws, on a contact whose
`classification_revision` moved - expect `superseded_by_reclassification`.

## 6. INFO - CONFIRMED - a type-less contacts row (a phone or email pointer) named as a tenant answers 409 `contactKind: "undefined"`, not 404

Location: `app/src/lib/caseworkers.ts:96-97` (`String(c.type)`),
`app/src/services/contactTypeGuards.ts:68`, reached from every
`requireTenantContact` caller (e.g. `routes/tours.ts:355`). Pointer rows carry
no `type` (`repos/contactsRepo.ts:282-296`) and the codebase treats them as "a
routing record, never a contact" (the conversion's `readSubject` and the
contacts PATCH 404 them). Evidence: `zz-review-advb-units-race.test.ts`
"contactKind" case: `POST /api/tours {tenantId: 'phoneref#+15550001111'}`
answered `409 {error: 'contact_not_tenant', contactKind: 'undefined'}`
(expected 404 `tenant_not_found`). Fix: in both `require*Contact` guards treat
`phone_ref` / `email_ref` rows (and a missing `type`) as not found, and never
stringify an absent type into `contactKind`. Regression test: that case.

## 7. INFO - PLAUSIBLE - TENANT_ONLY_TARGETS is a second, literal copy of extraction's tenant-fact rule

Location: `app/src/services/extraction/runTypes.ts:28` (seven literals) vs
`app/src/services/extraction/apply.ts:137-142` (`fieldApplies`: every
extractable field except the names is tenant-only, by default) and `:535` (the
`status` suggestion is made for tenants only); pinned only by a literal list
(`test/suggestionReclassification.test.ts:243-247`). They agree today
(`schema.ts:24-33`). A new tenant fact added to `EXTRACTABLE_FIELDS` would be
proposed for tenants only but accepted onto any type and never fenced, with
every test green. Not reproducible as a failure (no drift yet). Fix: derive the
set from `EXTRACTABLE_FIELDS` minus the name fields plus `status`, or add a test
asserting `TENANT_ONLY_TARGETS` equals `{f in EXTRACTABLE_FIELDS: f not a name
field} + status`.

## 8. INFO - PLAUSIBLE - effectiveGuard's legacy fallback also refuses a legacy journal on a contact that was converted and later re-typed back to tenant

Location: `app/src/repos/suggestionResolutionRepo.ts:480-487` (adds
`caseworker_conversion: {exists: false}`); nothing clears that attribute on a
re-type (`routes/contacts.ts:298` server-owned; the RUNBOOK documents going back
to tenant after a conversion). A tenant-only journal claimed before the deploy
and recovered after it, on such a contact, ends `superseded_by_reclassification`
although its classification did not change since the claim. The documented
"Known limit" (`:476`) names only the opposite gap. Not reproduced: the
population (journals in flight at deploy x re-typed-back caseworkers) is about
zero. Fix: none needed beyond naming it in that comment.

## 9. INFO - PLAUSIBLE - services/contactTypeGuards.ts is the only services module that imports Express and writes HTTP responses

Location: `app/src/services/contactTypeGuards.ts:20` (`import type { Response }
from 'express'`), `:91-109` (`sendContactTypeError`); no other file in
`app/src/services` imports `express`. `services/statusTransition.ts` now imports
this module. Type-only, so no runtime effect; a layering drift (services map
errors, routes answer HTTP). Fix: move `sendContactTypeError` to a routes-side
helper and keep the guards and error classes in the service.

## 10. INFO - PLAUSIBLE - restore answers two shapes, and silently drops a landlord choice when the plain restore applies

Location: `app/src/routes/units.ts:1631-1646` (plain: `{ unit }`, stored
`contacts` un-enriched or absent) vs `:1702` (landlord change: enriched
`contacts`). A body `{landlordId: X}` is ignored whenever the plain restore
applies (by design, `:1596-1601`), and the 200 does not say so - e.g. a dialog
submitted after a colleague re-typed the old landlord back to landlord gets a
200 whose unit still names the old landlord. Fix: enrich both branches, and
answer an ignored choice explicitly (e.g. `landlordChoice: 'ignored'`) so a
client applying the response in place cannot mistake it.

---

## Acknowledged elsewhere - not re-reported (checked, still accurate)

- The importer re-types contacts without the refusals or a revision bump, sets
  `landlordId` from the plan's suggested type, and (human-owned units,
  `if_not_exists`, `lib/import/apply.ts:1519-1555`) refills a slot a staff
  `restore {landlordId: null}` deliberately cleared: filed
  `docs/issues/import-bypasses-contact-type-rules.md` (that refill case is
  covered by its suggested fix).
- An in-flight extraction run writes tenant facts unfenced
  (`services/extraction/apply.ts:500`): filed
  `extraction-in-flight-writes-onto-converted-caseworker`, RUNBOOK.
- `primary_contact` writable with any id on unit create/PATCH: filed
  `unit-primary-contact-unchecked`.
- Leaving lost / moved_in at all: filed `placement-terminal-stage-exit-unguarded`
  (the write-condition point is finding 3).
- L1, the contact-type reads are not atomic with the writes (index lag, two
  people at once): RUNBOOK.
- `unknown` is not a tenant (tour/placement/suggestion refusals for unknowns
  are intended).

## Swept and clean

- Contact type/role writers: `contactsRepo.update` is the only writer of
  `classification_revision` (`repos/contactsRepo.ts:1467-1469`, `:1501-1507`);
  its only type/role callers are the contacts PATCH (`routes/contacts.ts:1781`,
  which runs `typeChangeRefusals` at `:1644-1654` after the W6 409 and before
  any write) and the conversion (`services/caseworkerConversion.ts:528-550`,
  stricter `collectRefusals`). Creates (`routes/contacts.ts:1144`,
  `routes/public.ts:257`, `routes/unmatchedEmail.ts:462`, contact capture and
  group-member stubs) only make new rows. Suggestion accept never writes
  type/role (`suggestionResolution.ts:296`). Seeds are dev-only and pinned by
  `test/seedContactTypeInvariants.test.ts` (non-vacuous: it asserts non-zero
  counts).
- Tour writers: create only at `routes/tours.ts:367` (checked `:355`); status:
  PATCH conditioned on `expectedStatus` (`:1421`, revive check `:1404`), reopen
  via `reopenIf` (`:1701`, check `:1696`), from-tour finalize and auto-close only
  close (`routes/placements.ts:775`, `jobs/tourAutoClose.ts:98`); roster
  provisioning never writes status. No other revival path.
- Placement writers: create only at `routes/placements.ts:595` / `:736` (checked
  `:582` / `:678`, before the conversion claim); stage only via
  `transitionPlacement`, whose single caller (`routes/statusTransition.ts:200`)
  maps the new errors first (`:336`); PATCH refuses `stage`.
- Unit writers: `landlordId` - create (`routes/units.ts:499`), PATCH when changed
  (`:1487-1509`, empty id 404s before a key error), claim (finding 1),
  `restoreWithLandlord` (finding 2), importer (acknowledged); `deleted_at`
  removal only via `POST /restore`; `contacts[]` only via `addContact`,
  `removeContact`, `restoreWithLandlord`.
- Ownerless units (now reachable via `restore {landlordId: null}`): every
  reader guards a missing `landlordId` - `unitContacts` (`unitsRepo.ts:296-304`),
  `removeContact` (`:922-936`), `services/rosterProvision.ts:234`, `:525`,
  `jobs/placementNudges.ts:436`, `routes/placementNudges.ts:238`,
  `lib/personEvents.ts:172`, `lib/tourContacts.ts:126`,
  `lib/rosterResolution.ts:294`, `routes/units.ts:1244`.
- D1 fence: `effectiveGuard` feeds all three `commitContactEffect` sites
  (`suggestionResolutionRepo.ts:862`, `:893`, `:907`) and the fake; guard keys
  and values go through `#g`/`:g` placeholders (no expression injection); the
  not-tenant refusal precedes `buildPlan` and the claim
  (`suggestionResolution.ts:820-826`), never refuses a dismiss, and emits nothing
  (`routes/suggestions.ts:227-229`); `status` suggestions exist for tenants only
  (`extraction/apply.ts:535`), so the new 409 replaces only a former 400 there.
- Holdings reads: placements, tours (`toursRepo.ts:348-363` `queryAll`) and
  landlord units are walked to exhaustion; the conversion's refactor keeps its
  read order and code-unit sort; the type change skips the roster Scan.
- `deriveTenantStatus` skip touches only the tenant side; the listing
  derivation is unchanged.
- Error mapping: every route calling `requireTenantContact` /
  `requireLandlordContact` maps all four errors and rethrows the rest; no new
  500 path found. No new routes; the restore body is validated
  (`routes/units.ts:1605-1613`); error bodies carry ids and type words only,
  except `restore_needs_landlord.landlordName` (a display name to an
  authenticated staff client; no response-body logging exists).
- Fakes: FakeWorld `update` bumps `classification_revision`
  (`twilioWebhookHarness.ts:2427-2429`), `listByLandlord` honors the deleted
  scope (`:2813-2816`, `:2880-2887`), `restoreWithLandlord` mirrors the real
  method (including finding 2's gap); the resolution fake evaluates the same
  exported `effectiveGuard`.
- Scripts and e2e: no root script calls the changed endpoints; the e2e specs
  that drive them directly (`e2e/tests/tour-roster.spec.ts:141`,
  `roster-quiet-hours.spec.ts:197`, `relay-intro-variants.spec.ts:118`,
  `dashboard-next/property-roster.spec.ts:333`, `:362`) all pass under the new
  checks (p3 e2e: 345 passed).

## Housekeeping

- Mutant 4 (`unitsRepo.ts`): sha256 before and after revert
  `7ecc83f7c7b050f7a39b90c3a7ade14164ce198f005cd1157c841b7ff80cee70`.
- Mutant 5 (`suggestionResolutionRepo.ts`): sha256 before and after revert
  `3b1e0f4545feae05e96f22d02e13fef02f945d124c5fc17b6a3996dbea933b19`.
- Both throwaway test files were deleted by exact name after the runs; no git
  writes were made.
