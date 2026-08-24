---
id: concurrent-capacity-budget-tail
title: Under deliberate multi-suite load, small phase budgets (5s login-ready, 15s job-observe) fire in specs with no other defect - the soak should enumerate them
type: debt
severity: med
status: open
area: e2e
created: 2026-08-24
refs: e2e/tests/dashboard-next/relay-group-view.spec.ts:103, e2e/tests/dashboard-next/relay-group-view.spec.ts:183, e2e/support/today.ts
---

**Problem.** With corruption-class contention fixed (per-file DB keys, lane
leases, keep-alive hardening), what remains under multi-agent machine load is
CPU starvation stretching timing windows - and the remaining reds come from
specs whose budgets encode "the machine is fast". The 2026-08-24 final gate
run on `fix/test-suite-wave3` (251/2, 24.4m, run while another agent worked
the same machine) failed two relay-group-view tests that have never appeared
on any flake list, both with generic-starvation shapes:

- `:183` - `expectTodayReady`'s Today-heading assert (5s) timed out during
  the LOGIN phase, before the test's substance. Every spec's devLogin rides
  this helper, so a marginal cold-SPA-load budget will fire RANDOMLY across
  the whole suite under load - this spec just drew the short straw.
- `:103` - a fan-out leg not observed in the outbox within 15s: in-process
  deferred-job latency under starvation, not a missing send.

Both passed 5/5 solo minutes later ON THE SAME BUSY MACHINE - full-suite
parallelism plus external load is the trigger, not the external load alone.

**Why not just raise the budgets now.** A blanket raise masks real hangs (the
repo's standing rule), and one contended sighting per budget is not a
measurement. The right sizing data is exactly what the planned soak produces.

**What the soak should do with this.** Treat deliberate two-suite concurrency
as a FIRST-CLASS scenario and collect, per red: the spec, the budget that
fired, the phase it guarded (login / navigation / job-observe / SSE), and the
solo re-check. The output is a sized list of phase budgets to raise WITH
REASONING (e.g. "login-ready: p99 11s under dual-suite load -> 20s budget
scoped to the login helper only") - phase-scoped raises, never blanket ones.

The named-phase precedent already in the tree: pickPlacementStage's page-load
wait, the reseed clearMs/seedMs timings, the badge route-hold. Budgets that
fire should keep becoming MECHANISMS where possible and sized budgets only
where the phase is genuinely load-bound.
