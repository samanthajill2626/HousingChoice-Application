---
id: logcallsiteguard-hook-budget-equals-its-own-cost
title: logCallSiteGuard's beforeAll budget (180s) is smaller than the hook's own measured cost
type: bug
severity: med
status: resolved
area: app
created: 2026-08-26
resolved: 2026-09-01
updated: 2026-09-01
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

**Resolution (2026-09-01).** Measured on the npm-test-soundness mission
(records: `docs/superpowers/reviews/2026-08-31-npm-test-soundness/measurements/s2-guard-cost.md`),
the premise did not reproduce: the file alone costs 10.1s wall with 6.5s in
the hook (3 runs, QUIET box), and inside a fully contended five-workspace
`npm test` (host CPU 100%, a concurrent vitest run plus two e2e suites) it ran
31.5s - against the unchanged 180s hook budget. The budget was therefore ~27x
the solo cost and ~5.7x the worst loaded observation, not ~1x as recorded
above. The invariant this issue asked for ("a green machine running this file
alone should finish in a small fraction of its budget") holds as measured:
10.1s of 180s is 5.6%.

What changed on the branch: comments only. The file now carries the measured
per-phase numbers (buildProgram is 85-86% of the hook; `ts.createProgram`
alone 75%), the dated machine state, and an explicit warning that the 27x
headroom is load insurance, not slack to trim. No cut was made: the one
pre-committed remedy (the eager `:97` symbol lookup) measured 4ms and was
declined on the measurement; the two sites that do dominate
(`ts.createProgram`; `isErrorTyped`'s `getTypeAtLocation`) have no
pre-committed remedy and are returned as open decisions in the mission
handback.

The 196.2s / 179.1s figures above could not be reproduced and their cause was
not established. The most plausible account - unproven - is that they were
taken on 2026-08-26, the same day
[`npm-test-runner-rpc-starves-under-concurrent-e2e`](./npm-test-runner-rpc-starves-under-concurrent-e2e.md)
was diagnosed and `maxWorkers: 4` landed (`27d31bbc`): under the old
16-worker default the coordinator and every worker contended for cores, which
is also consistent with the `[vitest-worker]: Timeout calling "onTaskUpdate"`
this issue records alongside the hook timeout. That RPC failure was never a
hook-budget problem and was fixed by `maxWorkers`, not by anything here - this
closure claims no credit for it.

Reopen trigger: `Hook timed out in 180000ms` on this file again, under
`maxWorkers: 4`, with the machine state captured.
