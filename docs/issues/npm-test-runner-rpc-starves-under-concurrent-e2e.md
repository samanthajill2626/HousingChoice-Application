---
id: npm-test-runner-rpc-starves-under-concurrent-e2e
title: Under concurrent e2e load, vitest's own worker RPC times out - the run reports "unhandled error" and its results stop being evidence
type: bug
severity: med
status: resolved
area: app/test-infra
refs: app/vitest.config.ts, node_modules/vitest/dist/chunks/index.B521nVV-.js:3
created: 2026-08-26
resolved: 2026-08-26
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

**THE SIGNATURE TO SEARCH FOR: the run exits 1 with ZERO failing tests.** The
unhandled error alone sets a non-zero exit, so the reproduction below ended
`336 passed | 1 skipped`, `5977 passed`, no `FAIL` line anywhere - and exit
code 1. Someone reading that exit code goes hunting for a broken test that does
not exist, which is the expensive part of this bug.

**Read vitest's own warning literally: the run's results are not evidence.**
When task updates are dropped, the reporter's view of what ran diverges from
what actually ran - which is why vitest says "this might cause false positive
tests". A green result from such a run does not mean the suite passed, and a red
one does not mean it failed. Discard the run; do not analyse it.

**Sighting (2026-08-26).** The box carried two e2e suites from separate
worktrees, a third e2e suite, a `npm test`, and a 6-worker CPU load generator,
on 16 cores. Healthy reference on a quiet box the same day: 241 files, 3559
tests, 0 failures, app workspace 74s wall clock.

**The 60s timeout is not tunable** - it is a hardcoded constant inside vitest's
bundled birpc, not exposed through `vitest.config.ts`, and there is no
`rpcTimeout` option in 3.2.x. But the timeout was never the problem.

**ROOT CAUSE: the pool claimed every core, including the coordinator's.**
`app/vitest.config.ts` set no `poolOptions`, so vitest defaulted `maxThreads` to
`availableParallelism()` - 16 threads on a 16-core box - leaving the MAIN
process no core to run on. That process is what answers worker RPCs. Solo it
still squeaks through; add any external load and it starves.

**An earlier version of this issue recommended not running `npm test` while e2e
runs. That was wrong and is retracted.** It asked people to work around a
defect at the cost of their workflow, which is a rule nobody follows and which
would not have fixed anything. Capping the pool fixes it outright.

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

**Fix: top-level `maxWorkers: 4`** in `app/vitest.config.ts`.

**IT MUST BE `maxWorkers`, NOT `poolOptions.threads.maxThreads`.** The first
attempt shipped the latter and was INERT - the failure recurred unchanged.
Vitest 3's default pool is `forks` (`defaults.B7q_naMc.js`), and each pool reads
only its own key:

```
forks:   poolOptions.maxForks   ?? config.maxWorkers ?? threadsCount
threads: poolOptions.maxThreads ?? config.maxWorkers ?? threadsCount
```

So a `threads` key configures a pool that is not running, and vitest says
nothing about it. **This is the trap worth remembering: pool options fail
SILENTLY when they name the wrong pool.** Top-level `maxWorkers` is read by
both, so it also survives a future pool change.

The A/B below was measured with the CLI's `--maxWorkers`, which resolves to the
top-level option. Shipping the `poolOptions` form changed the mechanism without
re-testing it - the measurement was sound and the implementation did not match
it.

Sized by A/B, all runs 336 files / 5977 tests, same commit:

| condition | maxThreads | duration | RPC errors | exit |
|---|---|---|---|---|
| quiet box | 16 (default) | 249.8s | 0 | 0 |
| quiet box | **4** | **253.1s** | 0 | 0 |
| under load | 16 (default) | 347.8s | **1** | **1** |
| under load | **4** (CLI flag) | 361.7s | **0** | **0** |
| **under LIVE e2e load** | **4 (config only)** | **720.5s** | **0** | **0** |

The last row is the one that proves the SHIPPED form: no CLI flag, config alone,
while two full e2e suites and a 6-worker load generator ran on the same box at
94% CPU. That is roughly twice the contention of the run that originally failed
(720.5s against 347.8s), and it came back clean.

Capping costs **1.3% on an idle box** and removes the failure entirely. The
parallelism above 4 was buying close to nothing even when idle, because this
suite is bound by DynamoDB Local I/O rather than CPU - it was only ever costing
the coordinator its core. Note the cumulative figures move the same way
(collect 394.6s -> 215.8s, tests 727.8s -> 508.2s): fewer threads did less
thrashing, not less work.

**Raising this number is not a speed win, it is a way to reintroduce the false
red.** If someone wants more parallelism later, measure a quiet-box run first -
the 1.3% gap is the entire prize.
