---
id: dynamodb-local-cross-worktree-test-contention
title: Shared DynamoDB Local makes app test suites flake under concurrent worktree runs
type: debt
severity: low
status: open
area: app
created: 2026-07-02
refs: app/test/devOutbox.integration.test.ts, e2e/support/lane.mjs, scripts/db.mjs
---

**Problem.** All worktrees share ONE DynamoDB Local container (`:8000`). The e2e layer is
lane-isolated (`hc-local-<L>-` table prefixes), but the **Vitest integration suites** are
not throughput-isolated: when two or more agents/worktrees run `npx vitest run` (or a full
e2e boot seeds tables) at the same time, the container's single-threaded throughput is
shared and slow tests blow their 5s budgets.

**Observed (2026-07-02, tours-sequence build).** Repeatedly during concurrent agent work:
- `app/test/devOutbox.integration.test.ts` timed out (5s) in full-suite runs while a
  neighboring worktree ran its own suite/e2e; **passes solo in ~350ms** every time.
- One run had 6 files fail on pure 5s DynamoDB timeouts; a re-run after the competing
  runs drained was fully green. No code difference between red and green runs.

**Why it matters.** Agents (and humans) read these as real failures, burn time
re-verifying, and "green" gates get retried. It will bite harder as concurrent-worktree
development (the port-lane model) becomes the norm.

**Suggested fix (options, cheapest first).**
1. Raise `testTimeout` for the DynamoDB-Local integration suites (e.g. 15s) — timeouts are
   contention, not hangs.
2. Vitest table-prefix isolation per worktree (reuse the lane hash from
   `e2e/support/lane.mjs` for unit-test table names) — removes data collisions, though the
   throughput ceiling remains.
3. A per-worktree DynamoDB Local container (heavier; probably unnecessary).

Until fixed: a lone red integration test in a full run that passes solo should be treated
as this contention, verified by the solo re-run, and noted — not "fixed".
