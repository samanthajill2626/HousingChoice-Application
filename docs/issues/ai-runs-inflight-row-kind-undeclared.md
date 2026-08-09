---
id: ai-runs-inflight-row-kind-undeclared
title: ai_runs ships a third row kind (inflight#) that the frozen spec's two-row-kind model does not declare
type: decision
severity: low
status: open
area: app/ai-run-log
created: 2026-08-09
refs: docs/superpowers/specs/2026-08-06-ai-run-log-design.md:106, app/src/repos/aiRunsRepo.ts:129, app/src/repos/aiRunsRepo.ts:170, app/src/repos/aiRunsRepo.ts:186, app/src/repos/aiRunsRepo.ts:324
---

**Problem.** Frozen design 5.2
(`docs/superpowers/specs/2026-08-06-ai-run-log-design.md:106-110`) describes the
`ai_runs` table as a single hash key `itemId` with **two disjoint row kinds by
prefix**:

```
run#<runId>                            the full record
ptr#<entityKey>#<startedAt>#<runId>    an adjacency-list pointer
```

The build added a third: `inflight#<runId>`. Key builder at
`app/src/repos/aiRunsRepo.ts:129` (`export const inflightItemId`), written by
`beginFinalization` at `:170-182` (an `UpdateCommand` fenced with
`ConditionExpression: 'attribute_not_exists(itemId)'` and stamped with
`expires_at: runExpiresAt(startedAt)`), consumed and deleted by `putRun` at
`:186-230`, and re-created by the `setVerdict` fallback ladder inside
`:324-410`. It holds verdicts written before the run envelope lands, so a
verdict is never lost to a race between the recorder and a human accept.

This is a spec/implementation mismatch, not a defect: the row is condition
fenced, TTL'd on the same 90-day clock as the envelope, scrubbed when `putRun`
commits, and never returned by any query (the `byEntity` GSI is sparse and
inflight rows carry no `entityKey`). Reverting it would reopen the lost-verdict
race the ladder exists to close.

**Suggested fix.** Record it as spec errata rather than changing code: amend
section 5.2 to name three row kinds, document `inflight#<runId>` as a short-lived
pre-envelope verdict buffer, and state its fence, its TTL, and the exact point
it is deleted. Keep the "disjoint by prefix" invariant explicit so a future
reader knows the sparse GSI intentionally never sees it.
