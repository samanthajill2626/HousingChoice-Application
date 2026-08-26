---
id: npm-test-runner-rpc-starves-under-concurrent-e2e
title: Under concurrent e2e load, vitest's own worker RPC times out - the run reports "unhandled error" and its results stop being evidence
type: bug
severity: med
status: open
area: app/test-infra
refs: node_modules/vitest/dist/chunks/index.B521nVV-.js:3, node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:48
created: 2026-08-26
---

**Problem.** Running `npm test` while the machine carries concurrent e2e suites
can break the TEST RUNNER rather than any test:

```
Vitest caught 1 unhandled error during the test run.
This might cause false positive tests. Resolve unhandled errors to make
sure your tests are not affected.

Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 at Object.onTimeoutError (vitest/dist/chunks/rpc.-pEldfrD.js:53:10)
 at Timeout._onTimeout (vitest/dist/chunks/index.B521nVV-.js:59:62)
```

`onTaskUpdate` is how a vitest worker reports progress to the main process. The
transport is birpc, bundled into vitest 3.2.6 with `DEFAULT_TIMEOUT = 6e4` -
**60 seconds**. So this error means the vitest MAIN process did not service a
worker RPC for a full minute.

**Read vitest's own warning literally: the run's results are not evidence.**
When task updates are dropped, the reporter's view of what ran diverges from
what actually ran - which is why vitest says "this might cause false positive
tests". A green result from such a run does not mean the suite passed, and a red
one does not mean it failed. Discard the run; do not analyse it.

**Sighting (2026-08-26).** The box carried two e2e suites from separate
worktrees, a third e2e suite, a `npm test`, and a 6-worker CPU load generator,
on 16 cores. Healthy reference on a quiet box the same day: 241 files, 3559
tests, 0 failures, app workspace 74s wall clock.

**Not tunable.** The 60s value is a hardcoded constant inside vitest's bundled
birpc, not exposed through `vitest.config.ts`. There is no `rpcTimeout` option
in 3.2.x. The remedy is scheduling, not configuration: **do not run `npm test`
on a box that is running e2e suites.** e2e is unaffected by this - it is only
the vitest runner whose IPC starves.

**Distinct from
[`npm-test-dynamodb-local-contention`](./npm-test-dynamodb-local-contention.md).**
That issue is timeouts and SQLite write-locks INSIDE tests, hitting DynamoDB
Local. This one is a layer above, in the runner's own worker/main IPC, and it
presents as an "unhandled error" section rather than as failed tests. Reaching
for the clean-access-key remedy will not help here.

**Not everything in such a run is noise.** The same run produced a genuine,
diagnosable failure - `performanceSeed.integration.test.ts` hitting its hard
300s per-test timeout, which had a clean 112.2s idle baseline to compare against
and was fixed by sizing (300s -> 600s). The distinction worth keeping: a HARD,
named timeout with a measured baseline is real; a dropped RPC invalidates the
REPORT, so anything whose evidence is "the reporter said so" is suspect.

**Recovering which file failed when output has scrolled.** vitest writes a
results cache to `app/node_modules/.vite/vitest/*/results.json` recording
per-file `failed`. It narrows the search but does not name the answer: the flag
persists until a file passes again, so it also lists stale entries (a 2026-08-25
read of it turned up two deleted scratch files alongside the real failure).

**Suggested fix.** Documentation and scheduling rather than code - AGENTS.md's
gate ordering should say plainly that `npm test` needs a box that is not running
e2e. If this recurs often enough to be worth code, the options are pinning a
vitest version that exposes the RPC timeout, or reducing `poolOptions` thread
count so the main process stays schedulable under contention; neither is worth
doing on one sighting.
