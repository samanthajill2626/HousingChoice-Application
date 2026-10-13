# R2 code re-review - backend (app/) - fix/caseworker-integrity

- Round 2, fresh re-reviewer, backend half. Branch `fix/caseworker-integrity`
  @d640cfb4 (the p4 gate head), base 19607658. Read in full: the R1 backend
  review (B1-B10), `R1-adjudications.md` (incl. SA-1 and the "new seat only"
  interpretation), `FW1-report.md`, `SA1-report.md`, the fix diff
  (`r2-fix-backend.diff`, `r2-fix-docs.diff`) and the whole-branch diff
  (`r2-full.diff`), against the worktree. The plan was not opened; the spec was
  read only where an adjudication cites it (header; section 4 "Contact list
  (I4)" incl. "Auto-primary").
- Method: every reader and writer of the touched state swept repo-wide (app/,
  dashboard/, e2e/, scripts/): the contact list (`contacts[]`), `landlordId`,
  `primary_contact`, `deleted_at`, contact type/role, the guards and their
  error codes. Probes ran only after `.superpowers/sdd/logs/p4-e2e.exit`
  existed (`exit=0`, 345 passed), one vitest file at a time. Throwaway tests
  (both deleted by exact name afterwards):
  `app/test/zz-review-r2b-autoprimary.test.ts` (FakeWorld, through the real
  routes and the real `resolveRoster`) and
  `app/test/zz-review-r2b-roster.integration.test.ts` (real `unitsRepo`,
  DynamoDB Local). Each throwaway case asserts what the invariant or the
  record needs, so a FAILURE reproduces the finding. Mutants were applied with
  the Edit tool and reverted byte-identically (hashes at the end).

Counts (new findings): BLOCKER 0, HIGH 0, MEDIUM 0, LOW 3, INFO 3.

Probe results (FakeWorld file, 7 cases; then the same file re-run with SA-1
switched off in the fake - mutant MS2 below - to isolate what SA-1 adds):

| Case | With SA-1 (branch) | SA-1 off (MS2) |
|---|---|---|
| N1 audit flag | FAILED as predicted: `{ audited: false }`, stored row primary | n/a (no auto-primary, nothing to mis-record) |
| N2 tenant as property contact | FAILED as predicted: `primary: ['c-t1']`, roster members `['c-t2', 'c-t1']` | PASSED (members `['c-t2']`) |
| N3a pointer claim | FAILED as predicted: 409 `landlord_not_landlord` | same (pre-SA-1 part) |
| N3b pointer seat | FAILED as predicted: 200, seated, `primary_contact: 'phoneref#+15550003000'` | seated, `primary_contact` undefined |
| N4 restore without a landlord | FAILED as predicted: members `['c-t9']` (the PM left unflagged) | same (not an SA-1 regression) |
| B1 I4 race | FAILED as predicted: 200, CW seated, `primary_contact: 'c-cw'` | 200, CW seated, `primary_contact` undefined |
| B1 I3 race | FAILED as predicted: 200, `landlordId: 'c-ten'`, `primary_contact: 'c-ten'`, live | 200, `landlordId: 'c-ten'`, `primary_contact` undefined |

DynamoDB Local file: P1 and P2 PASSED (the clean results in section D).

---

## (A) New findings

### A1. LOW - CONFIRMED - the `unit_contact_added` audit row records the REQUEST's primary flag, so every auto-primary add is durably audited as "not primary"

Location: `app/src/routes/units.ts:1101` (`primaryContact` = the request's
flag), `:1171-1176` (the audit payload), `:1177` (the route's log line);
`app/src/repos/unitsRepo.ts:849` (the effective flag, which SA-1 made differ
from the request), `:915` (only the repo's own log line carries
`autoPrimary`). `routes/units.ts` is untouched by the fix wave and SA-1.

Scenario: an ownerless property with no primary row (every property restored
"without a landlord" whose old landlord was the primary). Staff add a PM with
"+ Add contact", which always posts `primaryContact: false`
(`dashboard/src/routes/listing/ListingDetail.tsx:540`). The repo makes the PM
the primary contact and points `primary_contact` at them; the append-only
audit row says `{ contactId: PM, role: 'pm', primaryContact: false }`. Before
SA-1 the request flag and the effect were always equal; now the one durable
record of "who made this person the property's call and relay-group party,
and when" states the opposite of what happened. Nothing renders the flag today
(the Activity projection `routes/units.ts:219-249` and
`dashboard/src/routes/listing/listingFormat.ts:200` drop it), so the harm is to
the record, not the UI - but the record is permanent. Same class,
pre-existing: `role` is also the request's, while the repo pins the landlord of
record's row to `landlord` (`unitsRepo.ts:843-845`).

Evidence: N1 (table above).

Fix: audit the effect. The route already holds the ALL_NEW unit:
`const effective = (updated.contacts ?? []).some((c) => c.contactId ===
contactId && c.primaryContact === true)`; write `primaryContact: effective`
plus `autoPrimary: effective && !primaryContact`, and the same two in the log
line. Regression test: N1 (fails with the fix reverted).

### A2. LOW - CONFIRMED - auto-primary is type-agnostic: a tenant (or an unknown or a non-caseworker partner) added to an ownerless property becomes the landlord-side party of OTHER tenants' relay groups and tour messages

Location: `app/src/repos/unitsRepo.ts:836-839` (the rule has no type input -
the repo never sees the contact); `app/src/routes/units.ts:1131-1143` (the only
type gates on a new seat: no caseworker, and a landlord-role claim needs a
landlord; every other type is seated with any other role, as
`app/test/unitsApiRosterTypeChecks.test.ts` pins); the readers, none of which
checks the property contact's type: `app/src/lib/rosterResolution.ts:288-302`
(de-dupes only against the placement's OWN tenant, `:299`),
`app/src/lib/tourContacts.ts:124-135`,
`app/src/services/rosterProvision.ts:230-234`, `:524-525`; the copy "Putting
you in a group text with {propertyContactFirstName}"
(`app/src/messages/catalog.ts:353`).

Scenario: property U is ownerless with no primary (legacy, or after "Restore
without a landlord"). Staff add tenant T1 to U's list as `other` (the picker
offers every tenant, landlord, partner and unknown not already listed and not
a caseworker: `ListingDetail.tsx:403`, `dashboard/src/routes/contacts/useContacts.ts:31`).
SA-1 makes T1 the primary contact. Later a placement or tour for tenant T2 on U
opens its relay group: the default roster is T2 + T1, T2 is told they are in a
group text with T1, T1 receives T2's tour time, address and messages, and T2's
tour copy names T1 as the person "headed that way". Before SA-1 the same state
needed an explicit "Make primary" on T1's row; now it follows silently from an
add. The ruling that authorized SA-1 named roles, not types (challenge B-3).

Evidence: N2 - FAILED as predicted with SA-1, PASSED with SA-1 switched off
(MS2): the exposure is introduced by SA-1.

Fix (needs Cameron's call, B-3): pass an eligibility input from the route,
which already holds the contact (`routes/units.ts:1116`), e.g.
`autoPrimaryEligible: contact.type === 'landlord'` (a PM and an owner are
landlord-typed contacts in this codebase), and decide `autoPrimary = eligible
&& existing === undefined && ...` inside the attempt loop, mirrored in the
fake. Or keep the rule and record the type decision in the spec. Regression
test: N2.

### A3. INFO - CONFIRMED - the contact-list add still treats a routing POINTER as a contact (FW-5's sibling), and SA-1 can now make a pointer the property's primary contact

Location: `app/src/routes/units.ts:1116-1120` (404 only when no row exists),
`:1137-1142` (the claim's inline `contact.type !== 'landlord'`); compare the
guards since FW-5, `app/src/services/contactTypeGuards.ts:71`, `:88`.

Scenario (API only - a pointer has no `type`, so `listByType` never returns one
and the picker never offers one): `POST /api/units/U/contacts {contactId:
<phone pointer id>, role: 'landlord'}` on an ownerless U answers 409
`landlord_not_landlord` - B6's class, a pointer answered as a contact of the
wrong kind - instead of 404 `contact_not_found`; with role `pm` the pointer row
is SEATED (pre-existing), and on an ownerless, primary-less U SA-1 makes it the
primary contact (its `phone` is the owner's number).

Evidence: N3a, N3b (table above; the seat itself predates SA-1, its promotion
does not).

Fix: the guards' own inline test (also the contacts PATCH's,
`routes/contacts.ts:1532`): `if (!contact || contact.phone_ref === true ||
contact.email_ref === true)` -> 404 `contact_not_found`. Regression tests:
N3a, N3b.

### A4. INFO - CONFIRMED - SA-1's rationale case is only half covered: "Restore without a landlord" clears every primary flag, and auto-primary never reaches the rows left on the list

Location: `app/src/repos/unitsRepo.ts:1193-1203` (with `next: null` and the
old landlord primary: every remaining row unflagged, the scalar REMOVEd);
`:836-839` (auto-primary only for a NEW seat).

Scenario: U soft-deleted with list `[L (landlord, primary), PM]`, L re-typed to
tenant. Staff choose "Restore without a landlord": U is live and ownerless with
list `[PM]` and no primary, so calls and new relay groups reach no one; the PM
is already listed, so no "add" can ever fire the rule, and only a manual "Make
primary" ends it - neither the restore dialog nor its 200 says so. The spec
accepts an ownerless restore (section 4 "Restore"), but SA-1's stated
rationale ("after Restore without a landlord, staff add a PM and expect them to
be the primary contact") holds only when the restored list is empty.

Evidence: N4 (fails identically with SA-1 off: not an SA-1 regression, a gap
in its coverage).

Fix (product call): promote inside `restoreWithLandlord(next: null)` when
exactly one row remains (same conditional write), or make the dialog's
"Restore without a landlord" say who, if anyone, stays reachable. Regression
test: N4 (for the first option).

### A5. INFO - CONFIRMED (by reading; a docs finding has no test) - three texts are stale after the fix wave and SA-1

- `docs/issues/contact-list-checks-outside-roster-write-loop.md`: its line refs
  have drifted (addContact `:788` is now `:795`, the claim `:807` is `:814`,
  the push `:838-839` is `:860`, write and retry `:862-883` are `:886-907`),
  and both "Durable outcome" lines understate the post-SA-1 outcome (A6). The
  SA-1 report noticed the drift; nothing applied it.
- `RUNBOOK.md:475` ("The contact-type checks are reads, not locks") lists "a
  caseworker cannot take a new seat on a property's contact list" and explains
  every window as index lag. B1's window is not index lag (both route reads are
  consistent) and is not named, so ops asking "how did a caseworker get onto a
  contact list / a tenant become a landlord of record?" will not find it.
- `app/src/repos/unitsRepo.ts:873-878`: "today it is also the contactId the
  masked-call landlord leg dials, see routes/webhooks/voice.ts" - voice.ts
  dials the thread's participants (`:996-998`) and never reads the unit (stale
  before this branch; SA-1 noticed and left it).

Fix: update the three texts (fixing B1 retires the first two).

### A6. LOW - CONFIRMED - SA-1 widens B1's two races: the re-seated caseworker (I4) and the tenant claimant (I3) now also become the property's PRIMARY contact

Location: `app/src/routes/units.ts:1131-1143` (the checks, on the route's
read) vs `app/src/repos/unitsRepo.ts:814`, `:825`, `:836-849` (the repo's own
read decides the claim, the new seat and, now, auto-primary).

Interleavings (durable outcome last):
- I4: U ownerless, list `[CW (other, not primary)]` - a seat kept by L2. Staff
  A edits CW's role (`{CW, pm, primaryContact: false}`, what the dashboard
  sends, `ListingDetail.tsx:471-478`); the route sees CW seated, so no I4
  refusal. Staff B's DELETE of CW commits. A's `addContact` sees no CW: a NEW
  seat on an ownerless, primary-less unit, so auto-primary fires. Durable: B's
  removal undone AND the caseworker is the property's primary contact,
  `primary_contact` = CW. Without SA-1 the same race leaves CW seated but not
  primary unless A asked for primary.
- I3: U soft-deleted, `landlordId` L (re-typed tenant, L primary). Staff A adds
  tenant T with role `landlord`; the route sees a landlordId, so no claim
  check. Staff B's "Restore without a landlord" commits (live, ownerless, no
  primary). A's `addContact` claims the slot and auto-primary fires. Durable: a
  tenant is the landlord of record AND the primary contact of a LIVE
  property.

Evidence: the two B1 cases (table above): with SA-1 `primary_contact` is CW /
T; with SA-1 off (MS2) it is undefined in both.

Fix: B1's filed fix, now cheap (challenge B-1). Regression tests: these two
route cases plus a DynamoDB Local `racingRepo` case.

---

## (B) Adjudication challenges

### B-1. B1 (FILE `contact-list-checks-outside-roster-write-loop`) - CHALLENGE: fix it in this branch, or at least re-rule with SA-1's widened outcome

The ruling (row B1) rests on two grounds: the route-side decision is the
plan's ruled design (S4-1, "L1 class"; "the spec prescribes 'both before the
repo call'"), and closing it "moves the rule into the shared roster write and
its fake - a design change for Cameron". Both have moved since:

1. SA-1, ruled after it, has made exactly that design change: a contact-list
   rule decided inside `addContact`'s attempt loop from each attempt's read
   (`app/src/repos/unitsRepo.ts:826-839`), mirrored in the fake
   (`app/test/helpers/twilioWebhookHarness.ts:2963-2972`). It already computes
   both predicates B1's fix needs - a NEW seat (`existing === undefined`,
   `:825`/`:837`) and a claim (`claimsVacantLandlord`, `:814`). B1's fix is
   now two typed throws beside them plus the route's mapping to the existing
   409s: about ten lines across repo, fake and route.
2. The spec sentence does not forbid it. "Check order on this route:
   `contact_list_caseworker`, then `landlord_not_landlord`, both before the
   repo call; the repo's own 409 `landlord_reassignment_required` follows"
   (spec lines 327-329) fixes the ORDER of the answers. Keeping the route
   pre-checks (the filed fix does) and re-checking per attempt still runs
   both before the repo call.
3. SA-1 widens both races' durable outcome (A6, measured with and without
   SA-1): the re-seated caseworker and the tenant claimant now also become the
   relay-group / masked-call party, although the request said
   `primaryContact: false`. And the I3 race's trigger, "Restore without a
   landlord", is SA-1's own motivating flow.

