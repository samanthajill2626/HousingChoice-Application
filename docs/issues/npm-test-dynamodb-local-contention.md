---
id: npm-test-dynamodb-local-contention
title: npm test is not reliably green - four integration suites fail nondeterministically under shared DynamoDB Local contention
type: bug
severity: med
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

---

## The reopened cause: RESOLVED 2026-08-23 (`fix/dynamo-per-file-keys`)

Each Vitest test FILE now gets its own DynamoDB Local database, and therefore
its own locks, via a `setupFiles` hook. No shared write lock is left for the
integration lane to queue on.

### The mechanism, read out of the jar rather than inferred

Every previous entry in this issue reasoned about "the SQLite write lock" from
timings. That was the wrong level of detail to stop at, and it is why the same
symptom got three different explanations. `DynamoDBLocal.jar` was disassembled
instead (`docker cp` + `javap -c`), and the answer is specific:

- `SQLiteDBAccess` carries **two** locks, and both are `private final` INSTANCE
  fields:
  - `rowLockTable : ConcurrentMap<String tableName, ReentrantReadWriteLock>`
  - `queueLock : ReentrantReadWriteLock` - **one per database**
- `LocalDynamoDBRequestHandler` holds
  `Map<String dbName, AmazonDynamoDBLocal> dbRequestHandlers` and
  `getHandler()` builds exactly ONE `SQLiteDBAccess` per database. With
  `-sharedDb` OFF (ours is off) the map key is the credential-derived database
  name; with it ON every caller collapses onto the literal
  `"shared-local-instance"`.
- `beginTransaction()` does `queueLock.writeLock().lock()` - **untimed** - and
  holds it until `commitTransaction()` / `rollbackTransaction()`, both of which
  assert `isWriteLockedByCurrentThread()` before unlocking. Nearly every other
  data-plane method also takes `queueLock`.
- Control-plane and data-plane ops take `getLockForTable(t).writeLock()
  .tryLock(LOCK_WAIT_TIMEOUT_IN_SECONDS, SECONDS)` with
  `LOCK_WAIT_TIMEOUT_IN_SECONDS = 10`, and on failure throw
  `INTERNAL_SERVER_ERROR` / `TIME_OUT_WHILE_ACQUIRING_LOCK` - which IS the
  reported string, verbatim, from `LocalDBClientExceptionMessage`.

So the chain is: a transaction takes the per-DATABASE `queueLock` and holds it;
anything else that needs `queueLock` blocks while still holding its own
per-TABLE lock; work queued behind that table lock blows its 10s budget and
surfaces as `InternalServerError`.

**Because both locks are instance fields of a per-database object, the lock is
per DATABASE, not per container.** That is the premise the fix rests on, and it
is settled by construction rather than by a timing argument.

### Two things the record above had wrong

1. **`app/src/repos/messagesRepo.ts` writes EVERY message through a 2-3 item
   `TransactWriteItems`.** That is why the suites that failed together on
   2026-08-21 were the message-heavy ones. Transactions were never named as the
   contended path in this issue; they are the whole of it.
2. **The `hc-test-<uuid>-` prefixes were never isolating suites from each other
   on this axis.** They give each suite distinct `rowLockTable` ENTRIES, which
   are keyed by table name. They do nothing about `queueLock`, which every table
   in the database shares. This matters for the fix design: per-file keys help
   all 53 suites, not just the handful that read `hc-local-`.

### The fix

`app/test/setup/dynamoAccessKey.ts`, wired as `setupFiles` in
`app/vitest.config.ts`. Setup runs once per test FILE, before the file is
imported and therefore before it constructs any client - the SDK resolves
credentials at client CONSTRUCTION, so that is the last moment that can still
choose the database.

- The key is `fileAccessKeyId(testFileId)` from `e2e/support/lane.mjs`:
  `hcf<djb2(worktreeIdentity + '|' + repoRelativePath)>` in base36. Worktree
  identity is folded in so two worktrees running the same file still separate.
