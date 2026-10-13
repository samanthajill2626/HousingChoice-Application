# Plan review R3 - reviewer A

Plan: `docs/superpowers/plans/2026-10-13-primary-contact-integrity.md` v3 @fda75085
Spec: as edited in fda75085 (sections 3, 9.2)
Inputs read: `plan-review/adjudications.md` "Round 2" (Q1-Q4) and
`git diff dd8505e5 fda75085`. Read-only: only grep, sed and git were run.

No BLOCKING finding. Every v3 edit is mechanically correct: the anchors, the
ordering, and the RED/GREEN traces all hold. One MEDIUM finding contests the
VARIANT of the Q1 rule. If it is accepted, Q1's decision changes. The other
finding is LOW wording.

## The questions asked, answered

**1. Do the (a2) and (e0) old_strings exist, uniquely, at S2.8 time?** Yes.

- `routes/units.ts`. On `main` the unitsRepo import has
  `LandlordReassignmentRequiredError, / RosterWriteConflictError, / unitContacts,`
  at lines 52-54. S2.4 (a) inserts `PrimaryContactDeletedError,`. S2.6 (a)
  inserts `RosterReadFailedError,`. So when S2.8 runs, the three lines
  `RosterReadFailedError, / RosterWriteConflictError, / unitContacts,` exist.
  They are unique, because the only `^  RosterWriteConflictError,` /
  `^  unitContacts,` lines are 53-54.
- `twilioWebhookHarness.ts`. Lines 123-124 are the only such lines. S2.4 (e)
  and S2.6 (c) leave them as `PrimaryContactDeletedError, /
  RosterReadFailedError, / RosterWriteConflictError, / unitContacts,`, so the
  (e0) anchor is present once.

**2. Does anything call `landlordWasPrimary` before it is imported?** No.

- Between S2.7 and S2.8 the only caller is `unitsRepo.restoreWithLandlord`,
  which is in the defining module.
- The route still runs `soleLandlordToPromote`, and the fake still runs
  `main`'s code.
- Inside S2.8 the order is safe: (a2) comes before (b) `clearedLandlordHeir`,
  and (e0) comes before (e) the fake.
- In S2.7, (d) references the helper before (e) inserts it, but both are in
  one task with no check in between.

**3. Does the helper's placement collide with an earlier insertion?** No.

- (e) sits directly above `export function createUnitsRepo` (unitsRepo.ts:619,
  unique).
- S2.2 (c) inserts after `ROSTER_WRITE_MAX_ATTEMPTS` (:221), which is 400
  lines earlier.
- S2.9 (d) appends inside the returned object, at the file tail.
- S5.1 inserts after `rewriteAcceptedAuthorities` inside the object.
- `UnitContact` is declared at :71, so the helper's types resolve.

**4. Is the new S2.7 stale-scalar SWAP case RED on `main` and GREEN after?**
Yes. The case is roster `[c-old false, c-pm true]`, scalar `c-old`, swap to
`c-new`, and no `readContacts` is passed.

- On `main`'s `restoreWithLandlord` (unitsRepo.ts:1313), `oldWasPrimary` is
  true through the scalar disjunct. Every row's flag is then set to
  `contactId === c-new`, which gives `[c-pm false, c-new true]` and scalar
  `c-new`. The expected `[c-pm true, c-new false]` FAILS, so the case is RED.
- On v3:
  - `landlordWasPrimary` sees a flagged row (`c-pm`), so it answers by the flag
    and returns false.
  - No hand-off runs, so no liveness read is needed. The missing
    `readContacts` therefore cannot raise `RosterReadFailedError`.
  - `nextRoster` is `[c-pm true]` plus the pushed
    `{ c-new, landlord, false }`, which carries no name/company keys.
  - The `else` branch finds `c-pm` flagged and sets the scalar to `c-pm`.
  - `handoffs` stays `[]`.
  - Every assertion holds, so the case is GREEN.
- The clear twin, traced the same way, is also RED on `main` and GREEN on v3.
  On `main`, `promote: null` plus the scalar disjunct clears `c-pm`'s flag. On
  v3 the `else` branch leaves `c-pm` flagged with scalar `c-pm`.
- The three caseworker-integrity pins are GREEN under v3. All three have no
  flagged row and a scalar of `c-old`:
  - repo `:154` hands off via `EVERYONE_LIVE_LANDLORD` to `c-new`;
  - repo `:248` applies `promote: 'c-pm'`;
  - route `:386` picks `c-pm` through `clearedLandlordHeir` and the fake.
- The new route test u-p8 (flagged `c-pm`) stays GREEN.

**5. Is the pure test's import of `unitsRepo` safe?** Yes.

- It is the same pattern S2.2's pure `unitsRepoAutoPrimaryDecision.test.ts`
  already uses.
- `unitsRepo.ts` has no top-level I/O. Its module-level code is constants and
  function declarations; clients are built inside `createUnitsRepo`.
- The `propertyContact <-> unitsRepo` cycle is safe whichever side loads
  first, because neither touches the other's bindings at top level (R3).
- The globalSetup probe still applies, as section 0 notes.

