# Spec adversarial review - round 2 adjudications

Reviewer A, continued (holding round 1, the revised v2 spec, reviewer B's
independent report, and the round-1 adjudications). Report:
`spec-r2-reviewer-a.md`. 18 findings.

**Outcome: 16 ACCEPT, 1 ACCEPT-AND-CORRECT-THE-RECORD, 1 ACCEPT-UPGRADE.
Zero rejected.** The round changed decisions in every item, so it is not
terminal.

## The round's headline, verified by the planner before adjudication

**#1 BLOCKING - `test.env` does not reach `globalSetup`, so
`enableTtlIfNeeded` DOES run under `npm test`.** ACCEPT. Verified at
`app/test/globalSetup.ts:90-91`, where the code says so in its own comment:
"vitest test.env applies to workers, not globalSetup, so we must set
process.env ourselves here". `globalSetup` sets only the credentials -
never `DYNAMO_DISABLE_TTL` - so `createAllTables` -> `ensureTable` ->
`enableTtlIfNeeded` runs for all ~23 `hc-local-` tables on EVERY `npm test`.

The v2 "Live-ness note" claimed the two TTL sends were dead on the gate
path. It is exactly backwards: `UpdateTimeToLive` is on the gate path, in
the shared-table bootstrap that every run pays before a single test starts.

**Second-order finding, out of scope to fix here but too important to
drop.** This also means `DYNAMO_DISABLE_TTL=1` does NOT immunise the shared
`hc-local-` tables. `vitest.config.ts:103-113` already hedges that the flag
"does not DISABLE TTL, it declines to ENABLE it" and is not retroactive -
but nobody noticed that `globalSetup` re-enables it on every run, so for
the shared-table suites the reaper is on, always. A future suite that pins
a past clock and uses the shared tables carries the same time bomb
`groupCrossCheck` did. FILED as a new Tier-2 issue rather than expanded
into this mission's code.

## Accepted - item 1A

