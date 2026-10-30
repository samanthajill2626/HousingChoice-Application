---
id: ranking-spend-ceiling
title: The paid Rank trigger has no spend ceiling, and a VA may press it through the API
type: decision
severity: med
status: open
area: app/ranking
created: 2026-10-29
refs: app/src/routes/rankings.ts:125, app/src/lib/config.ts:835, app/src/middleware/rateLimit.ts:265, app/src/services/ranking/job.ts:589, dashboard/src/App.tsx:234
---

**Problem.** `POST /api/rankings/:anchorKind/:anchorId/rank` is admin AND va
by design (spec D12: B3's composer will need VA access), although the only
UI that presses it today is Settings > Rankings, behind the dashboard's
AdminRoute. Each press is a new job of up to RANKING_MAX_POOL /
RANKING_BATCH_SIZE paid model calls (8 at the defaults), each carrying the
full rubric and worked examples. The one guard is a per-USER, per-PROCESS,
in-memory sliding window (RATE_LIMIT_RANK_PER_MIN, default 6 a minute;
middleware/rateLimit.ts:265-300); throughput is otherwise bounded only by the
worker's job slots (RANKING_MAX_CONCURRENT_JOBS, 2) and the 10-minute queue
expiry, and a takeover re-runs a whole job (job.ts:589-668). Nothing caps
spend per day or per environment; the cost page is read-only.

Scenario: a VA session (or a script holding one) presses Rank for a
different property every 10 s - six paid jobs a minute per user per app
process, all day. Found by the B2a planner's plan-blind review (PA-3, MEDIUM,
PLAUSIBLE).

**Decision for Cameron** (raised at the B2a handback).

- (a) requireRole('admin') on the press until B3 needs VA access (the spec
  D12 grant is then a B3 change).
- (b) A per-environment daily spend ceiling, checked when a job is claimed:
  over it, the press answers a plain refusal and nothing is called. Needs a
  running total (the run log's costUsd, or a counter item).
- (c) Both; or accept the limiter as it stands.

Source: docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/code-review/
planner-adversarial.md (PA-3) and planner-adjudications.md.
