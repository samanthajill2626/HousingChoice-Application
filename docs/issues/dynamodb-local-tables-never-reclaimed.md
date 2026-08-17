---
id: dynamodb-local-tables-never-reclaimed
title: Nothing ever deleted DynamoDB Local tables, so databases accumulated until an operator restarted the container
type: bug
severity: med
status: resolved
area: app
created: 2026-08-16
resolved: 2026-08-16
refs: app/test/globalTeardown.ts, app/test/globalSetup.ts, app/test/globalSetupEnsure.test.ts, app/scripts/db-create.ts, scripts/e2e-stop.mjs, scripts/db.mjs
---

**Problem.** There was a `globalSetup` with no counterpart teardown, and
`scripts/e2e-stop.mjs` contained no DynamoDB reference at all. Tables were
created once and reused forever. Because DynamoDB Local runs `-inMemory`
WITHOUT `-sharedDb`, it keeps a SEPARATE database per `(accessKeyId, region)`,
so the count grew with every access key that had ever run and was reclaimed
only by stopping the container.

The genuinely UNBOUNDED source was `app/test/globalSetupEnsure.test.ts`: it
mints `hctestfresh${Math.random()}` on EVERY run, creates the full table set
under it, and never cleaned up. The key is random and DynamoDB Local exposes no
way to ENUMERATE databases, so each run stranded a set of tables nobody could
ever name again - per-run growth with no ceiling. The per-worktree vitest key
(`hctest<hash>`) was unbounded across worktrees. Lane keys are capped at
`MAX_LANES = 16` and are reused by whichever worktree takes the lane, so they
are a bounded working set.

**Observed (2026-08-16).** A container up 8 days degraded every suite touching
it: 15 app failures, all on exact timeout boundaries (60012ms / 120012ms /
240057ms), every one green when re-run solo - `BUG 2` went from a 60s timeout to
421ms. After an operator restart the identical commit ran 0 failures / 5067
passed. No code changed between red and green.

**This is NOT the issue it looks like.** The symptom is character-for-character
the one in
[`dynamodb-local-cross-worktree-test-contention`](./dynamodb-local-cross-worktree-test-contention.md):
integration tests timing out at their budget in a full run and passing solo in
milliseconds. That issue's cause was the `-sharedDb` single SQLite write lock,
and its July fix (per-key databases) was real and holds. This is a SECOND cause
behind the same signature, which is exactly what made it expensive to diagnose -
the first hour went into blaming concurrent worktree activity, which was a
plausible reading of the same evidence and wrong.

**Resolution (2026-08-16, fix/ddb-table-cleanup).**

- `app/test/globalTeardown.ts` drops this worktree's tables after every vitest
  run. Wired through the function `globalSetup` RETURNS - Vitest has NO
  `globalTeardown` config option, and setting one is accepted silently and never
  runs (verified: the tables survived a run untouched).
- `globalSetupEnsure.test.ts` drops its random keys in `afterAll`, closing the
  per-run leak.
- `db-create.ts --drop` plus a call from `scripts/e2e-stop.mjs` reclaims a
  finished lane's tables. Placed there specifically because it runs only after
  the session is confirmed dead.
- `dropAllTables` now also drops `dev-outbox`, which
  `adapters/recordingMessaging.ts` creates on demand and which is deliberately
  absent from the `TABLES` manifest. Without it every teardown left exactly one
  table behind - found by counting tables after a full suite (22 dropped, 1
  survivor).
- `scripts/db.mjs` warns when the container has been up >= 3 days. WARN ONLY: a
  restart wipes every live lane, so it stays an operator decision. It exists
  because the symptom actively misleads.

Measured cost of the vitest teardown: drop 99ms, cold create 197ms, idempotent
re-ensure 52ms, so ~244ms net per run. Verified end to end: 23 tables before a
full run, 0 after.

**Deliberately NOT fixed: `npm run e2e`.** It never calls `e2e-stop`, so its
lane's tables persist. The obvious hook - Playwright `globalTeardown` - runs
BEFORE `webServer` shutdown, so it would drop tables out from under a live app
and worker; and with `reuseExistingServer: !CI` a local run can attach to a
session the developer started, which that hook would then wipe. Weighed against
a bounded 16 reused lane databases, the risk was not worth it. Revisit only with
a reliable "this run owns the stack" signal.

**Two traps worth remembering.**

1. A `globalTeardown` key in `vitest.config.ts` is silently ignored. If teardown
   seems not to run, check that it is returned from `globalSetup`.
2. The AWS SDK resolves credentials at CLIENT CONSTRUCTION, and with per-key
   databases the access key selects WHICH DATABASE you reach. Mutating
   `process.env` around a call on an already-built client does nothing. That was
   a live FALSE PASS in `globalSetupEnsure.test.ts`: every assertion used one
   client built under the worktree key, where `hc-local-tours` always exists
   because `globalSetup` had just created it, so "creates all tables under a
   fresh key" passed whether or not creation under the fresh key did anything.
   Now routed through a `clientForKey()` helper and verified falsifiable -
   pointing creation at a different key makes the test fail, where the old
   version passed.

**Residual, accepted.** A hard kill (Ctrl-C, SIGKILL, agent teardown, reboot)
skips teardown. That self-heals for any worktree still in use - the next run
recreates the tables under the same key and the next clean exit removes them -
and strands only if the worktree is abandoned right after a killed run. Those
databases, like any belonging to a deleted worktree, are unreachable forever and
only a container restart frees them.
