---
id: npm-test-dynamodb-local-contention
title: npm test is not reliably green - four integration suites fail nondeterministically under shared DynamoDB Local contention
type: bug
severity: med
status: open
area: app/test-infra
created: 2026-08-05
updated: 2026-08-21
refs: app/test/groupCrossCheck.test.ts, app/test/unreadIndexRepo.integration.test.ts:561, app/test/seedProfile.integration.test.ts:122, app/test/seedLive.test.ts, app/src/lib/dynamoAdmin.ts:153, app/scripts/db-update-gsis.ts:152, app/vitest.config.ts:16
---

<!--
  MERGED 2026-08-21. Four separately filed issues, one root cause and one cost.
  Superseded slugs (do not re-file; they are these suites):
    npm-test-red-on-main-dynamodb-local-contention  (med, 2026-08-19 - the umbrella)
    group-cross-check-integration-nondeterminism    (med, 2026-08-18 - suite A)
    db-update-gsis-integration-flake-under-load     (low, 2026-08-16 - suite B)
    seed-profile-integration-timeout-flake          (med, 2026-08-05 - suite C)
  Renamed from `npm-test-red-on-main-...`: the "red on main" claim was corrected
  on 2026-08-20 - main FLAKES, it is not deterministically red.
-->

**Problem.** `npm test` - one of the three required completion gates - is not
reliably green, on `main` or on any branch. Four integration suites fail
nondeterministically, all of them DynamoDB Local suites, all of them green when
run alone. The failing CASES vary run to run while the failing FILES stay stable:
the signature of shared-resource contention, not a code defect.

**Corrected 2026-08-20:** an earlier framing said `npm test` was RED on main. It
is not deterministic. Main flakes. That distinction matters because a
deterministic red can be waited out, while a flake means every gate result on
every branch has to be adjudicated by hand.

**Baseline 2026-08-21** (`fix/e2e-harness-determinism` @ `e0fb96e1`, before any
edit on that branch, otherwise-idle box):

```
app        1 failed | 317 passed | 1 skipped (319 files) - 5654 tests passed
dashboard  168 passed (2524 tests)
e2e        17 passed (469 tests)
fake-twilio 33 passed (225 tests)
scripts    13 passed (109 tests)
```

The single failure was suite A below. That run is the reference point for this
issue: **only A currently reproduces.**

**Two of the four suites are already remediated** - verified in the same
worktree, and the reason this issue shrank rather than grew:

- **C (`seedProfile`) is FIXED.** The record said it crossed
  `testTimeout: 15_000` at `app/vitest.config.ts:16`. That config now reads
  `testTimeout: 60_000` (line 27), and the named test carries its own
  `240_000` budget at `seedProfile.integration.test.ts:138`.
- **D (`seedLive`) is FIXED.** Both heavy cases carry `120_000` budgets.

They are kept described below because the evidence is still the best record of
the failure class, not because they are open work.

**Why it matters.** While this holds, "green" means nothing on its own. Every
branch has to compare its failure set against a base-commit run before the gate
can be read - slow, and exactly the condition under which a real regression gets
waved through as "the known flake".

## The four suites

**A. `app/test/groupCrossCheck.test.ts`** - sweeps return `[]` where a row is
expected (`expected [] to have a length of 1`). The failing test differs run to
run. Observed 2026-08-18 during the contact-create-relay-group gates, with a
second full battery running concurrently against the same container:

- full run 1: "RAPID SAME-AUTHOR messages match one-for-one, in order" failed (file 67.6s)
- paired isolation run: "a DUPLICATE redelivery of the same IM SID is deduped" failed
- solo isolation run: 26/26 GREEN, exit 0 (16.6s)
- full run 2: "ONE lost filing reconciles ONE row - a later row outside its window still alarms" failed (file 64.2s)

The file's duration roughly QUADRUPLES under contention (16.6s solo vs ~65s
loaded), which is consistent with latency-dependent assertions rather than a
logic fault.

