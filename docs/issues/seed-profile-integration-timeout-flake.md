---
id: seed-profile-integration-timeout-flake
title: seedProfile integration test times out (15s) inside the full app suite
type: bug
severity: med
status: open
area: app
created: 2026-08-05
refs: app/test/seedProfile.integration.test.ts:122, app/vitest.config.ts:16
---

**Problem.** `app/test/seedProfile.integration.test.ts > "full superset-of lean:
full profile count is >= lean count"` fails with `Test timed out in 15000ms`
whenever it runs inside the FULL app suite (`npm test`), while passing solo in
~8s. The test runs a SECOND complete `seedAll(..., 'full')` against DynamoDB
Local, so under the suite's worker-level parallelism it crosses the global
`testTimeout: 15_000` (app/vitest.config.ts:16).

It is ENVIRONMENTAL, not a regression: reproduced 3/3 on the contact-rosters
S6b working tree AND 1/1 on the same tree with every change stashed (branch
`feat/contact-rosters` @b84117e9, i.e. the untouched base). DynamoDB Local was
NOT clogged with leftover tables at the time (`list-tables` returned an empty
list), so the cause is wall-clock contention on the box, not accumulated schema.

Cost: `npm test` exits 1 on a clean tree, which makes the gate unreadable -
every branch has to hand-verify that the single failure is this one.

**Suggested fix.** Give the two heavy seed round-trips an explicit per-test
timeout (the vitest third argument, e.g. 60_000) rather than raising the global
one - the global 15s is a useful upper bound for the ~3.5k fast tests. The two
known candidates are this test and `app/test/seedLive.test.ts` (which timed out
in one of the four runs above, same class).
