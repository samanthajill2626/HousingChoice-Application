# Plan review R1 - reviewer B (adversarial, plan-blind to rationale)

Plan: `docs/superpowers/plans/2026-10-13-primary-contact-integrity.md` (v1, 08fd4208)
Spec: `docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md` (rev 6)
Repo state read: worktree `W:\tmp\primary-contact-integrity` at 08fd4208 (read only;
nothing run).

## Scope of this review

Examined deeply (code read against the tree, anchors and claims checked):
sections 0-3; S1.1-S1.7 in full; S2.1-S2.11 in full; S3.1, S3.3, S3.5, S3.6;
S4.4, S4.6-S4.10; S5.1, S5.5, S5.6, S5.10, S5.11, S5.12.
Skimmed (structure, anchors, copy strings only): S1.8, S2.12-S2.14, S3.2,
S3.4, S3.7, S4.1-S4.3, S4.5, S4.10b-S4.13, S5.2-S5.4, S5.7-S5.9.

Mechanical checks done across the WHOLE plan (scripted, read-only):
- every `old_string` block was extracted and counted against the current
  tree; each one that does not match today's tree is text an EARLIER task
  writes (S1.4 -> S2.4 -> S2.6 -> S2.8 -> S3.5 import chain; S2.2 -> S2.5;
  S2.7 -> S2.9; S2.8 -> S2.9 harness; S4.2 -> S4.3; S4.7 -> S4.8; S4.8 ->
  S4.10; S4.9 -> S4.10b). The one non-unique anchor (S4.9 1e) is declared
  `replace_all`. No dangling anchor found.
- every `npx vitest run test/... src/...` path either exists or is created by
  an earlier task.
- every user-facing string in spec 7.1-7.6 appears in the plan verbatim.
- RUNBOOK, GLOSSARY and issue-file anchors (S5.9-S5.11) exist verbatim, once.
- No second full `UnitsRepo` implementation exists besides the API-test fake
  (`app/test/placementNudges.test.ts:182` is an `as unknown as` cast), so the
  new required members (`handOffPrimaryFrom`, `assignPrimaryIfCurrent`) break
  no other typecheck.
- The `propertyContact.ts <-> unitsRepo.ts` ESM cycle (R3) is safe: neither
  module touches the other's bindings at top level (verified against
  `app/src/repos/unitsRepo.ts:1-60` imports/consts and the S1 module text);
  no app test `vi.mock`s either repo.

