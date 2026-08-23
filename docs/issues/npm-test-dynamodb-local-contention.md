---
id: npm-test-dynamodb-local-contention
title: npm test is not reliably green - four integration suites fail nondeterministically under shared DynamoDB Local contention
type: bug
severity: high
status: open
area: app/test-infra
created: 2026-08-05
updated: 2026-08-21
reopened: 2026-08-21
refs: app/test/groupCrossCheck.test.ts, app/test/unreadIndexRepo.integration.test.ts:561, app/test/seedProfile.integration.test.ts:122, app/test/seedLive.test.ts, app/src/lib/dynamoAdmin.ts, app/scripts/db-update-gsis.ts, app/vitest.config.ts
---

**REOPENED 2026-08-21, same day, by a run that contradicts the close below.**

A full `npm test` failed FOUR files at once - `groupCrossCheck`,
`importApply.integration`, `performanceSeed.integration`, `seedHistory` - with a
signature that appears NOWHERE in this issue's history:

```
InternalServerError: This action timed out because it too long waiting for a lock.
This request will succeed in actual DynamoDB API
```

That is DynamoDB Local's single SQLite WRITE LOCK - not the `InternalFailure` of
suite B, and not the TTL reaper of suite A. The other three failed as plain
timeouts at 60s, 180s and 240s - already-generous budgets, so the lever used last
time (raise the timeout) is exhausted.

**The mechanism is documented in our own vitest config, and I walked into it.**
`app/vitest.config.ts` records that per-key isolation stops THIS worktree
contending with a neighbour, but every integration suite in the worktree shares
that one key - so one database, one write lock - and that going from 23 to 26
suites once produced 4 failed runs out of 4, "a DIFFERENT integration suite each
time... the write lock starving whoever asks last".

There are now **53** such suites, and I added one of them
(`updateCallStatus.integration.test.ts`) during this very campaign, justifying it
as safe because "Phase 1 fixed the contention". That was wrong: Phase 1 fixed the
TTL time bomb and the UpdateTable retry. Neither touches the write lock.

**Not a regression from the branch** - the same four files pass together alone
(108 tests), and an immediate second full run was 322/322 green. But
"intermittent" is what this issue has always been about, so closing it while a
4-file red run is reproducible was premature.

**Remaining scope, and the two candidate fixes:**

1. **Serialize the integration lane.** The config comment already records the
   whole suite going green under `--no-file-parallelism`, at a cost it puts at
   2min -> 5min. Targeted version: split `app/vitest.config.ts` into two
   projects - unit (parallel) and integration (serial) - so only the lock
   contenders pay.
2. **Per-FILE access keys.** DynamoDB Local keys a separate database, and
   therefore a separate write lock, per (accessKeyId, region). Making the key
   per test FILE rather than per worktree removes the shared lock entirely at no
   runtime cost. 50 of the 53 suites already mint their own `hc-test-<uuid>-`
   table prefix and would not notice; the few that read the shared `hc-local-`
   tables (the reseed-based ones) must keep the worktree key.

**CORRECTED 2026-08-23 by adversarial review. The measurement below was taken
on a DEGRADED database and its conclusion does not follow. Read this first.**

Controlled experiment, same commit, same machine, same container - the only
variable is the access key, and therefore which database inside the container
is used:

| database | app suite | wall | test time |
|---|---|---|---|
| worktree key `hctestij3dce` | **9 files failed** | 607s | 5023s |
| brand-new key (empty db) | **322 passed, 0 failed** | **65s** | **305s** |

9.3x wall and the gate flips red to green. Cause, measured directly: that
database held **116 tables** - 50 `hc-test-<uuid>-`, 44 `hc-local-<lane>-`, 22
`hc-hist-<uuid>-`. `app/test/globalTeardown.ts` drops exactly the 23 plain
`hc-local-` tables; the other three prefix families are invisible to it and
survive. A run that COMPLETES cleans up after itself, so the backlog is
historical residue from interrupted runs.

So:

- **The "1990s of 2350s" figure below is an artefact of that residue**, not of
  suite count. On a clean database the ENTIRE app suite is 305s of test time.
- **The ">= 33 minutes" serialization estimate is inflated by roughly the same
  factor**, and "option 1 is no longer viable" is NOT supported.
- **The real root cause is cheaper than either option listed below**: sweep
  the three leaked prefix families at teardown or at `db:start`. That recovers
  the ~9x without a 53-file refactor.

