---
id: ranking-card-text-length
title: Unbounded card free text and model unknowns can fail a ranking batch or a match write chunk on every press
type: bug
severity: low
status: open
area: app/ranking
created: 2026-10-29
refs: app/src/services/ranking/cards.ts:64, app/src/repos/matchesRepo.ts:193, app/src/services/ranking/parse.ts:101
---

**Problem.** Two length gaps, both found by the B2a planner's plan-blind
review (PA-8 PLAUSIBLE, PA-9 CONFIRMED, both LOW).

1. **Card free text is trimmed, never capped** (cards.ts:64-68). The
   extraction job appends Notes lines for the life of a record, and a tenant
   card also carries up to eight seen-home cards. One tenant with years of
   Notes can push a 40-candidate prompt past the model's context limit, so
   every batch holding that tenant fails `driver` on every press; or make one
   match row's gzipped `inputSnapshot` push the item over DynamoDB's 400 KB,
   so the BatchWrite of its 25-row chunk throws and all 25 pairs read "could
   not be saved" each time (matchesRepo.ts:193-205 reports a throwing chunk
   unwritten; it is not split or retried row by row).
2. **Model `unknowns` are not cut** (parse.ts:101-111). Reasons are cut to
   80 characters; unknowns are only trimmed. A several-KB unknown is stored on
   every match and run (and rendered in the run detail's Missing column).

**Suggested fix.** Cap each free-text card field (and the stored snapshot)
at a stated length with a visible truncation mark; cut unknowns to the same
80 characters as reasons (or a stated limit); and write a row whose chunk
throws on its own, so one oversize row cannot fail its 24 neighbours. Tests:
a card field over the cap reaches the prompt cut; an unknown over the limit
is stored cut; a chunk holding one oversize row writes the other rows.

Source: docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/code-review/
planner-adversarial.md (PA-8, PA-9) and planner-adjudications.md.
