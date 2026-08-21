---
id: e2e-lane-allocation-cross-worktree-race
title: E2E lane allocation is not atomic across worktrees
type: debt
severity: high
status: open
area: e2e
created: 2026-08-12
updated: 2026-08-21
refs: e2e/support/lane.mjs:152, e2e/support/lane.mjs:206, e2e/support/lane.mjs:231, scripts/e2e-session.mjs
---

<!--
  MERGED 2026-08-21. `e2e-lane-probe-bind-toctou` (low, 2026-07-02) described the
  same check-then-act window in the same function, one process pair narrower.
  Its file was deleted and its content folded in below as "The mechanism". Do
  not re-file it. Still DISTINCT and separately filed:
  `e2e-lane-cold-start-container-race` (the shared DynamoDB/MinIO containers,
  not the lane ports).
-->

**Problem.** The shared E2E harness chooses a lane with a free-port probe and
later starts the lane services. Two worktrees can select the same free lane
during that gap. The general launcher also reaps processes holding the dashboard
and fake-service ports.

The page performance profiler now refuses inherited lane pins, uses an exclusive
same-worktree marker, does not reap occupied ports in profiler mode, and proves
its child app with a per-run token and exact commit before destructive
reseeding. Those feature-specific checks prevent the profiler from wiping or
killing a different run, but the underlying allocation race remains for ordinary
E2E sessions.

**The mechanism (merged from `e2e-lane-probe-bind-toctou`).** `defaultProbe`
(`e2e/support/lane.mjs:152`) checks a port is free by binding a throwaway socket
and immediately closing it. The real consumers - app, Vite, fake-twilio - bind
those ports LATER, after the resolver returns and the session spawns them.
Between the probe's `close()` and the actual bind is a Time-Of-Check to
Time-Of-Use window, and it is the same window two worktrees select through.

Relatedly, the `E2E_LANE` override path (the Playwright -> session handoff)
intentionally SKIPS re-probing to avoid lane divergence (`lane.mjs:206-224`), so
a stray orphan holding the chosen lane's port surfaces as a bind failure rather
than an auto-bump.

**How bad it is, honestly.** In the narrow two-process case the impact is
limited: different worktrees hash (`--absolute-git-dir`) to different PREFERRED
lanes, so two runs rarely target the same lane, and when the race does bite it
fails LOUD (`EADDRINUSE`) and TRANSIENT (a re-run picks a free lane), with no
data or port cross-talk - the loser simply fails to boot. What raises this to
`high` is the reaping launcher and destructive setup on top of it: a run that
believes it owns a lane it does not can wipe or kill another worktree's run, and
that failure is neither loud nor transient. Vite and fake-twilio already
`killPort()` orphans before spawning; app and worker do not.

**Suggested fix.** Add a repository-wide, compare-before-delete lane lease
acquired atomically before returning a lane. Include a random owner token in
every launched service's health response, require exact owner proof before reuse
or destructive setup, and make cleanup release only the matching lease.

Cheaper partial, and worth doing inside that work regardless: make boot resilient
to a REAL bind `EADDRINUSE` - on an actual bind failure, bump to the next free
lane and retry, converting the TOCTOU from "boot fails" into "auto-recover".
Holding the probe socket open until handoff would be airtight but is hard across
a process spawn.
