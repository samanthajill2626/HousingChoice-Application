---
id: perf-selfqa-route-contract-drift
title: Perf self-QA fails on route-contract drift - /api/unread-counts is undeclared
type: bug
severity: medium
status: open
area: e2e/performance
created: 2026-08-24
updated: 2026-08-24
refs: e2e/performance/templates.ts, e2e/performance/routes.ts, dashboard/src/api/endpoints.ts
---

**Problem.** The first recorded self-QA profiler run
(`npm run perf:pages -- hermetic --self-qa=full --cold-repeats=1 --warm-repeats=1`,
report `20260825T013322163Z-1034c5df`, 2026-08-24) reports overall
`status: "fail"` with `endpointSubset: false` and `noUnmatchedApi: false`,
even though all 62 samples are ok and every state check (including the
proof-of-send `outbox` surface) is unchanged.

**Cause: catalog drift, not a page regression.** The unmatched requests are
`GET /api/unread-counts?contactIds=...&conversationIds=...` (15 hits) issued by
the `/placements/:placementId` and `/tours/:tourId` surfaces' comms rails. The
endpoint was added by the contacts-BatchGet / unread work (merged 2026-08-21,
`dashboard/src/api/endpoints.ts` `getUnreadCounts`) and was never added to
`ENDPOINT_TEMPLATES` in `e2e/performance/templates.ts` or to the affected
surfaces' route contracts in `routes.ts`. A further 71 rows with KNOWN
templates but `outcome: "aborted"` are also flagged `unmatchedApi: true` on
those surfaces - triage whether that is the same drift (contracts missing the
requests) or the matcher's handling of aborted required requests.

**Fix sketch.** Declare `/api/unread-counts` in the template list and in the
route contracts of every surface whose rails call it; re-run the locked
self-QA invocation and require `status: "pass"`. While in there, decide the
policy for aborted required requests.

**Not related to** `remove-dev-outbox-proof-of-send` (2026-08-24): that
migration's snapshot ran clean in this same report (`outboxUnchanged: true`),
and removing the `/__dev/outbox` template cannot affect matching of
`/api/unread-counts`. The drift predates the migration and would fail
identically with the old outbox code in place.
