---
id: e2e-lane-probe-bind-toctou
title: E2E lane free-probe has a TOCTOU race between the port check and the actual bind
type: debt
severity: low
status: open
area: infra
created: 2026-07-02
refs: e2e/support/lane.mjs:152, e2e/support/lane.mjs:231, scripts/e2e-session.mjs
---

**Problem.** The lane free-probe (`defaultProbe`, e2e/support/lane.mjs:152) checks a
port is free by binding a throwaway socket and immediately closing it. The real
consumers (app/Vite/fake-twilio) bind those ports LATER — after the resolver returns
and the session spawns them. Between the probe's `close()` and the actual bind there
is a **TOCTOU** (Time-Of-Check to Time-Of-Use) window: another process can grab the
port after it probed free but before the real bind. Relatedly, the `E2E_LANE` override
path (the Playwright→session handoff) intentionally SKIPS re-probing to avoid
lane divergence (lane.mjs:206-224), so a stray orphan holding the chosen lane's port
surfaces as a bind failure rather than an auto-bump.

Impact is narrow: different worktrees hash (`--absolute-git-dir`) to different
*preferred* lanes, so two runs rarely target the same lane; when the race does bite it
fails **loud** (EADDRINUSE) and **transient** (a re-run picks a different/free lane),
with NO data or port cross-talk — the loser simply fails to boot. Distinct from
`e2e-lane-cold-start-container-race` (that one is the shared DynamoDB/MinIO containers).

**Suggested fix.** Make boot resilient to a REAL bind `EADDRINUSE`: on an actual bind
failure, bump to the next free lane and retry — converting the TOCTOU from "boot
fails" into "auto-recover". (Vite + fake-twilio already `killPort()` orphans before
spawning; app + worker do not — a short retry/bump there would close most of it.)
Holding the probe socket open until handoff is the airtight fix but is hard across a
process spawn. YAGNI-adjacent — the loud+transient failure + re-run is livable today;
file so it's tracked if concurrent runs make it recurrent.
