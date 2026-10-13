# R3 code re-review - backend (app/) - fix/caseworker-integrity (fix wave 2)

- Round 3 (TERMINAL), fresh re-reviewer, backend half. Branch
  `fix/caseworker-integrity` @2bbc6799 (the p5 gate head; app/ is unchanged
  since 534f971d, the last FW2a code commit). Fix range d640cfb4..2bbc6799.
- Read in full: the brief, `R2-adjudications.md` (rows FW2-1..FW2-4, FW2-11,
  FW2-12 and "Cameron's rulings on Q4 and Q5"), `R2-backend.md` (A1, A3, A5,
  A6, B-1), `R1-adversarial-backend.md` finding 1, `FW2a-report.md`, spec
  revision 5 section 4 "Restore" and "Contact list (I4)" only, and
  `.superpowers/review/r3-fix-backend.diff`, `r3-fix-docs.diff`, against the
  worktree. Nothing else under `docs/superpowers/` was opened.
- Method: the new code read cold; every consumer and mutator of the contact
  list, `landlordId`, `primary_contact` and the restore route swept repo-wide;
  races walked as interleavings (section D). Runs only after
  `.superpowers/sdd/logs/p5-e2e.exit` existed (`exit=0`, 345 passed, 22.0
  min), one vitest file at a time. Two throwaway files (both deleted by exact
  name afterwards):
  - `app/test/zz-review-r3b-promotion.test.ts` - FakeWorld, through the real
    routes (and the real `resolveRoster`); six cases F1-F5.
  - `app/test/zz-review-r3b-restore-route.integration.test.ts` - the REAL
    units router (`createUnitsRouter`) over the REAL `unitsRepo` on DynamoDB
    Local, with in-memory contacts (`getById`, `getManyByIds`) and audit
    stand-ins; two cases R1-R2. (The first route-on-DynamoDB-Local test in
    this branch; it is what separates a FakeWorld artifact from production in
    A3.)
  Each case asserts what the record or the ruled intent needs, so a FAILURE
  reproduces the finding. Mutants and two fix probes were applied with the
  Edit tool and reverted byte-identically (hashes at the end).
- p5 gate battery at 2bbc6799 (orchestrator logs): typecheck 0, smoke 0,
  npm test 0, e2e 0 (345 passed). Baselines of the six FW2 files run alone
  before any mutant: unitsRepoContactListRules.integration 3/3,
  unitsApiRosterTypeChecks 23/23, unitsRepoAutoPrimary.integration 13/13,
  unitsApiRosterAutoPrimary 17/17, unitsRepoRestoreWithLandlord.integration
  18/18, unitsRestoreLandlord 24/24. No `[dynamoAdmin]`, ENOBUFS or SKIPPED
  line in any of this review's logs.

Counts (new findings): BLOCKER 0, HIGH 0, MEDIUM 0, LOW 2, INFO 3. Nothing
reopens the code under the terminal rule; fix wave 2 introduced no
regression found here.

| Probe | Asserts | Result |
|---|---|---|
| F1 (fake) | a contact-list change DURING the route's type reads answers 409, nothing restored | FAILED as predicted: 200, c-pm promoted while c-owner (a second landlord-typed contact) sits on the list |
| R1 (real router + repo) | the same interleaving on the real stack | PASSED: 409 `unit_roster_conflict`, unit still deleted, c-old still primary |
| F2 (fake) / R2 (real) | D3-fallback landlord cleared: the sole landlord-typed contact is promoted | FAILED as predicted on both: no row primary; `resolveRoster` reached c-old before the restore and only the tenant after |
| F3a (fake) | a soft-deleted landlord-typed contact is not promoted | FAILED as predicted: c-gone (deleted) promoted, `primary_contact: 'c-gone'` |
| F3b (fake) | a soft-deleted one does not block the one live landlord-typed contact | FAILED as predicted: nobody promoted |
| F4 (fake) | L1, restore: a contact re-typed to tenant between the type read and the write is not promoted | FAILED as predicted (documented limit): the now-tenant c-pm promoted |
| F5 (fake) | L1, add: a PM re-typed to tenant between the route read and the roster write is not auto-promoted | FAILED as predicted (documented limit): auto-primary fired |

