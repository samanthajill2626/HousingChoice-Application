# Plan review R4 - reviewer A (terminal round)

Plan: `docs/superpowers/plans/2026-10-13-primary-contact-integrity.md` v4 @c0987bb7
Spec: as edited in c0987bb7 (sections 3, 9.2)
Inputs read: `plan-review/adjudications.md` "Round 3" (S1, S2) and
`git diff fda75085 c0987bb7`. Read-only: only grep, sed and git were run.

Nothing I found should change a decision. No existing pin breaks under the v4
rule, and the route passes `readContacts` on both restore branches. Two LOW
wording items remain.

## The question asked: who runs a NEW hand-off under v4, and is it covered?

The v4 rule is `landlordWasPrimary(roster, landlordId)`. It returns true when
the old landlord's row is flagged, or when NO row is flagged. The only restores
whose behavior changes compared with v3 are those on a NO-FLAG roster whose
scalar was absent or named someone else. I swept every caller of
`restoreWithLandlord` and every restore-route test, case by case.

**`app/test/unitsRepoRestoreWithLandlord.integration.test.ts` (real repo)**

- The no-flag rosters are `:154` (swap) and `:248` (clear), both with scalar
  `c-old`. They behaved the same in v3, and both stay GREEN:
  - `:154` already passes `readContacts` (S2.7 (b) "Call 2", plan ~L7718).
  - `:248` is a clear with `promote` supplied, and a clear needs no read.
- Every other case has a flagged row:
  - `c-old` flagged: `:110`, `:175`, `:228`, `:284`, `:306`, `:334`, `:382`,
    `:413`, `:434`, `:472`. Every swap among these passes `readContacts`
    through Calls 1 and 3-6.
  - `c-pm` or `c-ten` flagged: `:133` and `:264`. These run no hand-off, so
    they need no read. `:133` is the one swap without `readContacts`, and it is
    safe because nothing is handed off.
  - Legacy unit with no stored roster: `:195`. Its derived row is flagged, and
    it is a clear.
- `:362-372` uses a live (not soft-deleted) unit. It throws
  `RosterWriteConflictError` at the `isDeleted` check before any decision, so
  the swap variant's missing `readContacts` is never reached.
- `:402` (an unknown unit) throws before any decision.

**`app/test/unitsRestoreLandlord.test.ts` (route + fake)**

- `seedDeletedUnit` and `seedClearedPrimary` flag `c-old` (`:23-38`,
  `:348-353`).
- The only no-flag seed that reaches `restoreWithLandlord` is `u-p2`
  (`:386-403`). It is a clear, `clearedLandlordHeir` reads liveness itself,
  and the test stays GREEN.
- `u-2` and the "it is ownerless" late-body case never reach
  `restoreWithLandlord`. The first is a plain restore; the second is refused
  with 409 `restore_landlord_not_needed` first.
- `u-p5` and the new `u-p8` flag `c-ten` / `c-pm`. They run no hand-off.
- The race overrides at `:284-288` and `:551` drop the third (`opts`)
  argument. Both are safe:
  - At `:284` the unit is already live, so the fake throws
    `RosterWriteConflictError` before deciding.
  - At `:551` the contact list changed, so it throws on the
    `expectContacts` check before deciding.

**Other callers of `restoreWithLandlord`**

- `unitsApiRosterTypeChecks.test.ts:304`: a direct fake call, `c-old`
  flagged, a clear.
- `unitsRepoAutoPrimary.integration.test.ts:98`: landlord-only, derived row
  flagged, a clear.
- The S2.7 new integration file: every case has a flagged row. That includes
  the two stale-scalar cases (`c-pm` flagged, no hand-off, no read).
- S2.8's new `unitsRestorePrimaryHandoff.test.ts`: every "not the primary"
  case (`u-c3`, `u-s5`) flags `c-pm`, so it runs no hand-off. Its every-read-
  fails spy therefore stays 200.
- S2.12 parity restore case: `c-old` flagged.
- `app/src`: the only caller is the restore route (`routes/units.ts:1850-1851`).
  The script, the dev seams and the dashboard do not call it. Dashboard tests
  mock `restoreUnit`, and no dashboard code implements the repo.
