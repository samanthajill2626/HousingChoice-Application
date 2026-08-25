---
id: ai-runs-throttled-batchget-renders-expired
title: A throttled ai_runs BatchGet renders as "Expired run", indistinguishable from a TTL-reaped record
type: bug
severity: low
status: resolved
area: app/ai-run-log
created: 2026-08-09
resolved: 2026-08-25
refs: app/src/repos/aiRunsRepo.ts:169, app/src/repos/aiRunsRepo.ts:194, app/src/repos/aiRunsRepo.ts:345, app/src/routes/aiRuns.ts:195, dashboard/src/api/types.ts:245, dashboard/src/routes/settings/aiRuns/AiRunList.tsx:58
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

**Resolution (2026-08-25).** The full fix shipped on `feat/log-hygiene`, not the
cheaper interim step.

`batchGetRuns` now returns `{ found, unprocessedRunIds }` instead of a bare map.
The unprocessed keys were CHUNK-LOCAL and discarded before; they are now
accumulated across every 100-key chunk into a `Set`, with the `run#` prefix
stripped by `runIdOfItemId`, a new exported inverse of `runItemId`. The
once-per-call WARN survives verbatim in message and field name and now keys on
the distinct-runId count. `listByEntity` maps found pointers to live entries as
before, pointers in `unprocessedRunIds` to expired entries carrying
`unavailable: true`, and everything else to a plain expired entry - so
"unresolved because throttled" and "unresolved because reaped" are now different
values on the wire, which is what the issue asked for.

SHAPE, chosen against the obvious alternative: ONE non-live union member with an
OPTIONAL discriminant - `{ runId; sortKey; expired: true; unavailable?: true }` -
on BOTH the server union (`AiRunListEntry`) and the hand-kept wire duplicate
(`dashboard/src/api/types.ts`), moved in the same commit. Two separate union
members do not typecheck at the truthiness-narrowed renderers, and with the
optional form every consumer that is NOT updated degrades gracefully to today's
expired rendering - no crash, no 500, no compile error. The route's expired arm
spreads the flag in the house `!== undefined` form.

The dashboard renders the unavailable case as distinct NON-INTERACTIVE text -
`Run <id> temporarily unavailable - reload the page to retry` - inside the
existing expired-row style. This is a deliberate DEVIATION from the issue's
"render the unavailable case as a retryable row": there is NO per-row button. A
third button breaks `ai-run-log.spec.ts`'s one-button-per-row pin and
`AiRunsSection.test.tsx`'s singular Retry query, and more importantly
`useAiRuns.retry()` resets to page 1, so an in-place row retry would LIE about
what it does. The copy names the browser reload instead, because the list's own
Retry control renders only in the error state, not the ready state this row
appears in. The copy also deliberately avoids the word "expired", which an
existing test queries for.

Coverage: repo cases force UnprocessedKeys exhaustion through a fake doc client
(a fixed-two leftover set, a genuinely-absent row asserted by KEY absence rather
than by an undefined value, and cross-chunk accumulation over 150 keys
withholding one row from each chunk); a route case pins the exact serialized row
and that a reaped row carries no flag at all; a dashboard component case asserts
the copy renders, does not match `/expired/i`, and contains no button. No new e2e
spec: this state needs sustained DynamoDB throttling that a hermetic lane cannot
produce, and it adds no interactive control.

REFS CORRECTED. Every `:NNN` in the Problem section above was read at filing
(2026-08-09) and has drifted twice since - `routes/aiRuns.ts:67` now points at
unrelated code entirely. The frontmatter `refs` now cite this branch's anchors:
`aiRunsRepo.ts:169` (batchGetRuns), `:194` (the leftover WARN), `:345` (the
listByEntity mapping), `routes/aiRuns.ts:195` (the expired arm),
`dashboard/src/api/types.ts:245` (the wire union), and `AiRunList.tsx:58` (the
row). Re-locate by the quoted code, not by the number.
