# Plan adversarial review - round 2 adjudications

Reviewer C, continued (holding round 1, plan v2, reviewer D's independent
report, and the round-1 adjudications). Report: `plan-r2-reviewer-c.md`.
15 findings.

**Outcome: 15 ACCEPT, 0 rejected. NOT terminal** - but the reviewer's own
verdict is that every fix is mechanical and none reopens a decision.

**The round's theme, in its own words: two round-1 fixes introduced new
defects OF THE CLASS THEY CLOSED, and a third is unexecutable against the
code.** That is the sharpest possible verdict on a revision, and it is
right in all three cases.

## The two blockers

**#1 - S5's TTL probe cannot run at all.** ACCEPT. `globalSetup`'s
returned teardown calls `dropKeyedLocalTables` -> `dropAllTables`
(`globalSetup.ts:216`, `globalTeardown.ts:279`), so "after a run" there is
no `hc-local-` table left to `DescribeTimeToLive`. The probe would find
nothing, and round 1's whole point - file the issue on evidence, not on an
inference from a comment - would collapse straight back into the inference.

Replaced with a direct probe of the mechanism: call the exported
`ensureKeyedLocalTables()` in a process where `DYNAMO_DISABLE_TTL` is
unset, describe the TTL status, repeat with the flag set, drop what was
created. No container restart, no new access key, no new database. **And
if the probe says TTL is NOT enabled, the claim is wrong, the issue is not
filed, and that is a finding.**

**#2 - the retried-only ACTIVE poll has no seam, and the obvious wrong
answer passes all 17 cases.** ACCEPT, and this is the round's best
finding. The helper THROWS on that path, so no return value can carry "we
retried". The natural shortcut - a module-level flag - is WRONG, because
`ensureTable` is called concurrently
(`todayUnmatchedNonRegression.test.ts:107`): one call's retry would make
another call poll. And every acceptance case is sequential, so the bug
would ship green.

The plan now specifies a per-call local set by an `onRetry` callback, with
the code shape written out, and says why the flag is wrong. A fix for a
hot-path defect that introduced a concurrency defect is exactly the class
round 1 closed.

## Accepted - S1

| # | finding | verdict |
|---|---|---|
| 3 | Cases 15/16 STILL cannot run - the round-1 fix covered `liveIndexNames` but not `waitUntilTableExists` (`db-update-gsis.ts:234`) or `waitUntilIndexActive` (`:235`, 900s default at `:158`), so a `[ok, throw]` script hangs past the 60s timeout | ACCEPT. A half-applied fix, and the second half was the expensive one. The stub contract now covers what `ensureGsis` does AFTER the send. |
| 5 | Case 13 requires a predicate the plan keeps unexported, while the poll one bullet earlier got an explicit export | ACCEPT. Exported. |
| 6 | Round 1's accept answered the return VALUE and dropped the SIGNATURE - under `strict` the hook-true branch forces `TOut \| undefined`, breaking `dynamoAdmin.ts:128-130`'s destructure, and the cast that fixes it makes the CONSTRAINT unenforceable | ACCEPT, and the remedy is better than a comment: TWO functions, `sendWithRetry<TOut>` (no hook) and `sendWithRetryVerified` (void, hook required), so the constraint is a type rather than a rule someone has to remember. |
| 7 | Cases 8 and 10 name no command, and case 10's "no hook call on the final attempt" is VACUOUS unless the send has a hook - only `UpdateTimeToLive` and `ensureGsis`'s `UpdateTable` do | ACCEPT. Both cases now name their command; case 10 asserts 3 hook calls across 4 attempts. |
| 12 | Which of the five retried sends carry a hook is never tabulated - and a hook on `CreateTable` would return `'created'` where today it returns `'exists'`, while still passing cases 2 and 3 | ACCEPT. Tabulated. A silent wrong answer that survives the acceptance suite is the thing this suite exists to prevent. |
| 13 | The retry backoff is not injectable while the poll is - ~4-5s of real `setTimeout` in a suite specified "no container, no network" | ACCEPT. Injectable. |

## Accepted - S2, S3, measurement

| # | finding | verdict |
|---|---|---|
| 4 | S3.3's shipped SKIP string names a slug S7.2 does not create until after the gates - the one real hole in docs-after-gates, and patching it in S7 would put an UNGATED `.ts` edit on the branch tip, falsifying that decision's own safety argument | ACCEPT. The built-dashboard issue is filed in S3, where it belongs: it depends on no measurement, only on this slice's design. S7.2's other issue still waits for S5's probe, because that one does depend on evidence. |
| 10 | S2.1 instruments `isCatchDeclared` vs `isErrorTyped`, but `isCatchDeclared` (`:74-77`) does NO checker work; the three real costs are `:97`, `:106` and `:79-80` - the last including a separate `typeToString` call | ACCEPT. Instrumenting a cost centre that is not one would have produced a confident, useless measurement. |
| 11 | The S3 fixture must be FILE-scoped - the second describe (`:177-215`) also reads `distDir` (`:182`) - but the restructuring note addresses only the first describe | ACCEPT. Another half-applied fix. |
| 14 | `(a)`'s `HousingChoice` assertion becomes a TAUTOLOGY on a self-written fixture | ACCEPT. Replaced with a distinctive fixture marker, as `unitMediaServe.test.ts:174` does. The real string is covered by (b)/(c) against tracked source. This is the fourth tautology found in this document's history; the pattern is now explicit in the watch items. |
| 8 | The S0/S6 pair straddles the `main` SYNC as well as this mission's changes; S6 names only the mission's confound - though the same reasoning moved S4 and pinned S5 | ACCEPT. Naming one confound and not its twin is worse than naming neither, because it reads as a complete list. |
| 9 | S4's LOADED arm still straddles S1 by construction - the exact hazard that moved its solo arm - and the plan does not say so where S7.1's narrow strike is decided | ACCEPT. Unavoidable given what the loaded arm is, so it belongs in the closure text rather than being quietly relied on. |
| 15 | S0/S5 leave `RUN_REGISTRY_DIR` (`testRunRegistry.ts:41`) unnamed, and speak of "the sweep's mode" in the singular when there are TWO sweeps per run with independently evaluated modes | ACCEPT. Both named; both modes recorded. |

## Status

Not terminal, but every finding is mechanical and the reviewer states none
reopens a decision. Round 3 follows to confirm; if it changes no decision
it is terminal and the plan is done. Hard cap 4.
