---
id: ranking-cost-undercount
title: The Rankings cost totals can under-count real model spend
type: bug
severity: low
status: open
area: app/ranking
created: 2026-10-29
refs: app/src/adapters/ranking.ts:91, app/src/services/ranking/runLog.ts:107, app/src/services/ranking/runBatch.ts:230, app/src/routes/adminRankings.ts:334
---

**Problem.** Settings > Rankings totals cost by week from the ranking runs
(GET /api/admin/rankings/cost), and Cameron watches testing-key and
production spend there. Two paths leave paid calls out of the totals:

1. **A call with no usage records cost 0** (PA-12). The SDK call runs with
   one retry and a per-call timeout (adapters/ranking.ts:91). A call that
   times out client-side, or loses its connection, returns no usage, so its
   run records `costUsd` 0 (runLog.ts:107) - but the provider may have
   completed (and billed) it, and the SDK's retry may bill a second time.
2. **A stopped job's paid call writes no run** (PC-2). After the call
   returns, a job that was superseded or lost its lease writes nothing
   (spec D7's generation check, runBatch.ts:230-247); its usage and cost go
   only to a WARN log line (plan PR36: spend is never invisible). The
   takeover then re-runs and bills the batch again, and only that second
   call is counted. Spec D11 says every model call is a ranking run; D7 says
   a stopped job writes nothing - the build resolved the tension toward D7.

Found by the B2a planner's reviews: PA-12 (plan-blind, LOW, PLAUSIBLE) and
PC-2 (spec conformance, LOW, CONFIRMED), folded together at adjudication.

**Suggested fix.** Either label the totals "recorded runs" with a note
naming both gaps, or close them: write a stopped job's run anyway (a run is a
log, not a score - skip only the match write), and record a timed-out call
as a run with `usage` unknown rather than zero. Reconciling against the
provider's usage report is the complete answer.

Source: docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/code-review/
planner-adversarial.md (PA-12), planner-conformance.md (PC-2) and
planner-adjudications.md.
