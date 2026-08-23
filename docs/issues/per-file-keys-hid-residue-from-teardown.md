---
id: per-file-keys-hid-residue-from-teardown
title: Per-file DynamoDB keys put leaked throwaway tables where globalTeardown could not reach them
type: bug
severity: med
status: resolved
area: app/test-infra
created: 2026-08-23
resolved: 2026-08-23
refs: app/test/globalTeardown.ts, app/test/globalSetup.ts, app/test/helpers/dynamoKeyLedger.ts, app/src/lib/dynamo.ts, app/test/setup/dynamoAccessKey.ts
---

**A gap that fell between two branches, and neither could see alone.** Both
merged to `main` on 2026-08-21/23:

- `fix/test-suite-hardening` taught `globalTeardown` to sweep the throwaway
  table families the `hc-local-` manifest cannot see (`hc-test-<uuid>-`,
  `hc-hist-<uuid>-`, `hc-local-<lane>-`). That sweep runs under ONE key.
- `fix/dynamo-per-file-keys` moved the DynamoDB Local access key from
  per-WORKTREE to per-test-FILE, to break up the single `queueLock` that all 53
  integration suites were serialising through.

Each is correct. Together, the sweep looks in one database while the tables land
in ~53 others.

**Measured, not inferred (2026-08-23).** A temporary suite created
`hc-test-leakprobe-contacts` and deliberately skipped its own drop, standing in
for a suite that dies before `afterAll`. The run was CLEAN and GREEN - no
interruption needed:

```
[leakProbe] AWS_ACCESS_KEY_ID=hcf1cv6a7t      <- per-file key
[globalTeardown] dropped hc-local- tables (key=hctest1uwde9...): 23
                                              ^ worktree key, swept 0 residue

hcf1cv6a7t    1 table(s)  app/test/zzleakprobe.test.ts
    1 throwaway | e.g. hc-test-leakprobe-contacts     <- still there
```

So the earlier framing ("only an interrupted run leaks") was too generous. Any
suite whose cleanup does not run - a crash, a timeout, an assertion that throws
past the drop - leaked permanently, and the throwaway prefixes carry a fresh
uuid per RUN, so each occurrence added a new set rather than reusing the last.

Milder than the pre-per-file-key world, where 116 tables in ONE database took
the suite from 65s/0 failures to 607s/9 failures. Residue is now spread thin
across many databases, so it no longer starves a lock. But it stopped
self-healing, and DynamoDB Local can neither enumerate nor drop a database.

**Why the obvious fix was wrong.** "Walk every per-file key at teardown" is the
first thing that comes to mind and it is a trap. Measured against the shared
container:

```
ListTables x400 under FRESH keys        1590ms, container RSS +235 MiB
ListTables x400 more under FRESH keys   1575ms, container RSS +456 MiB
ListTables x400 under those SAME keys    925ms, container RSS +1 MiB
```

A `ListTables` under a key nobody has used MATERIALISES that database, at
roughly 0.6-1.1 MiB that `-inMemory` reclaims only when the container stops. A
worktree has ~327 test files and only ~53 touch DynamoDB, so a blind walk would
permanently allocate ~200 MiB per worktree looking for tables that cannot exist
- re-creating the unbounded growth the per-file keys were introduced to bound.

**Resolution (2026-08-23, `fix/test-hardening-wave2`). Record, do not guess.**

- `app/src/lib/dynamo.ts` writes a zero-byte marker named after the access key
  the first time this process builds a client against a local endpoint. One
  filesystem write per (process, key), gated on `HC_TEST_DYNAMO_KEY_LEDGER`,
  which only `app/vitest.config.ts` sets. It is skipped entirely when there is
  no endpoint override, so every deployed path is structurally unaffected.
- `sweepLedgerResidue` visits exactly those databases. They are already
  materialised, so the sweep costs nothing extra.
- Markers are pruned as they are swept, so the ledger stays bounded and a
  renamed or deleted test file cannot make a future run re-materialise its
  database. A marker survives its run only when that run was interrupted.
- The sweep runs in `globalSetup` as well as `globalTeardown`. That is the half
  that matters: a hard kill never reaches teardown, and residue only harms the
  run that shares a container with it, so cleaning on the way IN bounds the
  damage to a single run.

Both halves mutation-probed. Stubbing the recorder gives
`expected [] to include 'hcledgerrecordprobe'`; stubbing the sweep's key list
gives `expected +0 to be 1`. Restored, `app/test/dynamoKeyLedger.test.ts` is
5/5 green, and the leak-probe table no longer survives its run.

**Still not fixed, and probably unfixable here:** the databases of DELETED
worktrees and abandoned lanes. A deleted worktree takes its ledger with it, and
DynamoDB Local offers no way to enumerate a database. Those are still reclaimed
only by an operator stopping the container.

Related: [`npm-test-dynamodb-local-contention`](./npm-test-dynamodb-local-contention.md),
[`dynamodb-local-cross-worktree-test-contention`](./dynamodb-local-cross-worktree-test-contention.md)