---

## (A) Findings

### A1. LOW - CONFIRMED - the sole-landlord promotion treats a SOFT-DELETED contact as eligible: it can make a deleted contact the property's primary contact automatically, and a deleted one blocks the promotion of the one live landlord-typed contact

Location: `app/src/routes/units.ts:440-448` (eligibility: exists, not a
pointer, typed `landlord` - no deleted check); `contacts.getById` returns
soft-deleted contacts (`app/src/services/contactTypeGuards.ts:14-15`).
Deleting a contact never removes its property seats
(`app/src/routes/contacts.ts:2246-2265`), so a contact list accumulates
deleted contacts through ordinary UI use. Everywhere else a soft-deleted
contact is treated as unusable for routing: a relay add refuses it
(`app/src/services/rosterEdits.ts:785`, 404), roster actions skip it
(`app/src/jobs/rosterActions.ts:412`, `contact_deleted`), sends refuse it
(`app/src/services/sendMessage.ts:537`), and the People card renders it as a
"removed contact ... someone no send will reach"
(`app/src/lib/rosterResolution.ts:538-541`) - while relay provisioning for
the property contact reads `getById` with no deleted check
(`app/src/services/rosterProvision.ts:231-238`, `:524-529`).

Scenario: staff soft-delete a PM who left (the PM stays on the property's
list). Later the property is deleted, its landlord re-typed, and staff choose
"Restore without a landlord". (a) The deleted PM is the only landlord-typed
row: the restore makes them the primary contact - row flagged,
`primary_contact` names them - with no staff choice involved, and new relay
groups / tour copy for that property name a contact staff deleted. (b) A
deleted PM and a live PM remain: two "eligible", nobody promoted - Q5's harm
for a property with exactly one usable landlord-typed contact.

Spec position: literally conformant (a contact "typed landlord"; "a
soft-deleted contact still exists", spec section 10 per
`contactTypeGuards.ts:14-15`) - but that posture is about REFUSALS; this is an
automatic routing choice. Q4's add path cannot reach it from the dashboard
(the picker offers live contacts only); the restore path reaches it through
ordinary actions. Comparable to R2B-A2 (LOW).

Evidence: F3a, F3b (table above). Fix probe (reverted): `&& !isDeleted(contact)`
appended to the eligibility at `units.ts:446` turns F3a and F3b green and
keeps `unitsRestoreLandlord` 24/24.

Recommended fix: that one clause, using contactsRepo's `isDeleted` (route
only; the repo takes the decision as input). Regression test: F3a/F3b in
`unitsRestoreLandlord.test.ts`. Under the terminal rule: FILE (or fold into
the next touch of the route).

### A2. LOW - CONFIRMED - "the cleared landlord was the primary" ignores the routing fallback: a landlord of record whose row is not flagged (no row flagged at all) IS the property's contact everywhere the property is routed, yet clearing them never promotes

