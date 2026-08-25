---
id: dashboard-api-client-has-no-request-timeout
title: The dashboard API client bounds no request, so a stalled fetch spins forever with no error and no retry
type: bug
severity: med
status: open
area: dashboard
created: 2026-08-25
refs: dashboard/src/api/client.ts:111, dashboard/src/routes/placements/PlacementDetail.tsx:440
---

**Problem.** `requestWithStatus` passes only a caller-supplied `signal` to
`fetch` and sets no timeout of its own
([client.ts:111](../../dashboard/src/api/client.ts)). Nothing else in the
dashboard adds one. A request that neither resolves nor rejects therefore
leaves the calling component in its loading state permanently.

PlacementDetail is where this was observed, and it shows the shape clearly:
`load()` awaits `getPlacement` first, and while `status === 'loading'` the page
renders a bare `<Spinner center />`
([PlacementDetail.tsx:440](../../dashboard/src/routes/placements/PlacementDetail.tsx)).
The `status === 'error'` branch right below it renders a real `role="alert"`
("We couldn't load this placement") - so the component distinguishes the two
states correctly. It just never REACHES the error branch when the promise never
settles.

**CORRECTION (2026-08-25).** This issue was originally filed citing two gate
failures where the placement page held `<main>` at `status "Loading"`, and
claimed they proved a stalled fetch. **They do not, and that evidence is
withdrawn.** Traces later showed no stalled request anywhere - those failures
were a test-budget overrun, and the spinner was simply a page navigated to a few
hundred ms earlier. See
[`placement-detail-bundle-fetch-stall`](./placement-detail-bundle-fetch-stall.md).

The defect here is nonetheless real, because it is a property of the code rather
than of that incident: there is no timeout, so a request that never settles
leaves the component in its loading state forever. What is missing is a
confirmed sighting, not the mechanism. A user in that state would see an
indefinite spinner with no error, no retry affordance, and no indication
anything is wrong.

This is not e2e-only. Deployed, the app sits behind CloudFront -> ALB, and
mobile clients drop connections routinely; the same stall is a permanent
spinner for a real navigator.

**Scope.** `dashboard/src/api/endpoints.ts` exports 118 request functions, so
the default belongs in the shared client rather than at call sites. Only three
are plausibly slow-by-design and would need an explicit override:
`provisionPlacementRelay`, `sendEmail`, and `uploadToPresignedPost`.

**Suggested fix.**

- A default timeout in `requestWithStatus`, composed with any caller signal
  (`AbortSignal.any([signal, AbortSignal.timeout(MS)])`) so an explicit abort
  still wins, surfacing as a distinguishable error rather than a generic
  `network_error`.
- Named per-call overrides on the three slow-by-design endpoints above.
- A retry affordance on PlacementDetail's error branch (currently terminal -
  the only recovery is a manual reload).

**Priority.** Lower than when filed. With the e2e failures explained by budget
overrun, this is a robustness gap with no observed incident behind it - real
for a flaky mobile client or a dropped connection behind CloudFront, but not
urgent, and it should be sized as ordinary hardening rather than an incident
fix.
