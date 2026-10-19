---
id: broadcast-null-audience-filter-guard
title: A stored broadcast whose audience_filter is NULL (not missing) still fails the whole Matching list - the PA-5 guard checks only undefined
type: bug
severity: low
status: open
area: app/broadcasts
created: 2026-10-19
refs: app/src/lib/blastAudienceRules.ts:189, app/src/lib/blastAudienceRules.ts:225, app/src/routes/broadcasts.ts:450, app/src/routes/broadcasts.ts:480, dashboard/src/routes/broadcasts/broadcastFormat.ts:67, app/test/broadcastApi.test.ts:2811, app/src/services/audienceResolution.ts:183, docs/superpowers/reviews/2026-10-14-matching-blast-rules/planner-review/conformance.md
---

**Problem.** `feat/matching-blast-rules` (commit 088a12f8, planner review
PA-5) made the Matching list projections tolerate a stored broadcast with no
`audience_filter` - before it, one such row would 500 `GET /api/broadcasts`
for the whole Matching list. The guard returns early only for `undefined`
(`wireAudienceFilter`, `blastAudienceRules.ts:225`; `authoritiesOfFilter`,
`:189`), so a stored `audience_filter: null` (a DynamoDB NULL - only a hand
repair could write one; no app writer does) still throws at `:190` and
fails the list (`broadcasts.ts:450`, `:480`). The dashboard twin
(`broadcastFormat.ts:67`) has the same gap, and the test
(`broadcastApi.test.ts:2811`) covers only a missing field. Found in the
planner's review round 2 (`planner-review/conformance.md`, F1).

Separately, and as on main before the branch, a filter draft stored with no
filter still 500s its own preview and no-body send
(`audienceResolution.ts:183`) - one row only.

**Suggested fix.** Check `== null` in both guards (app and dashboard) and
add a NULL row beside the missing-field one in the list test.