Location: `app/src/routes/units.ts:433-435` (the route's gate: row flagged or
scalar) and `app/src/repos/unitsRepo.ts:1285-1286` (the repo's
`oldWasPrimary`, same rule; mirrored at
`app/test/helpers/twilioWebhookHarness.ts:3145-3146`). The routing rule used
by every reader is "the row marked primary, else the landlord of record":
`app/src/lib/rosterResolution.ts:292-294`, `app/src/lib/tourContacts.ts:124-129`,
`app/src/services/rosterProvision.ts:231-234`, `:524-525`. SA-1's own test
says this shape is reachable only through that fallback
(`app/test/unitsRepoAutoPrimary.integration.test.ts:163-165`: "A landlord of
record whose row is not marked primary (what a landlord claim wrote before
this rule): the resolvers fall back to landlordId").

Shape: a list with no flagged row while a `landlordId` exists - written by a
pre-SA-1 landlord claim (the claim row took the request's flag,
`unitsRepo.ts:951`, false from the dashboard), or by a restore WITH a
landlord on such a list (the new landlord is pushed unflagged when the old
one was not primary, `unitsRepo.ts:1296-1302`).

Scenario: deleted U, `landlordId` L (re-typed tenant), list
`[L (landlord, not flagged), PM (typed landlord)]`, no scalar. Before the
restore every resolver routes U to L. "Restore without a landlord": the
route's gate says L was not the primary (promote null), the repo agrees - U
comes back live, ownerless, PM unflagged, and every resolver now finds nobody:
relay groups and tour copy lose the property party, silently - exactly the
harm Q5 was ruled to fix, although exactly one landlord-typed contact remains.

Not a regression (before FW2-12 nobody was ever promoted) and conformant to
the spec's own definition (section 4 "Contact list": "no primary contact (no
contact-list row marked primary)"), so this is a scope gap in the ruling -
see challenge C-1. Legacy-shaped and rare, hence LOW.

Evidence: F2 (FakeWorld, through the real route and the real `resolveRoster`:
members `[c-t, c-old]` before, `[c-t]` after) and R2 (the real router and repo
on DynamoDB Local: stored list `[{c-pm, pm, primaryContact: false}]`).

Recommended fix (needs a ruling): for `next === null`, also treat "no row
flagged" as "the cleared landlord was the property contact" - one disjunct
`|| !rows.some((row) => row.primaryContact === true)` in the route's gate and
the matching one in the repo's `oldWasPrimary` (and the fake). For a swap it
would change nothing that routes (the fallback already reaches the new
landlord), so it can stay scoped to `next === null`. Regression test: F2 / R2.
Under the terminal rule: FILE with C-1.

### A3. INFO - CONFIRMED - FakeWorld fidelity: the route reads `stored.contacts` for `expectContacts` after awaiting the type reads, and the FakeWorld's `getById` returns the live map object, so a contact-list change during the type reads is a silent stale promotion in the fake and a 409 in production

Location: `app/src/routes/units.ts:1772` (the decision; `soleLandlordToPromote`
captures `unitContacts(stored)` synchronously at `:431`, before its awaits at
`:437-439`) vs `:1781` (`expectContacts: stored.contacts`, evaluated after
them); `app/test/helpers/twilioWebhookHarness.ts:2839-2841` (`getById` returns
`units.get(unitId)`, the live object) and every fake roster write replacing
`unit.contacts` with a new array (`:3006`, `:3024`, `:3178`).

Interleaving: the route reads U `[L (primary), PM]` and decides "promote PM";
while it reads PM's type, staff B adds owner O (typed landlord). Production:
`stored` is a private deserialized copy, so `expectContacts` is the OLD list,
the repo's read differs (`unitsRepo.ts:1273`), 409. FakeWorld: `stored` IS the
map object, `stored.contacts` is already the NEW list, the fake's check
passes and PM is promoted beside O - two landlord-typed rows, which the
ruling says promotes nobody.

