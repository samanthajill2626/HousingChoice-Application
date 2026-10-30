---
id: ranking-read-cost
title: The ranking read costs about a thousand DynamoDB requests for a large property, uncached and unmetered
type: improvement
severity: low
status: open
area: app/ranking
created: 2026-10-29
refs: app/src/routes/rankings.ts:200, app/src/services/ranking/assemble.ts:336, dashboard/src/routes/settings/rankings/useAnchorRanking.ts:322
---

**Problem.** `GET /api/rankings/:anchorKind/:anchorId` (admin and va,
routes/rankings.ts:200) assembles the whole current pool and every card on
each call (assemble.ts:336 assembleRanking): for each candidate tenant a
listing-sends read, a tours read and a units batch read, plus a full walk of
every searching tenant. For a 300-tenant property that is roughly a thousand
DynamoDB requests per read. The Rankings page reads again after every
finished batch (useAnchorRanking.ts:322-324), per viewer, and nothing limits
or caches the read (only the rank press is rate limited). Cost and latency
only - nothing is wrong in what it returns. Found by the B2a planner's
plan-blind review (PA-10, LOW, PLAUSIBLE).

**Suggested fix.** Rate-limit the read per user (the press's
createUserRateLimit pattern), or cache the assembled read keyed by the job
generation and the card fingerprints, so a page that re-reads after each
batch reuses the pool and cards it already has. Revisit when B3 puts the
read in front of every VA.

Source: docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/code-review/
planner-adversarial.md (PA-10) and planner-adjudications.md.
