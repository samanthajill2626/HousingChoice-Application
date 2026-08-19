---
id: npm-test-red-on-main-dynamodb-local-contention
title: npm test is red on main - two DynamoDB Local suites fail nondeterministically under full-suite load
type: bug
severity: med
status: open
area: app
created: 2026-08-19
refs: app/test/groupCrossCheck.test.ts, app/test/unreadIndexRepo.integration.test.ts, app/scripts/db-update-gsis.ts:152
---

**Problem.** `npm run test` exits 1 on `main` itself, not only on feature
branches. Two suites fail nondeterministically, and both are DynamoDB Local
integration suites:

- `app/test/groupCrossCheck.test.ts` - sweeps return `[]` where a row is
  expected (`expected [] to have a length of 1`), across several cases.
- `app/test/unreadIndexRepo.integration.test.ts` - `InternalFailure: The request
  processing has failed because of an unknown error, exception or failure` out of
  `UpdateTableCommand` in `ensureGsis` (`app/scripts/db-update-gsis.ts:152`).
  A variant of the same run has surfaced as
  `UnrecognizedClientException: The security token included in the request is
  invalid`.

Measured during the comms-panel call-direction mission (2026-08-18/19), on an
otherwise quiet worktree:

| Run | Commit | Exit | Failing files |
|---|---|---|---|
| full `npm test` | `08ec365c` (main's base, DETACHED) | 1 | both, 5 tests |
| full `npm test` | feature branch | 1 | both, 5 tests |
| full `npm test` | feature branch, post-merge | 1 | both |
| those two FILES alone | `08ec365c` | 0 | none (49 passed) |
| those two FILES alone | feature branch | 0 | none (49 passed) |

The individual failing CASES vary between runs while the failing FILES stay the
same, and both files pass when run in isolation - the signature of shared-resource
contention rather than a code defect. The failure set has also been observed to
GROW between two consecutive runs, and to shrink to one file on another, which is
the same signal.

Why it matters: `npm test` is one of the three required completion gates
(`AGENTS.md`). While it is red on main, every branch's gate result has to be
adjudicated by hand - comparing the branch's failure set against a base-commit
run - before "green" means anything. That is slow, and it is exactly the
condition under which a real regression gets waved through as "the known flake".

**Suggested fix.** Establish whether the two suites can share a DynamoDB Local
container with the rest of the suite at all. Options, roughly in order of
cost: give these suites their own throwaway table prefix per run (some of this
already exists) and confirm no cross-suite table reuse remains; serialize them
away from the other DynamoDB-Local suites; or pin the container version and
raise its resource limits. The `db-update-gsis` `UpdateTableCommand` failure in
particular is already known operationally - the standing workaround is to restart
the DynamoDB Local container - which suggests container state, not test logic.

Until it is fixed, the gate-adjudication recipe that worked is: re-run the failing
files alone, and run the full suite at the branch's base commit, then compare
failing FILES rather than failing cases.