**Also checked.** S2.4 (c):

- The `u-3` anchor is unique.
- `seedContact` defaults to `type: 'landlord'`.
- With the seed, P2 reads `[c-ll-1]` as live and keeps `c-pm-3` non-primary.
- The test's other assertions are lenient (`toMatchObject`, sorted ids), so the
  S3.6 row flags do not disturb them.
- It is the only route-level add test that needed a seed. The other three
  callers seed their landlords, or add only non-eligible types.

## Findings

### T1 [MEDIUM] Q1's chosen variant keeps a permanent scalar read that the spec itself calls stale. The restore outcome then depends on write order, and a scalar-free rule passes every pin

**What is wrong.** `landlordWasPrimary` (plan S2.7 (e)) does this: when NO row
is flagged, a scalar naming the landlord counts. But the same branch makes that
exact scalar disappear.

- Spec 4.4: "When nobody is promoted and NO row is flagged after the write, a
  stale scalar is REMOVEd".
- S2.3's `addContact` writes `primary_contact: null` whenever no row is
  flagged. This runs on every non-promoting add, and on every dashboard re-role
  of any row.

**Consequence.** Take a zero-flag unit with landlord L and a legacy scalar of
`L`.

- If a restore runs first, it hands off (clear: the earliest eligible contact
  is promoted; swap: the new landlord is flagged).
- If anyone adds or re-roles a contact first, the scalar is gone. The same
  restore then hands off to nobody, and the property is left with no primary
  next to an eligible contact.
- New zero-flag units can also be created after deploy, through the API
  demotion `primaryContact: false` that R10 allows. Their scalar is REMOVEd at
  the same moment, so this rule NEVER hands off for them.

So the rule reads a value only for exactly the population the branch keeps
erasing.

The plan pins this order dependence. `landlordWasPrimary.test.ts` asserts that
"NO row is flagged and the scalar is absent ... -> false".

The spec now also contradicts itself:

- 4.4 calls a no-flag scalar stale;
- 4.7 bullet 1 still says "Nothing reads the scalar at runtime";
- 3 and 9.2 now say the scalar decides when no row is flagged.

Practical reach is small. The one-time script (S5.2) flags an heir on every
zero-flag unit that has a live landlord or an eligible contact. After it runs,
the scalar branch changes no outcome. Before it runs, or for units it skipped,
the outcome depends on write order.

**The alternative.** Use "the old landlord's row is flagged, OR no row is
flagged at all", which is P1's own fallback to the landlord of record. It reads
no scalar. Traced against every case:

- All three caseworker pins stay GREEN: none has a flagged row, and L is the
  old landlord.
- Both new S2.7 stale-scalar cases stay GREEN, and so does route u-p8: `c-pm`
  is flagged, so the answer is false.
- The PINs with `c-ten` flagged (repo `:265`, route u-p5) stay GREEN.
- The landlord-only derived row is flagged, so it answers true, as today.
- Only one assertion changes: the pure test's
  "no flag, scalar absent -> false" becomes true.
- The `scalar` parameter, the spec 3 / 9.2 "exactly ONE place" text, and the
  S5.9 / S5.10 sentences about the scalar all drop out.
- It also hands off on a zero-flag clear. That matches G1, and the P4 bullet's
  intent that "a unit with ... at least one ELIGIBLE live roster contact has a
  live primary".

The one behavior difference from `main` is this: a zero-flag unit with no
scalar now hands off on restore where `main` did not. That is G1-consistent,
and P1 already names that landlord as the property contact.

**Implication.** Re-rule Q1's variant to the scalar-free rule (one sentence in
spec 3 / 9.2, and one test assertion). Or, if the scalar read stays, reconcile
spec 4.4 and 4.7 with it, and state the order dependence as accepted.

### T2 [LOW] New and edited text still describes `main`'s rule or "no reader"

- Spec 4.7 bullet 1 (spec L362-366): "Nothing reads the scalar at runtime." This
  contradicts the new spec 3 / 9.2.
- Plan S2.7 (c), the `restoreWithLandlord` interface docblock (plan L8019 /
  L8030): "when the old landlord was the primary (roster flag or scalar)". That
  is `main`'s OR rule, not `landlordWasPrimary`'s.
- Plan S2.8 (b), the `clearedLandlordHeir` docblock (~L8885): "its contact-list
  row flagged, or the primary_contact scalar naming it". Same problem. This is
  a new docblock that the code reviewers will hold against the code.

Under T1's alternative, all three become "flagged, or no row flagged". If T1 is
not taken, they become "the flag; the scalar only when no row is flagged".

## Contested

- **Q1 (variant):** T1 above. The adjudication said P6 was "moot under
  option (b)". Under v3's variant it is not fully moot: a zero-flag owned unit
  with no scalar still loses its property contact on a clear, with no hand-off
  and an eligible contact left unpromoted. The spec describes this nowhere.
- **Q2, Q3, Q4:** no disagreement. Q3's pins are correct. The repo case and
  the route case each pin their own copy of the `else` branch, and the
  decision itself is now one shared function.