| # | finding | verdict |
|---|---|---|
| 1 | (above) | ACCEPT, blocking. Note inverted; new issue filed for the second-order effect. |
| 2 | "Nine control-plane sends" is false - 26 sends plus 5 waiter sites; 17 `DescribeTable`/`ListTables` reads omitted with no reason while a `DescribeTimeToLive` read is listed | ACCEPT. The enumeration was command-type-limited and presented as exhaustive, which is worse than an admitted sample. Re-enumerated, reads given an explicit disposition. |
| 3 | The verification hook is itself an unprotected read that fails OPEN (`db-update-gsis.ts:88-101`), and v2 extends that shape to `UpdateTimeToLive` without saying what a failed re-read does | ACCEPT. Specified: a failed re-read FAILS CLOSED and rethrows the original error. Re-sending `UpdateTimeToLive` blind can draw a `ValidationException`, converting a transient into a hard failure. |
| 4 | Routing suite B's raw `CreateTable` (`unreadIndexRepo.integration.test.ts:728`) through the retry re-creates the A1 defect at a site with NO catch and no specified hook | ACCEPT, and the item is DROPPED rather than specified. It was scope reached for on the strength of "it is suite B's own fixture"; that is not a reason to hand it a retry whose contract does not fit it. |
| 7 | The accepted A1 fix adds `waitUntilTableExists`, whose SDK default makes the second poll a flat 20s and throws at 60s, inside four `ensureTable` hooks budgeted at 60s | ACCEPT. Fixing one false red by arming another is this mission's own failure mode. Replaced with a bounded short-interval `DescribeTable` poll. |
| 9 | The local-hostname list omits `[::1]`, the form `URL.hostname` actually yields; `db-create.ts:25` already handles both | ACCEPT. Verified at `db-create.ts:25`. Both forms accepted, and an acceptance case pins it. |
| 10 | The `dynamoAccessKeyGuard` exclusion reason is false - the suite asserts cross-key VISIBILITY, which no retry can mask; `:342` is already best-effort | ACCEPT. A wrong reason for a right-looking decision is worse than no reason. Reason corrected. |
| 11 | No acceptance case proves `ensureGsis`'s retry still fires after being newly gated - the refactor can silently disarm the anchor's one WORKING mitigation | ACCEPT, and this is the round's best catch after #1. The mission could have broken the only retry that exists today while adding one that never fires. |
| 12 | Acceptance case 2 drives a waiter through a stub that must also answer `DescribeTable`, or it burns its budget and throws | ACCEPT (moot for the SDK waiter after #7, live for the replacement poll). Stub contract specified. |
| 13 | The stub must throw real exception INSTANCES: `dynamoAdmin` discriminates by `instanceof` (`:91`, `:148`) while the retry discriminates by `err.name` | ACCEPT. A test that passes for the wrong reason is precisely what this mission exists to stop. |

## Accepted - items 1C/1D, 2, 3

| # | finding | verdict |
|---|---|---|
| 8 | The measurement protocol's volume makes THIS MISSION the dominant load source, invalidating its own contention snapshots and disqualifying late runs under its own QUIET rule, with no ordering or fallback | ACCEPT. A protocol that destroys its own acceptance environment is self-defeating. Run count cut, ordering fixed baseline-first, explicit fallback when the neighbours finish. |
| 16 (part) | Item 1C re-runs an experiment the anchor already ran at `:293-301` | ACCEPT. Arms cut to the minimum that dates the claim to THIS container rather than re-deriving a settled result. |
| 6 | Item 2's `scanProgram` remedy is ALREADY IMPLEMENTED - `:98` and `:106` already short-circuit `isCatchDeclared \|\| isErrorTyped` - and the real cut is the eager checker call at `:97`, which is not named | ACCEPT. Verified by reading `:92-101`: `getShorthandAssignmentValueSymbol` runs before the `legal` test is consulted, so the checker is invoked even for a wired key. Remedy corrected to hoisting the `legal` check. |
| 14 | Item 2's `buildProgram` branch pre-commits two remedies that do not exist - `createCompilerHost` has no type-checking to remove, and `include: ["src"]` leaves no roots to narrow | ACCEPT. Pre-committing a remedy for an unmeasured phase is what round 1 already punished. Replaced with: measure, report, bring the remedy back as a decision. |
| 5 | Once 3(c) can only PASS or SKIP, NOTHING anywhere asserts the BUILT dashboard's identity tags - a `vite build` regression is undetectable forever - and the mandated SKIP message tells the operator to rebuild, which reproduces the SKIP | ACCEPT, and it is the honest cost of the chosen design. The coverage cannot be recovered without building the dashboard in a gate, which was considered and not chosen. So: the gap is FILED as an issue naming the remedy and its cost, and the SKIP message is rewritten so it cannot send an operator round a loop. An invisible gap becomes a tracked one. |
| 15 | Two mandated actions have no deliverable or seam: the `_CLUSTERS.md` supersession is asserted as recorded but is not a deliverable, and 3(c)'s SKIP branch cannot be observed given the fixed `distDir` at `staticSmoke.test.ts:18` | ACCEPT. Both given a concrete seam. |
| 16 (rest) | The `<tmp>/x/y/` decoy is unreachable (one probe depth, not two); reviewer B's accepted narrowing was not applied at line 458 | ACCEPT. Both corrected - the second is an accepted finding that did not survive the rewrite, which is exactly what a re-review is for. |

## Contested adjudications

| # | finding | verdict |
|---|---|---|
| 17 | The single REJECT is conceded on the merits, but was attributed to a remedy A13 never proposed - A13 was the phase-boundary finding, adjudicated ACCEPT | ACCEPT THE CORRECTION. The record was wrong: I attached a rejection to a finding number already accepted, inventing an "implied remedy" in order to reject it. The rejection stands on its own merits but is re-attributed to nobody - it is my decision about instrumentation scope, not a ruling on a finding. **Round 1 therefore stands at 25 accepts and 0 rejects.** |
| 18 | B9 can be settled NOW: `waitForTableExists`'s `checkState` swallows every exception as a RETRY tick, so the exclusion is verified correct and the UNVERIFIED paragraph should be deleted | ACCEPT-UPGRADE. A reviewer resolving an open question rather than restating it is the best possible return on keeping it alive across rounds. The paragraph is deleted and the exclusion stated as verified, with the mechanism named. |

## Status

Round 2 changed decisions in every item, including one BLOCKING inversion
of a claim v2 asserted about the gate path. Not terminal. Round 3 follows
with the same continued reviewer. Hard cap is 4.
