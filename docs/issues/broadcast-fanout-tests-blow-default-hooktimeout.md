---
id: broadcast-fanout-tests-blow-default-hooktimeout
title: broadcastApi fan-out tests blow the 10s DEFAULT hookTimeout - red on main under load
type: bug
severity: med
status: resolved
area: app
created: 2026-08-06
resolved: 2026-08-21
refs: app/test/broadcastApi.test.ts:124, app/vitest.config.ts:27, app/src/adapters/scheduler.ts:137
---

**Resolution (2026-08-21, `fix/e2e-harness-determinism`).** Both halves of the
suggested fix, since they address different failures:

- `app/vitest.config.ts` now sets `hookTimeout: 60_000` beside `testTimeout`,
  with a comment that the two must move together. (The issue cites the old
  `testTimeout: 15_000` at line 14; the global had since been raised to 60s,
  which widened the gap rather than closing it - hooks were still on Vitest's
  10s default while the tests they clean up after had 60s.)
- The `afterEach` reset moved into a `finally`, so a drain that blows its budget
  can no longer skip `_resetForTests()` and poison the following tests. That was
  the cascade the issue describes: one real cause reported as three failures,
  the extra two looking like unrelated `expected 500 to be 200`.

`broadcastApi.test.ts` 65 passed alone; the full `npm test` was green (318 app
files, up from a baseline with one failing file).

**Problem.** `app/test/broadcastApi.test.ts` fails on a slow-enough machine, and it fails
on **main**, not just on a feature branch. Observed 2026-08-06 in the
`feat/contact-rosters` worktree: the file was green in `6375ms` at 16:41, then red on
every run that evening (24.5s / 48.7s / 16.7s solo), with the SAME app workspace bytes.

The failing budget is the **`afterEach` hook**, not a test:

```
FAIL test/broadcastApi.test.ts > send-by-selection fans out across multiple fetch chunks
  Error: Hook timed out in 10000ms.
  > app/test/broadcastApi.test.ts:124  afterEach(async () => { await queueAdapter.settle(); ...
```

`app/vitest.config.ts:14` raises `testTimeout` to 15s - the mitigation recorded in
[dynamodb-local-cross-worktree-test-contention](dynamodb-local-cross-worktree-test-contention.md)
- but `hookTimeout` was never raised alongside it, so hooks still run on Vitest's 10s
default. The heaviest tests here seed 60+ recipients and defer the whole fan-out into
`InProcessOutboundQueueAdapter` (`app/src/adapters/scheduler.ts:137`), which the
`afterEach` then drains with `settle()`. The drain is the slowest thing in the file and it
is the one thing running on the SHORTER budget.

Two consequences worth separating:

1. **A cascade that hides the cause.** When the hook times out, `_resetForTests()` on the
   next line never runs, so following tests inherit poisoned module state and fail with
   unrelated-looking errors (`expected 500 to be 200`). A full run reported 3 failures for
   1 real cause.
2. **It is not the DynamoDB contention issue.** These tests use an in-memory `FakeWorld`
   and never touch DynamoDB Local, so the per-access-key isolation that fixed the
   contention class does nothing here. Do not let the resolved issue absorb this one.

**Proof it is not any one branch's doing.** Run the file DETACHED at base `d59bd76b`
(pure main) in a worktree: it is red there too (45.4s, `draft -> send transitions` at
25024ms). The e2e suite on the same machine at the same time ran fully green at its normal
speed (`210 passed (12.2m)` vs a 12.3m baseline), so this is not a machine-wide stall - it
is this file's budget being marginal.

**Suggested fix.** Raise `hookTimeout` next to `testTimeout` in `app/vitest.config.ts` so
the drain hook gets the same load allowance the tests already have - the smallest change
that matches the existing, deliberate mitigation. Better, if someone wants to spend the
time: make the fan-out tests await their own settle inside the test body and keep the
`afterEach` as a cheap leak-guard, so a slow drain fails the test that caused it and the
reset always runs. Whichever is chosen, the reset in `afterEach` should be moved into a
`finally` so a timed-out drain can never poison the next test.