**B. `app/test/unreadIndexRepo.integration.test.ts`** - the two `db:update-gsis`
cases ("adds the missing GSI in place, ACTIVE, without dropping the table" and
"a SECOND run reports nothing to do") fail with:

```
InternalFailure: The request processing has failed because of an unknown error,
exception or failure.
```

out of the `UpdateTableCommand` in `app/src/lib/dynamoAdmin.ts:153`. A variant of
the same run has surfaced as `UnrecognizedClientException: The security token
included in the request is invalid`. The same suite's byUnread round-trip,
tie-boundary resume and backfill cases pass in the same run; the file alone is
17/17 green immediately afterwards. Observed on `feat/inbox-unread-index`
@f1a2a9b6 alongside `performanceSeed.integration.test.ts` hammering the same
container with multi-minute seeds. This `UpdateTableCommand` failure is already
known operationally - the standing workaround is to restart the DynamoDB Local
container - which points at container state, not test logic.

**C. `app/test/seedProfile.integration.test.ts:122`** ("full superset-of lean:
full profile count is >= lean count") - `Test timed out in 15000ms` inside the
full suite, passing solo in ~8s. It runs a SECOND complete `seedAll(..., 'full')`
against DynamoDB Local, so under worker-level parallelism it crosses the global
`testTimeout: 15_000` (`app/vitest.config.ts:16`). ENVIRONMENTAL, proven: 3/3 on
the contact-rosters S6b tree AND 1/1 on the same tree with every change stashed
(`feat/contact-rosters` @b84117e9, the untouched base). DynamoDB Local was not
clogged with leftover tables at the time (`list-tables` empty), so the cause is
wall-clock contention, not accumulated schema.

**D. `app/test/seedLive.test.ts`** - same class as C, timed out in one of those
four runs.

Measured on an otherwise quiet worktree during the comms-panel call-direction
mission (2026-08-18/19):

| Run | Commit | Exit | Failing files |
|---|---|---|---|
| full `npm test` | `08ec365c` (main's base, DETACHED) | 1 | A + B, 5 tests |
| full `npm test` | feature branch | 1 | A + B, 5 tests |
| full `npm test` | feature branch, post-merge | 1 | A + B |
| those two FILES alone | `08ec365c` | 0 | none (49 passed) |
| those two FILES alone | feature branch | 0 | none (49 passed) |

The failure set has been observed to GROW between two consecutive runs and to
shrink to one file on another - the same signal.

## Lineage

Two ancestors are RESOLVED and their fixes hold; this issue is what remains after
both:

- [`dynamodb-local-cross-worktree-test-contention`](./dynamodb-local-cross-worktree-test-contention.md)
  - the `-sharedDb` single-writer lock. Hurt only under CONCURRENT runs.
- [`dynamodb-local-tables-never-reclaimed`](./dynamodb-local-tables-never-reclaimed.md)
  - table accumulation degrading a long-lived container. Fixed structurally by
  `93ca271b fix(test-infra): reclaim DynamoDB Local tables instead of leaking a
  database per run`. Suite B was expected to be cured by that; re-check whether
  it still recurs post-93ca271b before designing anything for it.

**Suggested fix.** C and D are done (per-test budgets, above). What remains:

1. **A** - the most persistent suite, and the evidence now points at the TESTS,
   not only the container. Make the ordering/window assertions robust to
   latency: explicit waits on state rather than call-order spies, or widened
   windows.

   **A FAILS ALONE, sometimes** (new, 2026-08-21). The framing above - and the
   repo's standing adjudication recipe - assume these files "pass when run in
   isolation". For suite A that is not reliably true. Four consecutive
   observations on `fix/e2e-harness-determinism` @`1a9811d9`:

   | run | result | failing case |
   |---|---|---|
   | baseline full suite (pre-edit) | FAIL | `matching, in both delivery orders > a filing for a DIFFERENT author does not clear this author event` |
   | post-merge full suite | FAIL | `the grace deadline and the alarm > a would-be alarm whose classic filing DID land is reconciled QUIETLY, not alarmed` |
   | file ALONE | FAIL (1 of 26) | - |
   | file ALONE, immediately after | PASS (26/26) | - |

   So the failing CASE varies run to run (as recorded), but isolation is not a
   reliable green either. A purely container-contention story cannot explain a
   solo failure on an otherwise-idle box, which means suite A carries genuine
   latency-dependent assertions - the spy-order and window predicates remedy 1
   already suspects. Treat remedy 1 as the primary fix for A, not a fallback.

   **Consequence for gate adjudication:** for THIS file, "re-run it alone" can
   produce either colour and proves less than the recipe implies. Compare the
   failing FILE against a base run - that is what still holds - and re-run alone
   more than once before drawing a conclusion.

   ### Investigation 2026-08-21 (`fix/test-suite-hardening`) - read this before
   ### re-investigating, it rules out three things

   **Fixed, but NOT the cause.** The file shares ONE table and ONE deadline
   partition across all 26 tests; `harness()` gives each a unique rail and
   `sweep()` filters only the RESULT, while `sweepCrossCheckDeadlines` is global
   and reads `listDueRows(..., SWEEP_BATCH)` with `SWEEP_BATCH = 50`. Leftover
   pending rows therefore accumulate and a later test's sweep can spend its
   batch on other tests' rows. Real hazard, now closed by an `afterEach` drain.
   Measured effect: **4 pass / 1 fail of 5 WITH the drain, 3 pass / 2 fail of 5
   WITHOUT.** At n=5 that is noise - the leak was real but is not what is
   failing.

   **The surviving failure, reproduced and instrumented.** `a DUPLICATE
   redelivery of the same IM SID is deduped` fails **1 in 10 runs with that test
   as the ONLY test running, on a clean table.** Instrumenting
   `claimCrossCheckEvent` caught it in the act:

   ```
   [probe] claimCrossCheckEvent sid=IMCH0000000001c9cb203850a242cfaaa60b1 -> fresh=true
   [probe] claimCrossCheckEvent sid=IMCH0000000001c9cb203850a242cfaaa60b1 -> fresh=true
   ```

   Byte-identical SID, both claims fresh. That should be impossible:
   `groupCrossCheckMarkerPk` is `groupim#<sid>` (deterministic, no timestamp)
   and the write is a `PutCommand` with
   `ConditionExpression: attribute_not_exists(conversationId)` catching
   `ConditionalCheckFailedException`.

   **Three probes, all CLEAN - do not repeat them:**

   | probe | rounds | double-fresh |
   |---|---|---|
   | `claimCrossCheckEvent` twice, one warm table | 300 | 0 |
   | `claimCrossCheckEvent` twice, FRESH table per round | 30 | 0 |
   | full `recordConversationEvent` twice via the real service, as the test does | 40 | 0 |

   **ROOT CAUSE FOUND - a TTL time bomb, not contention at all.** The three
   probes were clean because every one of them wrote a FUTURE `expires_at`
   (`Date.now() + 3600`). The test does not.

   - `expires_at` is a REAL TTL: `ensureTable` turns it on
     (`dynamoAdmin.enableTtlIfNeeded`) and DynamoDB Local really does reap.
   - The service derives it from the INJECTED clock:
     `cleanupAt(from) = (from + cleanupMs) / 1000`.
   - The file pins `T0 = 2026-08-11` and the default window is 7 days
     (`GROUP_CROSSCHECK_CLEANUP_MS`), so every marker it writes carries
     `expires_at = 2026-08-18`.

   **From 2026-08-18 onward every marker is born already expired.** The reaper
   deletes it at some unpredictable point mid-test, so a second claim of the
   same `messageSid` finds nothing and reports itself FRESH - precisely what
   "a DUPLICATE redelivery ... is deduped" asserts against.

   That is a TIME BOMB, not a race. This file was fine until 2026-08-18 and
   started rotting on its own, which matches when the reports began (the first
   entry in this issue's own evidence is 2026-08-18). It also explains the
   otherwise-impossible instrumented result of two identical claims both
   returning fresh, and why it reproduced with the file running ALONE.

   **Fix:** inject `cleanupMs` (an existing, previously unused dep seam) so the
   markers outlive any run. Measured:

   | | that test alone | whole file |
   |---|---|---|
   | before | 9 pass / 1 fail of 10 | 3 pass / 2 fail of 5 |
   | after the drain only | - | 4 pass / 1 fail of 5 |
   | after drain + TTL fix | **12 / 12** | **8 / 8** |

   ### The same fuse is armed elsewhere, dated

   Any integration test that pins a PAST clock and writes a TTL-bearing row has
   this bug, and it fails on a schedule rather than under load. TTL-bearing
   tables: `messages`, `matches`, `unmatched_email`, and the ai-runs table.

   **`app/test/aiRunsRepo.integration.test.ts` is the next one to go off.** It
   pins `startedAt: '2026-08-06T10:00:00.000Z'` and `RUN_TTL_DAYS = 90`, so its
   rows carry `expires_at = 2026-11-04`. It is fine today and will begin flaking
   **on or after 2026-11-04** with the same signature. Fix it before then, or
   better, stop enabling TTL on integration-test tables at all - the reaper is
   pure hazard there, and no test asserts reaping behaviour (the ai-runs suite
   asserts the ATTRIBUTE VALUE, which does not need TTL enabled).

   `app/test/groupReceipts.test.ts` and `app/test/mediaMirrorJob.test.ts` also
   pin 2026 clocks but run entirely in memory, so they have no reaper and are
   safe.
2. **B** - `93ca271b` did NOT cure it. It stayed green on the 2026-08-21
   baseline but reproduced later the same day on `fix/e2e-harness-determinism`
   @`8b3dcfe2`, immediately after an 18-minute `npm run e2e` had hammered the
   shared container (which had also been up 25+ hours - both documented
   degradation conditions at once):

   ```
   FAIL test/unreadIndexRepo.integration.test.ts > db:update-gsis ... > adds the missing GSI in place
     InternalFailure: The request processing has failed because of an unknown error
     at ensureGsis scripts/db-update-gsis.ts:152
   FAIL ... > a SECOND run reports nothing to do (idempotent)
     Test timed out in 60000ms
   ```

   The second failure is a CASCADE of the first, not an independent one: the
   failed `UpdateTable` leaves the table mid-update, so the idempotency case
   waits out its whole budget. Re-run of that file ALONE immediately after:
   23/23 green in 1.089s - against a 60s timeout in the suite.

   Remedy unchanged: serialize the schema-mutating lane away from the other
   integration suites, or retry `UpdateTable` on `InternalFailure`. The retry is
   the cheaper of the two and this evidence argues for it - `InternalFailure` is
   DynamoDB Local buckling under concurrent load, not a real API error.

   **Note for whoever picks this up:** the failing FILE varies between runs. The
   2026-08-21 baseline failed A and not B; the run above failed B and not A.
   That is the whole reason this issue is one umbrella rather than per-suite
   tickets, and the reason gate adjudication compares FILES against a base run
   rather than expecting a fixed set.
3. **Structural, if 1-2 are not enough** - establish whether these suites can
   share a DynamoDB Local container with the rest of the suite at all. Give them
   a throwaway table prefix per run (some of this already exists) and confirm no
   cross-suite table reuse remains; or serialize them; or pin the container
   version and raise its resource limits.

**Handling rule until then.** Re-run the failing FILES alone, and run the full
suite at the branch's base commit, then compare failing FILES rather than failing
cases. Report both runs. Treat this like the flakes named in `AGENTS.md`.

Related: [`unread-index-integration-coverage-requires-local-dynamo`](./unread-index-integration-coverage-requires-local-dynamo.md)
(a green `npm test` does not prove byUnread index semantics - that suite
self-skips without DynamoDB Local, which is the other half of "the gate does not
mean what it looks like").