Recommendation: FIX now with the issue's own suggested fix (one input object
can carry `newSeatAllowed`, `claimAllowed` and, if B-3 is ruled that way,
`autoPrimaryEligible`). If it stays FILED, update the issue (A5).

### B-2. SA-1 "new seat only" - AGREE, with one gap named

Right for this route: the dashboard's Add contact picker never offers a
contact already on the list (`ListingDetail.tsx:403`), and a role edit posts
the row's own flag (`:471-478`), so promoting on an upsert would make "change
the role" silently change who calls and relay groups reach. Pinned by the (f)
cases on both sides. The gap it leaves is A4.

### B-3. SA-1 "whatever its role" read as "whatever its TYPE" - CHALLENGE: needs an explicit ruling

The ruling says "any role (pm, owner, other, and a Landlord who claims the
vacant slot)". The SA-1 report extends it: "The rule is role- and
type-agnostic, as ruled" (`SA1-report.md:134-139`). Nobody ruled on type, and
A2 shows what the extension does. Ask Cameron; the cheapest safe default is
auto-primary only for contacts typed `landlord`.

### B-4. B6 (FIX, FW-5) - scope too narrow

FW-5 fixed what B6 named (both guards and `contactKind`, every caller). The
same class remains on the one contact-reading route the branch touched that
does not use the guards, `POST /api/units/:id/contacts`
(`routes/units.ts:1116-1143`), now amplified by SA-1 (A3).