Per-file access keys remain a good idea for genuine lock isolation - the
write-lock timeout IS real and did appear - but they are no longer the only
lever, and the case for them has to be re-argued on clean-database numbers.

**Severity raised med -> high.** `npm test` is a required completion gate that
can be red for purely environmental reasons, and `AGENTS.md`'s known-flake list
does not mention it - so an agent who hits this has no sanctioned re-run and
will either mis-blame their own change or re-run informally. That is exactly
what happened on `fix/test-suite-hardening` ("green on the SECOND run").

**First diagnostic for anyone who hits this:** re-run under a clean key.

```
cd app && AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run
```

If that is green, the failure is database residue, not your change.

---

**SUPERSEDED (kept for the record - the reasoning was sound, the input was not):**

**MEASURED 2026-08-21: option 1 is no longer viable.** The 46 integration
files account for **1990s of the 2350s** total test time in a full app run
(353 files parsed from the run log). Serializing them therefore costs **>= 33
minutes wall**, against ~5 minutes for the whole app workspace today (290s
wall at ~8x effective parallelism).

The config comment's "2min -> 5min" estimate was written when there were 26
suites. At 46 the cheap remedy has been outgrown, and nobody re-measured it -
the number just quietly stopped being true, in the same way the TTL fuse and
the stale issue titles did.

**So option 2 is the only scalable fix.** Per-FILE access keys give each suite
its own DynamoDB Local database and its own write lock at no runtime cost. The
shape of the work:

- a vitest `setupFiles` hook can set `AWS_ACCESS_KEY_ID` per test FILE (setup
  runs once per file), which is the whole mechanism;
- 50 of the 53 suites already mint their own `hc-test-<uuid>-` prefix and would
  not notice;
- the handful that read the SHARED `hc-local-` tables (the reseed-based ones)
  must keep the worktree key, because `globalSetup` bootstraps those tables
  once, under that key. Those files need an explicit, greppable opt-in rather
  than an opt-out list that rots.

That is a self-contained piece of test-infrastructure work with real fallout
risk across 53 files - the same shape as the relay fixture fallout on this
branch, but an order of magnitude wider. It wants its own pass, not the tail
of a long branch.

**RESOLVED 2026-08-21 (`fix/test-suite-hardening`). All four suites.**

| suite | cause | fix |
|---|---|---|
| C `seedProfile` | global timeout too low | already fixed before this work (60s global + 240s per-test) |
| D `seedLive` | same class | already fixed (120s per-test budgets) |
| A `groupCrossCheck` | **a TTL time bomb, not contention** - see below | `cleanupMs` injected, plus `DYNAMO_DISABLE_TTL` for the whole class |
| B `unreadIndexRepo` | DynamoDB Local `InternalFailure` on `UpdateTable` under load, which the AWS SDK's retry policy does not cover | bounded retry in `db-update-gsis.ts` |

**The headline: A was never contention.** `expires_at` is a real TTL that
`ensureTable` enables, and services derive it from their INJECTED clock. The
file pinned `T0 = 2026-08-11` with a 7-day window, so from **2026-08-18** every
dedupe marker it wrote was born already expired, and DynamoDB Local's reaper
deleted it mid-test. A second claim of the same messageSid then found nothing
and reported itself fresh. The suite had been stable for months and started
rotting on a date - which is why it read as load flakiness for three days, and
why the first entry in this issue's own evidence is 2026-08-18.

Evidence, measured rather than assumed:

| | that test alone | whole file | full `npm test` |
|---|---|---|---|
| before | 9 pass / 1 fail of 10 | 3 pass / 2 fail of 5 | 1 failing file |
| after | 12 / 12 | 8 / 8 | **320 passed, 0 failed** |

Then verified under the contention this issue is named for: a full `npm run e2e`
(251 passed) with three concurrent `npm test` runs against the same containers -
**e2e green, and 3/3 unit runs green.**

The category was closed too, not just the instance: `DYNAMO_DISABLE_TTL=1` in
`app/vitest.config.ts` disables the reaper for every vitest run, immunising all
~60 `ensureTable` call sites and every future suite - including
`aiRunsRepo.integration.test.ts`, whose identical fuse was set for 2026-11-04.

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

**Problem.** `npm test` - one of the required completion gates - is not
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
