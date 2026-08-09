---
id: ai-runs-throttled-batchget-renders-expired
title: A throttled ai_runs BatchGet renders as "Expired run", indistinguishable from a TTL-reaped record
type: bug
severity: low
status: open
area: app/ai-run-log
created: 2026-08-09
refs: app/src/repos/aiRunsRepo.ts:157, app/src/repos/aiRunsRepo.ts:164, app/src/repos/aiRunsRepo.ts:308, app/src/routes/aiRuns.ts:67, dashboard/src/routes/settings/aiRuns/AiRunList.tsx:46
---

**Problem.** The run list resolves its pointers through a BatchGet that gives
up after four attempts and returns a PARTIAL map, and everything downstream
treats "absent from the map" as "the record is gone".

`app/src/repos/aiRunsRepo.ts:157-158` retries unprocessed keys
`MAX_BATCH_ATTEMPTS = 4` times with 25ms exponential backoff (`:114-115`). On
exhaustion the only signal is a log line at `:164`
(`'ai run log: BatchGet left keys unprocessed after retries'`), after which
`:308` maps every unresolved pointer to `{ runId, sortKey, expired: true }`,
`app/src/routes/aiRuns.ts:67-68` serializes that verbatim, and
`dashboard/src/routes/settings/aiRuns/AiRunList.tsx:46` renders it as
`Expired run <id>` - a non-clickable row.

So a transient DynamoDB throttle on an admin forensic surface reports the run
as permanently gone. The operator has no affordance to retry that row, and no
way to tell it apart from a genuine 90-day TTL reap. The window is narrow
(sustained throttling on a low-traffic table) and nothing is written wrongly -
this is a reporting defect, not data loss - but "the forensic log says the
record is gone" is exactly the claim this surface must not get wrong.

**Suggested fix.** Distinguish unresolved-because-throttled from
unresolved-because-absent. `batchGetRuns` already knows which keys were left
unprocessed, so return them separately from the found map; map those pointers to
a distinct marker (for example `unavailable: true` alongside the existing
`expired: true`), widen the list row union in `app/src/routes/aiRuns.ts` and
`dashboard/src/api/types.ts`, and render the unavailable case as a retryable row
rather than an expired one. A cheaper interim step is to keep the shape and only
make the failure loud - `log.error` plus a response-level flag the pane can
surface as "some rows could not be loaded".
