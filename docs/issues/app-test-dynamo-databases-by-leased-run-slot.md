---
id: app-test-dynamo-databases-by-leased-run-slot
title: App tests should key DynamoDB Local databases by a leased run slot + worker slot, not by test file - bounded AND unshared between concurrent worktrees
type: improvement
severity: med
status: open
area: test-infra
created: 2026-10-01
refs: app/test/setup/dynamoAccessKey.ts, e2e/support/lane.mjs:235, e2e/support/laneLease.mjs, app/test/helpers/testRunRegistry.ts, app/test/helpers/dynamoKeyLedger.ts, app/test/globalTeardown.ts, app/vitest.config.ts, docs/issues/dynamodb-local-slows-after-sustained-concurrent-load.md
---

**Problem.** Two worktrees running `npm test` at the same time hit the SAME
DynamoDB Local databases, and each run roughly doubles. Measured 2026-10-01 on
the new 24-core PC, app workspace, 12 workers each, no other load: both runs
took 94.3s, against ~35-40s for one run alone. That is the normal way this repo
works now - several worktrees and agents overlapping `npm test` and e2e - and
it is the one case the per-file isolation of 2026-08-23 does not cover.

Separately, DynamoDB Local never releases a database: every access key it has
seen keeps a SQLite connection plus four threads (a `SQLiteQueue` worker and
three schedulers waking every second) until the container restarts, and
dropping its tables does not close it. The full analysis and measurements are
in [dynamodb-local-slows-after-sustained-concurrent-load](./dynamodb-local-slows-after-sustained-concurrent-load.md).
Any fix here must keep the database count BOUNDED for that reason.

## How keys work today

- `app/test/setup/dynamoAccessKey.ts` (vitest `setupFiles`) gives each test
  FILE its own key: `fileAccessKeyId(repo-relative path)` = `hcf<djb2 hash>`
  (`e2e/support/lane.mjs:235`). Per-file because DynamoDB Local has ONE
  `queueLock` per database and every message write is a `TransactWriteItems`
  that takes it untimed; one shared database serialised all ~53 integration
  suites (measured 446-509s vs 75-95s).
- The key is the file's PATH, not the worktree, on purpose (2026-08-23): that
  caps the never-released database count at one per DB-backed test file for
  the whole machine (~60 seen on 2026-10-01). The price is that concurrent
  worktrees share those ~60 databases.
- Because of that sharing, `testRunRegistry.ts` tracks live vitest runs
  machine-wide, and `sweepLedgerResidue` (globalTeardown.ts) only deletes
  residue on sight when no other run is live; otherwise it spares young
  tables and lets age prove death. `dynamoKeyLedger.ts` records which keys a
  run actually opened so the sweep can find them.
- The `// hc:dynamo-lane shared` opt-in keeps a suite on the worktree key (for
  the shared `hc-local-` tables globalSetup creates). As of 2026-10-01 NO suite
  carries it - only its definition does.
- Fixed elsewhere the same day: `globalSetupEnsure.test.ts` used to mint two
  random keys per run, the one per-RUN leak (now two fixed keys per worktree).

## Options

| Key scheme | Databases (never released) | Concurrent worktrees share? |
|---|---|---|
| A. per file, machine-wide (today) | ~60, bounded | YES - all ~60 |
| B. per worker slot, machine-wide (`VITEST_POOL_ID`) | maxWorkers (10), bounded | YES - all 10, worse than A |
| C. per worker slot + worktree | 10 x every worktree ever run since restart - UNBOUNDED | no |
| D. per worker slot + LEASED run slot | 10 x K slots, bounded | no |

C was the first proposal (2026-10-01) and is wrong for this repo: worktrees are
created per feature, so it trades a per-run leak for a per-worktree one - the
very growth the 2026-08-23 machine-wide decision was made to stop.

## Recommended: D

A run leases one of K machine-global run slots at globalSetup and releases it
at teardown, using the arbitration `e2e/support/laneLease.mjs` already does for
e2e port lanes (machine-global dir under os.tmpdir(), pid liveness, mtime
backstop - its two-phase reserve/claim shape exists because e2e resolves lanes
in a short-lived child, which globalSetup does not, so the simpler one-phase
form may do). Each test file then takes key `hcr<slot>w<VITEST_POOL_ID>`.

Why it keeps today's isolation: in the forks pool a worker runs ONE file at a
time, so a worker-slot database is never shared WITHIN a run - the same lock
isolation per-file keys give. And no two live runs hold the same run slot, so
nothing is shared ACROSS runs either.

What it simplifies: under an exclusive lease, every residue table under a slot
belongs to a dead run, so the sweep can delete on sight again and the
"spare young tables while a neighbour is live" logic exists only for keys
that are still shared. The registry's job collapses into the lease.

Count: K = 4 slots x maxWorkers 10 = 40 databases at most, against ~60 today.
What a fifth concurrent run does - wait for a slot, or fail loudly naming
the holders - is a design choice to make; check how laneLease handles a
full set of lanes and match it.

## Must check before building

- Which per-file suites rely on an EMPTY database or fixed table names. A
  worker-slot database is reused by the next file in that worker, so anything
  that assumed "my key has never been used" (the old globalSetupEnsure shape)
  breaks. Most suites mint `hc-test-<uuid>-` prefixes and are unaffected.
- `VITEST_POOL_ID` semantics under vitest 3 forks + `isolate: true`: confirm
  it is the stable slot number 1..maxWorkers and is visible to `setupFiles`.
  `dynamoAccessKeyGuard.test.ts` pins today's per-file decision and needs a
  matching guard.
- Raising or lowering maxWorkers changes the database count; key by slot
  modulo a fixed ceiling if that should not happen.
- The ledger sweep and the lease have to agree on what a dead run left behind.

## Verify with numbers

1. Two worktrees, `npm test` at once: each should take about what one alone
   takes (baseline 94.3s each vs ~35-40s alone).
2. Database count flat after many runs from several worktrees.
3. The single-run time unchanged (10 workers: 38.2s / 40.2s on a fresh
   container, 2026-10-01).
4. Re-run the heavy mix that produced the unexplained 80.8s state in the
   sibling issue, with the container sampled, to see whether it still happens.
