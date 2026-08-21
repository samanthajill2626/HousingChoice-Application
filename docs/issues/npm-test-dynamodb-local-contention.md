---
id: npm-test-dynamodb-local-contention
title: npm test is not reliably green - four integration suites fail nondeterministically under shared DynamoDB Local contention
type: bug
severity: med
status: open
area: app/test-infra
created: 2026-08-05
updated: 2026-08-21
refs: app/test/groupCrossCheck.test.ts, app/test/unreadIndexRepo.integration.test.ts:561, app/test/seedProfile.integration.test.ts:122, app/test/seedLive.test.ts, app/src/lib/dynamoAdmin.ts:153, app/scripts/db-update-gsis.ts:152, app/vitest.config.ts:16
---

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

**Problem.** `npm test` - one of the three required completion gates - is not
reliably green, on `main` or on any branch. Four integration suites fail
nondeterministically, all of them DynamoDB Local suites, all of them green when
run alone. The failing CASES vary run to run while the failing FILES stay stable:
the signature of shared-resource contention, not a code defect.

**Corrected 2026-08-20:** an earlier framing said `npm test` was RED on main. It
is not deterministic. Main flakes. That distinction matters because a
deterministic red can be waited out, while a flake means every gate result on
every branch has to be adjudicated by hand.

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

**Suggested fix.** Cheapest first; they are independent and can land separately:

1. **C and D** - give the two heavy seed round-trips an explicit per-test timeout
   (the vitest third argument, e.g. `60_000`) rather than raising the global one.
   The global 15s is a useful upper bound for the ~3.5k fast tests. Cheap, no
   infrastructure change, closes two of the four.
2. **B** - confirm whether `93ca271b` already cured it. If it recurs, either
   serialize the schema-mutating lane away from the other integration suites, or
   retry `UpdateTable` on `InternalFailure`.
3. **A** - make the ordering/window assertions robust to latency: explicit waits
   on state rather than call-order spies, or widened windows.
4. **Structural, if 1-3 are not enough** - establish whether these suites can
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