### B-5. Rulings checked and agreed

- B2 FIX (FW-1); B4, B5, B7 test-only; B8 comment-only: appropriate.
- B3 FILE plus the RUNBOOK wording (FW-2): the clause and the issue paragraph
  match `statusTransition.ts:408`, `:420-421`, `:477` and
  `placementsRepo.ts:347`.
- B9 REJECT (type-only Express import, plan-bound): agree.
- B10 REJECT the wire change: agree. FW-1 adds a third restore answer (409
  `unit_roster_conflict` for a unit that came back live under the dialog);
  the dashboard already handles that code.

---

## (C) Are FW-1..FW-7 and SA-1 (backend) real?

Each mutant reverts one fix with a one-line Edit; the named file ran alone;
the file was restored byte-identically before the next mutant.

| Item | Verdict | Mutant | File run | Result with the mutant |
|---|---|---|---|---|
| FW-1 read check | REAL | M1a: `if (!isDeleted(unit))` -> `if (false && ...)` (`unitsRepo.ts:1155`) | unitsRepoRestoreWithLandlord.integration | 2 red / 13: both LIVE cases, `expected 3 to be +0` (the condition still refuses, after three sent writes) |
| FW-1 write condition | REAL | M1b: `requireSoftDeleted: true` -> `false` (`unitsRepo.ts:1206`) | same | 1 red / 13: the racing plain restore, `promise resolved ... instead of rejecting` |
| FW-1 fake | REAL | M1c: the fake's check disabled (`twilioWebhookHarness.ts:3116`) | unitsRestoreLandlord | 2 red / 16: `expected 200 to be 409` |
| FW-2 | REAL (docs) | - | - | text matches the code it cites (B-5) |
| FW-3 | REAL | M3: drop `\|\| unit.primary_contact === old` (`unitsRepo.ts:1169`) | unitsRepoRestoreWithLandlord.integration | 1 red / 13: `expected 'c-old' to be 'c-new'` |
| FW-4 | REAL | M4: lost-ack `return refusal` -> `return 'superseded_by_human_edit'` (`suggestionResolutionRepo.ts:941`) | suggestionResolutionRepo.integration | 1 red / 33: `expected 'superseded_by_human_edit' to be 'superseded_by_reclassification'` |
| FW-5 tenant guard | REAL | M5a: pointer clause dropped (`contactTypeGuards.ts:71`) | contactTypeGuards; toursCreateContactType | 3 red / 33; 2 red / 12 (`expected 409 to be 404`) |
| FW-5 landlord guard | REAL | M5b: pointer clause dropped (`contactTypeGuards.ts:88`) | contactTypeGuards; unitsLandlordOfRecord | 3 red / 33; 1 red / 21 (`expected 409 to be 404`) |
| FW-5 contactKind | REAL | M5c: back to `String(c.type)` (`caseworkers.ts:100`) | caseworkers | 4 red / 80 (`{}`, `{role}`, `''`, `42` -> not `unknown`) |
| FW-6 | REAL | M6: a new extractable field `'income'` added to `EXTRACTABLE_FIELDS` in SOURCE (`extraction/schema.ts:32`) - the drift the guard exists for | suggestionReclassification | 1 red / 40, the guard alone: `expected [ 'income' ] to deeply equal []` |
| FW-7 | REAL (comment) | - | - | accurate: `caseworker_conversion` is written only at `caseworkerConversion.ts:404`, `:537` and is server-owned on the PATCH (`contacts.ts:298`) |
| SA-1 rule, repo | REAL | MS1: `\|\| autoPrimary` dropped (`unitsRepo.ts:849`) | unitsRepoAutoPrimary.integration | 6 red / 10: (a) x4, (d), (e) |
| SA-1 rule, fake | REAL | MS2: `\|\| autoPrimary` dropped (`twilioWebhookHarness.ts:2972`) | unitsApiRosterAutoPrimary | 7 red / 11: (a) x6, (d) |
| SA-1 per attempt | REAL | MS3: decided once per call (memoized on the `write` closure, `unitsRepo.ts:836`) | unitsRepoAutoPrimary.integration | 1 red / 10: (e), the LOSER ended primary: `expected [ 'c-racer-two' ] to deeply equal [ 'c-racer-one' ]` |
| SA-1 scalar | REAL | MS4: scalar not written when the rule fired (`unitsRepo.ts:882`) | unitsRepoAutoPrimary.integration | 5 red / 10: (a) x4, (d) (`expected undefined to be 'c-pm'`, `expected 'c-gone' to be 'c-pm'`) |