Surface sweep (independent of the plan, `grep` over `app/src`, `dashboard/src`,
`e2e/`): mutation surfaces of the roster / primary / landlord of record are
exactly unit create, unit PATCH, contact-list add/remove, contact DELETE /
restore, unit restore (plain / clear / swap), importer upsert/retract, seeds,
dev seams (`routes/dev.ts:1254` org-fixture writes only
`accepted_authorities`; `services/statusTransition.ts:382,521,643` write only
status / final_rent). Caseworker conversion refuses any rostered contact
(`services/caseworkerConversion.ts:229-237`), so it cannot strand a primary.
Readers: the four ladder copies, `resolveTourContactNames` callers,
`resolveRoster` default callers (incl. `rosterProvision.ts:576,618`,
`describeRoster`'s second `resolveRoster` for `defaultPrimaryName`), the
property page, `rosterSuggestions`, the Activity projection. All are
covered by a task. I found no unenumerated mutation surface or reader.

The plan is unusually complete. The findings below are what remains.

---

## 1. [MEDIUM] Restore still decides "the old landlord was the primary" from the scalar - contradicts spec 3 / 4.7, and the plan's own docs then state the opposite

**What is wrong.** Spec section 3: "The FLAG is the truth ... Code that needs
'who is primary' reads `unitContacts(unit)`, never the scalar." Spec 4.7:
"Nothing reads the scalar at runtime." Spec 4.6 runs the remove rule on a
restore only "if the cleared landlord was the primary". The plan rewrites
both restore deciders and keeps a runtime read of the scalar in each:

- S2.7 real repo `restoreWithLandlord` (plan line 7941):
  `oldWasPrimary = ... (oldRow?.primaryContact === true || unit.primary_contact === old)`.
- S2.8 route helper `clearedLandlordHeir` (plan line 8646):
  `clearedWasPrimary = clearedRow?.primaryContact === true || unit.primary_contact === clearedLandlordId`.
- S2.8 fake `restoreWithLandlord` (plan line 8828): same disjunct.

These are inherited from `main` (`app/src/routes/units.ts:468`,
`app/src/repos/unitsRepo.ts:1313`), which also makes the spec's surface
sweep (9.2: "The `primary_contact` scalar has NO runtime reader") factually
wrong; the plan's sweep did not catch it and no ruling (R1-R25) records the
deviation. Worse, S5.9's new GLOSSARY text (plan ~line 20166: "nothing reads
the scalar at runtime") and S5.10's RUNBOOK text ("Nothing reads that field
at runtime") will ship false statements next to code that does.

**Evidence of consequence.** Take a unit whose scalar names landlord L while
a different LIVE row X is flagged primary (legacy: a pre-P2b PATCH of
`primary_contact`, `lib/unitFields.ts:107`; the backfill aligns these only
after it runs, spec 13). "Restore without a landlord": `clearedWasPrimary`
is true from the scalar alone, so `chooseHeir` picks the earliest eligible
remaining row and `applyPrimary` demotes X. Under `main` the same stale
state promoted only when exactly ONE eligible row remained
(`soleLandlordToPromote`, `units.ts:470-475`), so when X was the only
eligible row X stayed primary; under the plan any earlier eligible row
steals it. The widened heir rule enlarges the blast radius of the scalar
read.

**What it implies.** Either decide `oldWasPrimary` / `clearedWasPrimary`
from the flag only (unitContacts' row), with a test pinning "stale scalar,
different live flagged row -> restore leaves X primary", or add an explicit
ruling that restore keeps the scalar disjunct and correct the spec 9.2 claim
and the S5.9 / S5.10 doc text. As written, a literal build ships code and
docs that contradict each other.

---

## 2. [LOW] Section 0's "Mid-build breakage: none expected" is false inside S2

**What is wrong.** Plan section 0 states every slice leaves `main`'s behavior
intact for paths it has not reached. Two task pairs inside S2 break the REAL
API between their commits:

- S2.5 makes `unitsRepo.removeContact` throw `RosterReadFailedError` whenever
  the removed row is primary and `opts.readContacts` is absent (plan
  6630-6638). The route still calls `units.removeContact(unitId, contactId)`
  with no options and has no mapping for that error
  (`app/src/routes/units.ts:1318-1345`) until S2.6. Between the S2.5 and S2.6
  commits, removing ANY primary row through the real API is a 500.
- S2.7 makes the swap branch of `restoreWithLandlord` throw the same error
  when the old landlord was primary and no `readContacts` is passed; the
  route passes it only from S2.8. Between those commits a "Restore with this
  landlord" of a primary landlord 500s.

Neither window is visible to the task's own tests (they run the repo
directly or the API-test fake, which is updated in the later task).

**What it implies.** Harmless if S2 is executed contiguously, but the plan
tells the builder slices are the stop points and that nothing breaks
mid-build; a builder stopped at S2.5 or S2.7 (failed gate, quota, handback)
leaves a branch whose real routes 500. Either state the two windows in
section 0, or fold each repo change into the same task as its route wiring.
(The S4.9 -> S5.7 e2e copy window is already called out by S4's contract
issue 1 and is fine.)

---

## 3. [LOW] The contact-DELETE hand-off's e2e load was not swept: 60 concurrent consistent full-table Scans in one cleanup block

**What is wrong.** S2.11 awaits `handOffPrimariesOfDeletedContact` inside
`DELETE /api/contacts/:id`, before the existing unread-reset and presence
fan-outs (plan S2.11 step 3b; current handler
`app/src/routes/contacts.ts:2246-2347`). Every delete therefore runs one
strongly consistent Scan of the WHOLE units table (live and deleted). The
S2 watch item sweeps only APP tests for contact deletes ("swept:
contactSoftDelete, contactsCrud, voiceInboxActivity, contactEmailReaders").
It does not look at e2e: `e2e/tests/dashboard-next/roster-paging.spec.ts:186-190`
deletes `EXTRA_TENANTS = 60` (`:48`) contacts in one `Promise.all` inside a
`finally`, and by then the serial suite's lane holds every unit earlier
specs minted. That is 60 concurrent consistent Scans on the shared DynamoDB
Local, which this project already knows degrades under sustained load.

**What it implies.** Probably survivable (those deletes are best-effort and
swallow failures), but it is an unmeasured new load on the one gate (gate 4,
capped at 2700 s by R24) that has the history of timing stalls. Worth a
watch item in S5.12 step 8 ("if roster-paging's cleanup slows, this is
why"), or a pre-gate timing of that spec. Not a correctness defect.

---

## Checked and found sound (no finding)

Recorded so the next reviewer does not re-derive them:

- P1 walk (S1.2): candidate order, the tenant id test before any read,
  `read_failed` stops the walk, `deleted` vs `none`, the empty-contactId
  choice (noted by the plan) - all match spec 4.1; both walks share
  `judgeCandidate`.
- Diagnostics (S1.7): per-state codes/texts match today's code paths
  (`rosterProvision.ts:231-247`, `:515-544`), including is_tenant ->
  "fewer than two reachable members" (today the tenant phone check runs
  first, so the landlord step only reached with a phone) and the re-throw of
  the original error on a failed read.
- P2 (S2.2/S2.3/S2.4): `autoPrimaryLivenessIds` / `decideAutoPrimary` give
  main's rule when no read is supplied, promote only X, treat a deleted /
  missing flagged primary or landlord as absent, refresh per attempt (the
  racing test's call sequence `[['c-dead'], ['c-live']]` is what the code
  produces), and the 409 is decided before the reassignment refusal and
  after I4 / I3 in both route and repo. The stale-scalar REMOVE is
  unconditional when no row is flagged, as spec 4.4 asks.
- P3 remove / delete / restore (S2.5-S2.11): consistent reads, the excluded
  contact never passed to the liveness read, `applyPrimary` appends the
  off-roster landlord row, bounded retries, best-effort service that never
  throws, contact restore pinned as no-op.
- 7.5 block (S3.5/S3.6): one complete read over `rosterContactIds` (landlordId
  included), fallback to today's best-effort enrichment, block absent on
  failure, and the S3.6 anchor (`res.json({ unit: { ...updated, contacts:
  await enrichRoster(updated) } })`) is still present exactly twice after
  S2.4 and S2.6.
- Intro reasons (S3.1): reasons collected then emitted in spec order
  (`INTRO_FALLBACK_ORDER`), owner failure -> `['lookup_failed']` alone, unit
  failure keeps tour reasons, placement never carries tour reasons, null
  owner untouched; the chosen variant is unchanged in every branch I traced
  against `relayFanOut.ts:444-578`.
- e2e walk (b) is reachable: the tour's default people list is the tenant
  alone (the Open relay group control is disabled for a too-thin roster,
  `TourDetail.tsx:349-358`), and the plan adds Mark to the tour plan by
  hand first (`POST /api/tours/:id/roster/members`, route exists at
  `routes/tours.ts:663`), exactly Sam's real flow.
- Dashboard roster source (S4.6/S4.10): the block lives in its own state
  field, survives `setUnit` from PATCH / status / photo responses, and both
  restores re-read and replace `rosterUnit`.