- **Deterministic, never random.** DynamoDB Local can neither enumerate nor drop
  a database, so a per-RUN key would strand one database per run forever - the
  documented degradation in
  [`dynamodb-local-cross-worktree-test-contention`](./dynamodb-local-cross-worktree-test-contention.md).
  Hashing a stable file id bounds it at one database per file.
- **The opt-in is in the suites, not in a list here.** A suite that reads the
  shared `hc-local-` tables (which `globalSetup` bootstraps once, under the
  worktree key) carries the marker `hc:dynamo-lane shared` in its own header and
  keeps the worktree key. An opt-OUT list inside the hook would rot the moment
  someone adds suite 54. Only TWO files need it - `devOutbox.integration` and
  `recordingMessaging.integration` - which is far fewer than this issue assumed;
  every other suite already mints its own throwaway prefix.
  `app/test/setup/dynamoAccessKeyGuard.test.ts` asserts the property directly,
  so a new `hc-local-` suite fails there with an explanation instead of failing
  later as a `ResourceNotFoundException` somewhere unrelated.
- An explicitly exported `AWS_ACCESS_KEY_ID` still wins and puts every file back
  on one key. That is a supported override, and it is how the OLD regime was
  measured below.
- `DYNAMO_DISABLE_TTL=1` and the fail-loud reachability check in `globalSetup`
  are untouched.

### Evidence

**Premise, measured** - identical total work, one database vs many, on the live
container (throwaway probes, since deleted):

| workload | 1 database | N databases |
|---|---|---|
| DDL churn, 16 workers x 23 tables x 4 rounds | 28.6s | 15.3s (16 dbs) |
| `TransactWriteItems`, 10 workers x 300 | 3.5s (848 tx/s) | 1.8s (1657 tx/s) |
| 16 tx + 48 put writers, 40s | 181 tx + 528 puts = **709 ops** | 108 tx + 11,810 puts = **11,918 ops** (64 dbs) |

Split beat shared at every concurrency level tried (1, 2, 4, 8, 16 workers).

**The fix, measured.** A load rig hammers the worktree key (8 transaction +
8 put writers, ~4,500-5,000 transactions and ~5,000 puts per arm) while
`npm test -w app` runs. OLD exports `AWS_ACCESS_KEY_ID` so every test file lands
on that same key - exactly the pre-change regime, through the supported
explicit-key path. NEW is per-file. Same load, same suite, one variable, 3 runs
each:

| arm | run | result | duration | aggregate test time |
|---|---|---|---|---|
| OLD | 1 | **FAIL** - 4 tests in 2 files | 509.0s | 2076s |
| OLD | 2 | pass | 445.6s | 2643s |
| OLD | 3 | pass | 452.5s | 2083s |
| NEW | 1 | pass | 79.8s | 329s |
| NEW | 2 | pass | 74.9s | 271s |
| NEW | 3 | pass | 95.5s | 349s |

Every run covered the same work: 324 files, 5712 tests. (OLD skips 9 rather than
7 because the new guard correctly stands down its two per-file assertions when
an explicit key has overridden the scheme.)

**Read the duration column, not the pass/fail column.** OLD failed only 1 run in
3, which is this issue in miniature - the fault is intermittent and a green OLD
run proves nothing. The wall clock is the deterministic signal: **446-509s
loaded on one database versus 75-95s on per-file databases, a ~5x difference**,
and aggregate in-test time drops ~7x (2076-2643s to 271-349s). The suites were
spending most of their time blocked, not working.

The single OLD failure was `unreadIndexRepo.integration`, both `db:update-gsis`
cases - **suite B of this issue, reproducing under a load rig instead of by
luck**. That is the first time it has been made to happen on purpose.

**Unloaded, the change is still a win, not a tax** (`npm test -w app` alone, from
the baseline runs): 115.9s / 117.6s before, 91.6s after.

**Baseline before any edit** (this worktree, unloaded): 3 full `npm test` runs,
all green - app 322 passed / 1 skipped, dashboard 168, e2e 19, fake-twilio 33,
scripts 13. The failure this issue is about does not reproduce on an idle box,
which is exactly why the load rig was needed to test the fix at all.

### What is NOT fixed, and what would reopen this

