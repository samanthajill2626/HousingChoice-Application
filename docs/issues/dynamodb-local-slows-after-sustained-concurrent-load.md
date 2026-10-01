---
id: dynamodb-local-slows-after-sustained-concurrent-load
title: DynamoDB Local keeps every database it has ever opened alive (4 threads each) until restart - test time creeps with the count, and heavy mixed load made it ~1.7x slower
type: bug
severity: med
status: open
area: test-infra
created: 2026-10-01
refs: scripts/db.mjs, app/test/globalSetupEnsure.test.ts:43, app/test/globalSetupEnsure.test.ts:158, app/test/setup/dynamoAccessKey.ts, app/vitest.config.ts, docs/superpowers/reviews/2026-10-01-search-scroll-prefill/measurements.md
---

**Problem.** After about an hour of heavy mixed test load on 2026-10-01 (new
24-core PC; container started 12:40), every DynamoDB-backed run got slower and
STAYED slower once the load was gone: `npx vitest run --maxWorkers=8` in app/
went from 45.0s / 51.0s to 80.8s, all green. The 70 DB-backed test files took
4.2x longer in total (58.3s -> 243.1s); the 329 pure-unit files did not slow
at all (60.5s -> 55.6s). So it is the container, not the host.

The load: 40-repeat e2e spec runs, a full gate `npm test` + e2e, eight timing
runs, then two full e2e suites from two worktrees at once with three
`npm test` runs and then two concurrent `npm test` runs on top.

**What the data cleanup is NOT.** It works. In the slow state, 102 of the 104
databases held ZERO tables; the only tables left were the two e2e lanes'
schemas (22 each), which every e2e run wipes and reseeds. The JVM heap was
healthy too (326 MB used of 612 MB committed, 2.8s of GC in total, no full
GC) - so the earlier guess in this file, heap pressure at `-Xmx2g`, was WRONG.

**What it IS - part 1, proven: databases are never released.** DynamoDB Local
(no `-sharedDb`) gives every access key its own database, and for each one it
opens a SQLite connection plus FOUR threads that live until the JVM exits: a
`SQLiteQueue` worker and three schedulers (`CreateGSIJobScheduler`,
`DeleteGSIJobScheduler`, `TimeToLiveDeletionJobScheduler`), each waking every
1s (`LocalDBUtils.DELAY_BEFORE_SCHEDULING_JOBS_AGAIN`) to lock that database's
`LocalDBAccess` and query all its tables. Dropping every table leaves all of
that running; there is no API that closes a database. Read out of
DynamoDBLocal.jar with `javap`, and confirmed by `jcmd Thread.print`: 104
databases -> 104 queue threads + 312 scheduler threads.

Where the keys come from:
- one per DB-backed test FILE (~60): `fileAccessKeyId(repo-relative path)`, so
  every worktree shares the same ~60 - bounded;
- one per worktree (`hctest<worktree>`), one per e2e lane (`hclane<L>`), a few
  fixed ledger-probe keys - bounded;
- **an unbounded leak: `globalSetupEnsure.test.ts` mints TWO random keys
  (`hctestfresh<random>`, `hctestdrop<random>`) on every run.** It drops their
  tables, but each run still adds 2 databases / 8 threads for good. Measured
  after a restart: 67 -> 69 -> 71 -> 73 databases over four runs.

**Part 2, measured: the count costs time, but modestly.** Same command
(8 workers), quiet box, after a restart:

| Container state | Databases | Threads | 8-worker run |
|---|---|---|---|
| fresh restart | 67-73 | 383-409 | 45.4s, 45.4s |
| + 40 empty databases opened, no test load | 113-117 | 568-599 | 49.2s, 49.1s |
| + one full e2e suite (305 passed) | 118 | 607-616 | 48.2s, 48.4s |
| + app suite run in BOTH worktrees at once | 131 | 699 | 55.0s |
| the slow state, before the restart | 104 | 558 | 80.8s |

**Part 3, NOT explained: the 80.8s state.** It is far worse than its database
count predicts, and neither one e2e suite nor a dual-worktree app run
reproduced it. Its memory was 1.85 GB RSS against 1.1-1.4 GB in every
reproduction, and the difference is NATIVE memory, not heap. The remaining
untested ingredient is the full mix: two e2e suites at once plus repeated and
concurrent `npm test`.

Also worth knowing: two worktrees running `npm test` at the same time share
the same ~60 per-file databases (the key is the file's path, not the
worktree's), so they contend on the same SQLite locks - each took 94s instead
of ~40s.

**Fixes.**
1. DONE 2026-10-01 (fix/search-scroll-prefill): `globalSetupEnsure.test.ts`
   now uses two FIXED keys derived from the worktree key, empties them first
   with its own helper, and requires them empty. Verified: three runs added 2
   databases on the first and none after; residue planted under both keys is
   cleared and the suite passes.
2. FILED as [app-test-dynamo-databases-by-leased-run-slot](./app-test-dynamo-databases-by-leased-run-slot.md):
   stop concurrent worktrees sharing the per-file databases while keeping the
   count bounded. (The first idea here - worker slot plus WORKTREE - was wrong:
   it makes the count grow with every worktree, undoing the 2026-08-23
   machine-wide decision. The filed design leases a run slot instead.)
3. OPEN, this issue: reproduce the 80.8s state with the full mix while sampling
   `docker stats` and `jcmd 1 VM.native_memory` (needs
   `-XX:NativeMemoryTracking=summary`, which changes the container args and so
   recreates - wipes - it).
