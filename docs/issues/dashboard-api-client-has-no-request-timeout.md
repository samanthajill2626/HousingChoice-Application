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

Observed 2026-08-25 on `b535a7fa`: two gate runs failed with the placement page
holding `<main>` at `status "Loading"` for a full 20s wait. The preserved
accessibility snapshot shows the alert absent and the spinner present, which is
how we know the fetch stalled rather than failed. A user in that state sees an
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

**Deliberately NOT a fix for the stall itself.** Bounding the fetch converts an
opaque 30s hang into a fast, legible error; it does not stop whatever is
stalling the request. That cause is unknown and tracked separately - see
[`placement-stage-more-actions-suite-only-flake`](./placement-stage-more-actions-suite-only-flake.md),
whose pre-registered reopen condition (the NAMED page-load message firing in a
gate run) was met on 2026-08-25.

**Related diagnosability gap.** `e2e/playwright.config.ts` sets `retries: 0`
with `trace: 'on-first-retry'`, so traces are never captured on a gate failure.
All four sightings of the stall so far have no network evidence, which is why
"was the request even sent?" is still open.
