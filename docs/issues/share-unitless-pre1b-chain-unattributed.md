---
id: share-unitless-pre1b-chain-unattributed
title: A share with no property (unit-less) whose retry chain started before retry-send-adoption stays unattributed for good - the repair never walks it, so its results row keeps the first failure
type: bug
severity: low
status: open
area: app/broadcasts
created: 2026-09-28
refs: app/scripts/repair-share-outcomes.ts:375, app/src/jobs/retrySend.ts:583, app/src/routes/webhooks/twilio.ts:3559
---

**Found by.** `feat/share-sent-outcome` spec section 2 (non-goals: "Unit-less
shares ... the repair does not walk them, so a pre-1b retry chain under one
stays unattributed for good") and D8; filed at the branch's fix wave 1 (plan
T15) so the residual is tracked. Anchors at that fix wave.

**Problem.** The repair walks only unit-targeted shares - ONE Scan of the
broadcasts table filtered to rows carrying a `unitId`
(`app/scripts/repair-share-outcomes.ts:375`). A retry row appended before
retry-send-adoption carries no `broadcast_id` or `retry_root`, and 1b copies
`broadcast_id` ONE hop from the retried row (`app/src/jobs/retrySend.ts:583`),
so a later retry of such a row carries none either. Under a share WITH a
property the repair stamps those rows and re-applies the chain's outcome;
under a unit-less share nothing does: the rows' receipts never enter the
webhook's share routing (`app/src/routes/webhooks/twilio.ts:3559` needs a
`broadcast_id`), and the share's recipient slot keeps its first failure - its
results row, pill and chips read the original failure whatever the retry did,
as they did before the branch.

**Reach.** Unit-less shares only, with a 30003 chain that started before 1b
deployed (or was retried from such a row). Unit-less shares write no ledger
row and their milestone keeps today's words (spec section 2), and the
composer's "Already sent" flag is per property, so no flag or ledger surface
is affected - only that share's own results.

**Why accepted.** A spec non-goal: unit-less shares have no property, so no
ledger, milestone or composer flag depends on them; the cost is one stale
results row per affected recipient.

**Directions (not taken).** Let the repair walk unit-less shares for the stamp
and slot steps only (never the ledger step), by dropping the Scan's unit
filter and skipping step 5 for a share with no `unitId`.

**Related.** [broadcast-30003-retry-never-updates-slot](./broadcast-30003-retry-never-updates-slot.md)
(resolved by the branch for shares with a property).