- e2e: both restore walks in `property-roster.spec.ts` (`:372-434`,
  `:437-466`) use landlord-only units (derived row flagged), so their outcome
  is unchanged.

**The route on the swap path.** S2.8 (d) builds `handoffOpts` with
`readContacts: (ids) => readRosterContacts(contacts, ids, log)` (plan L8984).
It passes them on BOTH branches: swap at L8994, clear at L8998. A no-flag
swap through the API therefore always has a liveness read. If that read fails,
the restore answers 503 `roster_read_failed`, which is the spec 4.6 "unknown ->
refuse" behavior. That is a new 503 exposure only for no-flag units, which v3
and `main` did not hand off.

**Pins.** No existing pin breaks. S2.7 (b) and S2.8 (b) already cover every
case that changes. The only new assertion is the pure test's (S2.7 (c)), and
it is correct. `[]` returns true only in theory: with a `landlordId`,
`unitContacts` always derives a flagged row, and `clearedLandlordHeir` returns
early when `clearedLandlordId` is undefined.

## The changed text, reviewed cold

- **The helper (S2.7 (e)):** the two-line body matches the docblock and the
  pure test. It sits at the same anchor as v3, so it collides with no other
  insertion.
- **The callers:** the repo (d) and the fake (e) both call
  `landlordWasPrimary(roster, old)` behind the unchanged
  `old !== undefined && !keepsOld` guard.
- **`clearedLandlordHeir` (S2.8 (b)):** it drops its `unit` parameter, and its
  body no longer references `unit`. The call site is updated (plan L8975).
  `UnitItem` is still used for `listRead`'s type.
- **Scalar re-align:** the `else` branch is now reached only when a different
  row is flagged, or on `keepsOld` / `old === undefined`. So the re-align
  writes that flagged row's id, or REMOVEs the scalar.
- **Agreement between route and repo:** the clear's route decision and the
  repo's decision now come from the same pure function over the same list
  (`expectContacts`-fenced). The scalar race I noted in R3 is gone.
- **Spec and docs:** spec 3 / 9.2, the section 3 watch item, S5.9 and S5.10
  now agree that the scalar has no runtime reader, and the code bears that out.
- **Comment nit (not worth a finding):** the `clearedLandlordHeir` docblock
  still says "the contact list of `unit`" (plan ~L8894) after `unit` was
  dropped. It means the route's unit.

## Findings

### U1 [LOW] Spec 4.6 and 4.7 still describe the restore hand-off in flag-only terms that v4 contradicts for a no-flag roster

- Spec 4.6 runs the remove rule "if the cleared landlord was the primary", and
  re-runs the heir on a swap "when the old landlord was primary". Under the
  section 3 definition (the FLAG), a landlord on a no-flag roster is not the
  primary, yet v4 hands off.
- Spec 4.7 bullet 2 goes further: "A write that does not touch the primary (...
  a swap of a non-primary landlord) does not run a hand-off". A no-flag swap is
  exactly that, and v4 hands off.
- Only 9.2 states the no-flag rule.

A code reviewer anchored on 4.6 / 4.7 would report the no-flag hand-off as a
defect. The fix is one parenthetical in each: "(or no row is flagged -
`landlordWasPrimary`, 9.2)". No plan change.

### U2 [LOW] The no-flag asymmetry between restore and the contact-delete fan-out is not stated

- On a NO-FLAG roster, v4 treats the landlord of record as primary for a
  restore.
- The contact-delete fan-out keeps spec 4.6's flag-only test: "units whose
  `unitContacts()` primary is this contact". Deleting the landlord of record of
  a no-flag stored roster therefore hands off to nobody, even with an eligible
  contact. P1 then answers nobody (deleted), and the property box shows it.
- P2 and the script backstop it: the next eligible add or edit promotes, and
  the script targets the unit.
- This is consistent with the spec as written and needs no code. But nothing
  says why delete and restore read the same no-flag roster differently.

One sentence in spec 4.6 "Delete the contact" (or 4.7's gaps bullet) would stop
a reviewer from "fixing" either side.

## Contested

None. S1 and S2 are resolved as adjudicated. No R1-R3 finding of mine is left
open.