Notes:
- FW-1: REAL and minimal. Optional tightening, not a defect: the condition is
  `attribute_exists(deleted_at)`, not "the stamp I read", so an A-B-A (a
  restore and a fresh delete both landing between this read and the write)
  lets this restore undo the new deletion - the ordinary last-writer-wins of
  delete vs restore. `#expectedDeletedAt = :readStamp` would close it at no
  cost.
- FW-5: REAL for what B6 named; the sibling is A3 / B-4.
- FW-6: REAL. It pins "classified on purpose", not "classified the way
  extraction's `fieldApplies` treats it" (`extraction/apply.ts:137-142`) - a
  developer can still classify a new tenant fact as neutral, but only by
  editing the test's neutral set deliberately.
- SA-1: REAL in the repo and the fake, decided per attempt, scalar kept
  consistent; its concurrency is clean (section D). Its defects are scope and
  records, not mechanism: A1, A2, A4, A6.

---

## (D) Swept and clean

- SA-1 concurrency. Every input of the rule (`hasLandlordId`, the seeded
  roster, `existing`) derives from exactly the two attributes the write is
  fenced on (`updateRosterIfCurrent`, `unitsRepo.ts:585-599`), and a lost
  condition re-reads and re-decides (`:886-907`). Walked as interleavings,
  each pair ends in the state of SOME serial order:
  - add (auto) vs add (auto): the first commit is primary, the loser re-reads
    and joins non-primary (MS3 shows the per-attempt decision is what makes
    this hold);
  - add (auto) vs a landlord claim: PM first -> PM primary, then the claim
    lands non-primary with `landlordId`; claim first -> the claim primary, the
    PM non-primary;
  - add vs removal of the only primary (probe P2, four runs on DynamoDB Local):
    add-then-remove -> the new row unflagged, scalar REMOVEd
    (removeContact's ownerless rule); remove-then-add -> the new row primary,
    scalar naming it. No row lost, never two primaries, the scalar always
    agreeing with the flagged row;
  - add vs `restoreWithLandlord(next: null)`: restore first -> the add sees an
    ownerless, primary-less unit and is promoted; add first -> not promoted
    (the unit still had a landlordId), then the restore clears the old
    landlord's primary;
  - add vs a unit PATCH of `landlordId` (`units.update`, not a roster write):
    PATCH first -> the add's condition fails and the retry, seeing a
    landlordId, does not promote; add first -> the PATCH lands on a unit whose
    PM is primary;
  - "Make primary" (an upsert with `primaryContact: true`) vs an auto-primary
    add: the explicit request always ends primary.
- SA-1 readers. `lib/rosterResolution.ts:288-302`, `lib/tourContacts.ts:124-135`
  and `services/rosterProvision.ts:230-234`, `:524-525` take the `=== true`
  row, else a non-empty `landlordId` - the rule's own test - so it fires
  exactly where they found nobody. The masked call dials the thread's
  participants (`routes/webhooks/voice.ts:996-998`; the business-number leg,
  `:627`, is unbuilt). Placement nudges route the landlord rung on
  `unit.landlordId` only (`jobs/placementNudges.ts:423-443`,
  `routes/placementNudges.ts:238`), so an auto-primary PM on an ownerless
  property still gets no landlord nudge - unchanged by SA-1 (Make primary
  behaved the same), but worth knowing: such a property becomes reachable for
  relays and calls, not for nudges. The `primary_contact` scalar has no
  runtime reader (app, dashboard, e2e, scripts swept). The only other
  `UnitsRepo` with an `addContact` is the FakeWorld fake (repo-wide grep).
- FW-1. `updateRosterIfCurrent`'s other callers send byte-identical commands:
  the option defaults to `{}`, and both the `#expectedDeletedAt` name and its
  condition exist only under `requireSoftDeleted === true`
  (`unitsRepo.ts:600-603`). Probe P1 captured the live UpdateCommands of an
  `addContact` and a `removeContact`: no `deleted_at` name, condition exactly
  `attribute_exists(unitId) AND attribute_not_exists(#expectedLandlordId) AND
  #expectedContacts = :expectedContacts`. `git diff f11e46fb HEAD` shows no
  other code change in `removeContact`. The read check (`isDeleted`, a
  non-empty string) and the write (`attribute_exists`) disagree only for
  `deleted_at: ''`, which the read check refuses first. The fake checks in the
  same order (not found, not deleted, landlordId).
- FW-5. `contactKind`'s only runtime caller is `requireTenantContact`
  (`services/contactTypeGuards.ts:74`). Every guard caller - tours create
  `routes/tours.ts:355`, revive `:1406`, reopen `:1696`; placements create
  `routes/placements.ts:582`, from-tour `:678`; `transitionPlacement`
  `services/statusTransition.ts:421`; units create `routes/units.ts:499`, PATCH
  `:1500`, restore `:1662` - maps the not-found errors through
  `sendContactTypeError`. The pointer test is the codebase's own
  (`caseworkerConversion.ts:206-207`, `contacts.ts:1532`, `api.ts:2134`,
  `unmatchedEmail.ts:406`).
- FW-4's test does what it claims: the lossy wrapper throws only after a
  committed transaction that carries a ConditionCheck (only the mismatch
  transaction does), and the first, guarded commit fails before the wrapper
  can act.
- Placement and tour `tenantId` are immutable after create (placements PATCH
  allowlist `routes/placements.ts:264-357`; tours `PATCH_ALLOWED`
  `routes/tours.ts:159`), so no second path re-points a record at a
  non-tenant. `contacts[]` is not PATCH-writable (`lib/unitFields.ts`);
  `landlordId` is removed only by `restoreWithLandlord`.
- Main sync (still owed): main's three commits touch `unitsRepo.ts` in a
  comment only and `unitFields.ts` (a clearable `voucher_size_accepted`); no
  overlap with the roster, restore or guard code.
- The p4 `npm test` exit 1 is environmental: its one failure is `connect
  ENOBUFS 127.0.0.1:65533` (socket exhaustion, not an assertion) in
  `test/unitsApiRosterTypeChecks.test.ts`; that file run alone: 17/17 passed.
  No `[dynamoAdmin]` line in that log.

---

## Housekeeping

- sha256 of every file mutated, before the first mutant and after the last
  revert (identical; each was also checked after its own revert):
  - `app/src/repos/unitsRepo.ts` `efde3834a04f1ac4d0813bcba06a277f8aabce867a4a7b8834ced93a760fa57d`
  - `app/test/helpers/twilioWebhookHarness.ts` `83a80780ed66f183ecca6de202fffedab0ddbe5519f11dbf3fcb8fdad2bbaffb`
  - `app/src/repos/suggestionResolutionRepo.ts` `302ad4a1d8691a4a017787e6bdf10a09050684ee7a613dface235f40f4cc9f3d`
  - `app/src/services/contactTypeGuards.ts` `c61b840157633da11812a4fdb6bf1ec82acc94cb29b5fc837150844bb085afbc`
  - `app/src/lib/caseworkers.ts` `69436432bfac32af410e2c0d371ee17d764ee7c3b9e904ddf720926086582710`
  - `app/src/services/extraction/schema.ts` `da78edc64e0ac9e16d0af41684215e244ac0d0bb3d1556923308a0916e5c9751`
- Both throwaway files deleted by exact name. No git writes; no full
  `npm test`, e2e, `db:start` or Docker command. The `zz-review-r2d-*` files
  and the transiently modified dashboard sources seen in `git status` (first
  `ContactDetail.tsx`, later `TourDetail.tsx`) are the parallel dashboard
  reviewer's mutants and probes; none was touched here. This file is the only
  path this review added.
