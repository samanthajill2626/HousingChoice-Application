---
id: e2e-lane-allocation-cross-worktree-race
title: E2E lane allocation is not atomic across worktrees
type: debt
severity: high
status: open
area: e2e
created: 2026-08-12
refs: e2e/support/lane.mjs, scripts/e2e-session.mjs
---

**Problem.** The shared E2E harness chooses a lane with a free-port probe and later starts the lane services. Two worktrees can select the same free lane during that gap. The general launcher also reaps processes holding the dashboard and fake-service ports. The page performance profiler now refuses inherited lane pins, uses an exclusive same-worktree marker, does not reap occupied ports in profiler mode, and proves its child app with a per-run token and exact commit before destructive reseeding. Those feature-specific checks prevent the profiler from wiping or killing a different run, but the underlying allocation race remains for ordinary E2E sessions.

**Suggested fix.** Add a repository-wide, compare-before-delete lane lease acquired atomically before returning a lane. Include a random owner token in every launched service's health response, require exact owner proof before reuse or destructive setup, and make cleanup release only the matching lease.
