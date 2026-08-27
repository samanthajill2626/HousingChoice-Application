---
id: logcallsiteguard-hook-budget-equals-its-own-cost
title: logCallSiteGuard's beforeAll budget (180s) is smaller than the hook's own measured cost
type: bug
severity: med
status: open
area: app
created: 2026-08-26
refs: app/test/logCallSiteGuard.test.ts:140, app/test/logCallSiteGuard.test.ts:143
---

**Problem.** `app/test/logCallSiteGuard.test.ts` does all of its work in one
`beforeAll` (`:140`) that builds a TypeScript program and scans it, and gives
that hook a 180s budget (`:143`). Measured 2026-08-26 on a Windows dev box, the
file run COMPLETELY ALONE under a clean access key took **196.2s total with
179.1s in tests** - i.e. the hook consumed essentially its entire budget with
nothing else on the machine. Under any concurrent load it exceeds it, and the
failure is `Hook timed out in 180000ms` with ZERO assertion failures, usually
accompanied by `[vitest-worker]: Timeout calling "onTaskUpdate"`.

That makes it a load-dependent red in `npm test` (gate 2) that has nothing to do
with whatever branch is being gated. It was observed exactly that way while
gating `feat/inbox-unread-cluster`: a full app-workspace run under a clean key
returned `1 failed | 339 passed | 1 skipped (341)` and `6008 passed | 14 skipped`
at the TEST level - the only failure in the whole suite was this hook - and the
same file then passed in isolation.

This is not the DynamoDB contention issue
([`npm-test-dynamodb-local-contention`](npm-test-dynamodb-local-contention.md)):
the guard touches no database. It is pure CPU, so it competes with every other
vitest worker on the box, and the two failure modes are easy to confuse because
both present as timeouts with no assertion failures.

The cost is not the flake itself so much as what it teaches: a gate that goes red
in a different unrelated file on each run trains people to re-run until green,
which is exactly how a real regression ships.

**Suggested fix.** Raise the hook budget well clear of the measured cost (the
budget should be a multiple of the solo runtime, not equal to it), or split the
build-and-scan so the expensive program build is shared/cached rather than paid
inside a single hook. If the guard is meant to be a slow whole-program check,
consider giving it its own project/lane so it does not contend with the rest of
the workspace. Whatever the shape, the invariant to restore is: a green machine
running this file alone should finish in a small fraction of its budget.