- **The exact error string was never reproduced synthetically.** Four probe
  shapes got individual operations to ~5s of lock wait against the 10s budget
  without crossing it. The bytecode settles the scoping question the fix depends
  on; it does not make the timeout summonable on demand. The suite-level A/B
  above is the reproduction that matters, and it does not produce that string
  either - it produces the `db:update-gsis` `InternalFailure` of suite B.
  So the specific 4-file `waiting for a lock` run of 2026-08-21 has NOT been
  reproduced and cannot be shown directly cured. What is shown is that the
  resource those four files were contending on no longer exists for 51 of the
  53 suites.
- **Two suites still share the worktree database** by design (the marked ones).
  Two files contending is not 53, but it is not zero. If they ever flake
  together, the next step is to give them per-file keys too and have the setup
  hook `ensureKeyedLocalTables()` into each - measured at ~200ms per file, and
  it would let `globalSetup`'s shared bootstrap go away entirely.
- **One database per test file is a new resource shape - measured, and it is
  affordable.** `getHandler()` builds a `JobsRegister` with
  `Executors.newFixedThreadPool(10)` per database, and nothing ever evicts a
  database, so ~50 per worktree is a real step up from 1. Container memory over
  3 consecutive `npm test -w app` runs from a FRESH container:

  | regime | fresh | run 1 | run 2 | run 3 |
  |---|---|---|---|---|
  | per-file keys | 215 MiB | 760 MiB | 930 MiB | 957 MiB |
  | one shared key | 229 MiB | 660 MiB | 704 MiB | 745 MiB |

  Steady-state cost is about **+210 MiB**, and the per-file arm is levelling off
  (+545, +170, +27). All six runs exited 0.

  This was measured because the container **was** OOM-killed once during this
  work (`OOMKilled: true`, exit 137), which failed the `npm test` gate through
  `globalSetup`'s reachability check - working exactly as intended. Chasing that
  produced three numbers worth keeping, because they contradict the intuition
  that dropping tables bounds memory:

  1. **An empty database costs ~1.1 MiB.** 300 databases created by a bare
     `ListTables` under 300 fresh keys: 235 -> 327 -> 449 -> 568 MiB. So the ~50
     databases this change introduces cost about **55 MiB**. Database COUNT is
     not what fills a VM, and bucketing files into fewer databases would buy
     nothing worth the loss of isolation.
  2. **`DeleteTable` returns almost nothing to the OS.** Writing 300 MB into one
     table took RSS 606 -> 1091 MiB; dropping that table gave back **4 MiB**.
     Our teardowns are correct and leave zero tables behind (verified), but they
     do not reclaim memory - only the table LIST, which is what
     [`dynamodb-local-tables-never-reclaimed`](./dynamodb-local-tables-never-reclaimed.md)
     was really about.
  3. **RSS is a high-water mark, and it PLATEAUS.** Four write-300MB-then-drop
     cycles: 1101 -> 1491 -> 1762 -> 1880 -> 1883 MiB, i.e. +390, +271, +118,
     **+3**. The memory is reused by later writes even though it is never
     handed back. So a long-lived container converges on peak CONCURRENT data
     plus ~1.1 MiB per key ever seen; it does not climb without bound.

  **What that does and does not explain.** It rules this change out: 55 MiB
  cannot OOM a 31 GiB VM. It does not fully explain the kill either - the exact
  trigger was never established. The likeliest driver is that this
  investigation's own throwaway probes wrote GIGABYTES through that container
  (one probe alone put ~4,300 items of 380 KB) and created ~150 databases,
  pushing the high-water mark far above anything the test suite produces.

  Standing advice is unchanged and now has numbers behind it: restarting is the
  ONLY reclaim (`npm run db:stop && npm run db:start`), `scripts/db.mjs` already
  warns at `STALE_UPTIME_DAYS = 3`, and the container that died was exactly 3
  days old - the warning fired and nobody acted on it.
- Reopen if a full `npm test` fails a DynamoDB suite that mints its own
  throwaway prefix, on an otherwise-idle box, twice.

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