Evidence: F1 (fake: 200, stale promotion) vs R1 (real router + real repo: 409,
nothing restored). Under mutant M12a (the repo's list check off) R1 goes red
with the fake's exact outcome, so R1 is the production regression test for
this window; FW2a's own race test (`unitsRestoreLandlord.test.ts:447`) injects
inside the repo wrapper, after `:1781` ran, so it is unaffected. Production is
correct; the risk is a FakeWorld test pinning the wrong answer for this window.

Recommended fix: read the list once, before the awaits -
`const listRead = stored.contacts;` above `:1772`, `expectContacts: listRead`
at `:1781` (better still, decide from `listRead` too). Fix probe (reverted):
F1 then answers 409 in the fake; `unitsRestoreLandlord` stays 24/24. Or keep R1
as a permanent test. FILE.

### A4. INFO - CONFIRMED - spec L1 on both fix-wave-2 decisions, reproduced (documented, by decision)

Location: `app/src/routes/units.ts:437-446` (the restore's type reads) and
`:1158`, `:1207` (the add's `facts`), each a read of the CONTACT before a
write conditioned only on the UNIT; a contact-list seat never refuses a type
change (`app/src/services/contactHoldings.ts:120-121`).

Interleavings: F4 - the route reads PM typed landlord (the sole eligible),
staff C re-types PM to tenant, the restore's write promotes the now-tenant PM.
F5 - the route reads PM typed landlord (`landlordTyped: true`), PM is re-typed
to tenant, `addContact` auto-promotes a tenant. Both are reads of a DIFFERENT
record (the contacts table): the spec's L1, named for both paths by FW2-4
(`RUNBOOK.md:475`), not a hole in the unit-side fence (that side is atomic: A3,
R1). The resulting state is legal (a tenant may be primary by Make primary).
If it is ever wanted closed: D1's `classification_revision` (bumped on every
type/role change) as a TransactWrite ConditionCheck beside the unit update.
No action (ruled).

### A5. INFO - by reading - doc drift left after FW2-4

- `app/src/routes/units.ts:1106-1115` (the POST contacts route doc): lists
  409 `landlord_reassignment_required` and `unit_roster_conflict` only - not
  `contact_list_caseworker`, `landlord_not_landlord` (both now also from the
  roster write), auto-primary, or the pointer 404 - and calls the scalar "the
  property's default contact - relay groups and masked calls".
- `app/src/repos/unitsRepo.ts:495-497` (addContact's interface doc), `:63-65`
  (`UnitContact`) and `:326-333` (`UnitItem.primary_contact`) still describe
  the scalar as the relay-group / masked-call target; FW2-4 corrected only
  `:975-983`, which says nothing routes on it (FW2a noticed `:63`, `:327`).
- Fix: align them with `:975-983`. FILE (comments only).

---

## (B) Are FW2-1..FW2-4, FW2-11 and FW2-12 real?

Each mutant reverts one fix with a one-line Edit; the named file ran alone;
the file was restored byte-identically before the next mutant.

| Item | Verdict | Mutant | File run | Result with the mutant |
|---|---|---|---|---|
| FW2-1 repo I4 | REAL | M1a: `false &&` on `unitsRepo.ts:916` | unitsRepoContactListRules.integration | 2 red / 3: both I4 cases, `promise resolved ... instead of rejecting` |
| FW2-1 repo I3 | REAL | M1b: `false &&` on `:917` | same | 1 red / 3: the I3 case |
| FW2-1 per attempt | REAL | M1c: decide-once, `attempts === 1 &&` on `:916` | same | 1 red / 3: ONLY the add's-own-window case (the per-attempt pin) |
| FW2-1 fake I4 | REAL | M1d: `false &&` on `twilioWebhookHarness.ts:2963` | unitsApiRosterTypeChecks | 1 red / 23: I4 race, `expected 200 to be 409` |
| FW2-1 fake I3 | REAL | M1e: `false &&` on `:2964` | same | 1 red / 23: I3 race, `expected 200 to be 409` |
| FW2-1 route facts | REAL | M1f: `caseworker: false` at `units.ts:1207` | same | 1 red / 23: I4 race, 200 |
| FW2-1 route mapping | REAL | M1g: `false &&` on `units.ts:1210` | same | 1 red / 23: `expected 500 to be 409` |
| FW2-2 effective flag | REAL | M2a: audit `primaryContact` back to the request's (`units.ts:1253`) | unitsApiRosterAutoPrimary | 1 red / 17: (h) |
| FW2-2 autoPrimary key | REAL | M2b: `autoPrimary = false` (`units.ts:1248`) | same | 1 red / 17: (h) |
| FW2-3 | REAL | M3: `if (!contact)` at `units.ts:1159` | unitsApiRosterTypeChecks | 4 red / 23: role landlord `expected 409 to be 404` x2, role pm `expected 200 to be 404` x2 |
| FW2-4 | REAL (docs, by reading) | - | - | `RUNBOOK.md:475` matches the code (`unitsRepo.ts:916-917`, `:1273`, `:1328`; `units.ts:1772-1781`); `unitsRepo.ts:975-983` matches `routes/webhooks/voice.ts:621-631` and the resolvers; the resolved issue's refs resolve at 2bbc6799. Residual drift: A5 |
| FW2-11 repo | REAL | M11a: `facts.landlordTyped &&` removed (`unitsRepo.ts:938`) | unitsRepoAutoPrimary.integration | 3 red / 13: (g) pm, owner, other |
| FW2-11 fake | REAL | M11b: same at `twilioWebhookHarness.ts:2979` | unitsApiRosterAutoPrimary | 4 red / 17: (g) tenant, partner, unknown, team member |
| FW2-12 repo list check | REAL | M12a: `false &&` on `unitsRepo.ts:1273` | unitsRepoRestoreWithLandlord.integration | 2 red / 18: both conflict cases; the R1 route probe also red (200, stale promotion) |
| FW2-12 repo promotion | REAL | M12b: `promoted` always undefined (`:1320`) | same | 2 red / 18: by flag, by scalar |
| FW2-12 fake list check | REAL | M12c: `false &&` on `twilioWebhookHarness.ts:3136` | unitsRestoreLandlord | 1 red / 24: the race, `expected 200 to be 409` |
| FW2-12 fake promotion | REAL | M12d: `promoted` always undefined (`:3172`) | same | 3 red / 24 |
| FW2-12 route decision | REAL | M12e: `promote = null` (`units.ts:1772`) | same | 4 red / 24 (incl. the consistent-read pin) |
| FW2-12 route type test | REAL | M12f: `contact.type === 'landlord'` -> `true` (`units.ts:446`) | same | 2 red / 24 |
| FW2-12 route pointer test | REAL | M12g: `phone_ref` clause -> `true` (`units.ts:444`) | same | 1 red / 24: the missing + pointer case |
| FW2-12 audit | REAL | M12h: `primaryPromoted` dropped (`units.ts:1805`) | same | 2 red / 24 |
| FW2-12 route gate | (by design) | M12i: `false &&` on `units.ts:435` | same | 0 red / 24 - SURVIVES: the repo re-decides "was the primary" on its own read (`unitsRepo.ts:1285-1286`), so the route's gate only saves reads; not a defect |

Verdicts: FW2-1 REAL, FW2-2 REAL, FW2-3 REAL, FW2-4 REAL, FW2-11 REAL,
FW2-12 REAL for the ruled definition (scope gaps A1, A2 are LOW against the
ruling's intent, not its text; A3 is test fidelity only).

---

## (C) Challenges

### C-1. Q5 ruling / spec revision 5 "Restore" - "the cleared landlord was the property's primary contact"

Implemented as "its row flagged, or the scalar naming it" (`units.ts:433-434`,
`unitsRepo.ts:1285-1286`), which matches the spec's definition in "Contact
list" (no row marked primary = no primary contact). But Q5 was ruled to stop
"a property comes back with nobody reachable", and reachability follows the
routing rule (flagged row, else the landlord of record; A2's citations). For a
list with no flagged row the cleared landlord WAS the reachable contact, and
the ruling's remedy does not fire. Ask Cameron whether "no row flagged" counts;
if yes, A2's two-line fix. If no, record the exception in the spec.

### C-2. Spec section 10's "a soft-deleted contact still exists" applied to an automatic promotion

The posture (`contactTypeGuards.ts:14-15`) was set for refusals (no new
deleted-contact refusal). FW2-12 applies it to an automatic routing choice,
where the codebase elsewhere treats a soft-deleted contact as unusable (A1's
citations). Recommend: a soft-deleted contact is not eligible for the
promotion (one clause, route only), and say so in spec section 4.

### C-3. Rulings and fix-wave choices checked and agreed

- B-1 accepted / FW2-1 design: a required `facts` parameter (TypeScript makes
  every caller state it), typed repo errors mapped to the same 409s, route
  pre-checks kept, so the spec's order holds in the no-race answer and per
  attempt (I4, I3, then reassignment, `unitsRepo.ts:916-924`).
- FW2a divergence: every `{ landlordId: null }` restore is conditioned on the
  list, not only promoting ones. A concurrent list edit on a soft-deleted
  property now answers 409 instead of a silent retry; there is no background
  writer of `contacts[]` (section D) and the dialog re-reads. Agree.
- FW2-2 scoped to the primary flag; `role` stays the request's (FW2a noticed;
  pre-existing; note the Activity projection DOES whitelist `role`,
  `units.ts:241`, so the Activity row shows the request's role).
- FW2-10 FILE, the R2B note NO ACTION, FW2-3's scope (the add route only - the
  restore promotion applies the same pointer test itself): agree.
- One remark on FW2a's "no test in this repo drives a route on DynamoDB Local;
  one was not invented here": for the route-to-repo window of FW2-12 that is
  the only kind of test that can pin production behavior today (A3), and it is
  cheap (R1: ~60 lines, real router, real repo, two in-memory stand-ins).

---

## (D) Swept and clean

Races, as interleavings (durable outcome last):

- Two adds, both landlord-typed, ownerless and primary-less: both attempts
  read no primary; the first write commits primary; the second's write loses
  its roster condition, re-reads (`unitsRepo.ts:994-1012`), sees the primary
  and joins non-primary. `facts` is constant per call, so FW2-11 does not
  change the race (SA-1 (e) still pins it).
- Two adds, mixed types: a contact not typed landlord never auto-promotes; the
  landlord-typed one promotes iff its own last attempt read no flagged row and
  no `landlordId`. Serial either way.
- Two landlord claims: the second loses, the retry path answers
  `landlord_reassignment_required` (`:1000-1006`).
- Add vs remove: a caseworker's role edit vs the seat's removal answers 409
  `contact_list_caseworker` whether the removal lands before the add's read or
  between its read and write (M1a, M1c); a PM add vs removal of the only
  primary ends in a serial state either way.
- Add vs restore: a tenant's landlord-role add vs "Restore without a landlord"
  answers 409 `landlord_not_landlord` (restore first, I3 per attempt) or
  `landlord_reassignment_required` (add first); a landlord-typed PM add vs the
  restore either makes the restore 409 (list changed) or joins non-primary
  behind the promoted contact.
- Restore vs a roster edit: any list change after the route's read
  (`units.ts:1707`) - including one DURING the type reads - answers 409 and is
  never retried (`unitsRepo.ts:1273` plus the conditioned write at `:1328`);
  shown on the real stack by R1.
- Restore vs a contact re-type between the type reads and the write: L1, a
  read of a different record (A4); not a hole in the unit-side fence.
- Restore vs a `primary_contact` PATCH: the scalar is outside the write
  condition, so the route's and the repo's "was the primary" can differ; the
  repo decides and the audit records the written outcome (FW2a noticed 3).
  API-only: no dashboard code writes `primary_contact`.
- Restore vs restore: the second reads a live unit and answers 409 (FW-1).
- Retry exhaustion: `addContact` answers 409 `unit_roster_conflict` after
  three lost conditions, nothing written (unitsRepoRoster "contended");
  `restoreWithLandlord(next: null)` can exhaust only on an A-B-A list change,
  since every other lost condition re-reads into a conflict.

Also swept:

- `addContact` callers: the route only in src (`units.ts:1198`); all test
  call sites pass facts; the two `world.unitsRepo.addContact = async () =>`
  overrides take no parameters. The only typed implementer is the FakeWorld.
- FakeWorld mirror: `addContact` and `restoreWithLandlord` are step-for-step
  the real methods (same checks, same order, same auto-primary clause, same
  promotion) - confirmed by M1d, M1e, M11b, M12c, M12d. The one behavioral gap
  is the harness-wide live-object `getById` (A3).
- The per-attempt refusals decide on an eventually consistent read
  (`unitsRepo.ts:886`) that no write condition validates. A false refusal
  needs a seat or a `landlordId` written within the replication window by a
  path that cannot write it for that contact (a caseworker cannot be newly
  seated; a non-landlord cannot claim or be set as owner), so it is not
  reachable in practice, and DynamoDB Local is always consistent. Optional
  hardening: `{ consistentRead: true }` there, as `restoreWithLandlord` has
  (`:1247`).
- Retry-path order: after a lost condition, the reassignment check
  (`:1000-1006`) runs before `write()` re-decides I4/I3, so in one contrived
  interleaving (a legacy caseworker-typed landlord of record with no stored
  list, re-asserted with role landlord while a PATCH re-points `landlordId`)
  the answer is `landlord_reassignment_required` where the per-attempt order
  would say `contact_list_caseworker`. Both refuse; nothing written.
- FW2-2 reads the effective flag from the ALL_NEW item of the very write, so
  it cannot disagree with the stored row.
- FW2-3's test is the guards' own (`contactTypeGuards.ts:71`, `:88`); the
  promotion's eligibility applies the same test (`units.ts:444-445`).
- Readers of the primary row / `landlordId`: `rosterResolution.ts:292-294`,
  `tourContacts.ts:124-129`, `rosterProvision.ts:231-234`, `:524-525` (all
  "flagged row, else landlordId"); placement nudges and `personEvents` use
  `landlordId` only (a promoted PM gets no landlord nudge - pre-existing); the
  conversion counts seats. No reader breaks on a promoted, ownerless property.
- Writers of `contacts[]`: `addContact`, `removeContact`,
  `restoreWithLandlord`, all route-only; the importer writes `landlordId` only
  (`lib/import/apply.ts:1519`, filed `import-bypasses-contact-type-rules`);
  the PATCH writes `landlordId` (checked) and `primary_contact` (filed
  `unit-primary-contact-unchecked`). No background writer, so the new
  no-retry restore cannot be starved.
- `isDeepStrictEqual` vs the DynamoDB condition: both sides come from the same
  document client's unmarshalling; no false conflict (both suites green, R1).
- ASCII: 0 non-ASCII lines added in `app/`, `RUNBOOK.md`, `docs/issues/` since
  d640cfb4.

---

## Housekeeping

- sha256 of every file mutated, before the first mutant and after the last
  revert (identical; each was also checked after its own revert):
  - `app/src/repos/unitsRepo.ts` `edc336696980a786f497d61e82e0af6e8798689be7b6f61eca44a33ebb937544`
  - `app/src/routes/units.ts` `35638ebe2f6d135f53f4f3bae7e3551dd7892ca3377c9b7badeb73df78ee84f9`
  - `app/test/helpers/twilioWebhookHarness.ts` `d435e7be531904cd3d81f6df4e1c13c2773ada9c47a628df9a2be8fc12b3e4c6`
- The two fix probes (A1's clause, A3's single list read) were reverted the
  same way.
- Both throwaway files deleted by exact name. No git writes; no full
  `npm test`, e2e, `db:start` or Docker command. `git status` afterwards shows
  this file and `R3-dashboard.md` (the parallel dashboard reviewer's, not
  touched here).
