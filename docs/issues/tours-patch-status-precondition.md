---
id: tours-patch-status-precondition
title: PATCH /api/tours/:id has no expected-status precondition, so a read-then-write client cannot mark a tour toured atomically
type: improvement
severity: low
status: open
area: app/tours
created: 2026-09-27
refs: app/src/routes/tours.ts, app/src/repos/toursRepo.ts, dashboard/src/routes/tours/ToursPage.tsx
---

**Problem.** The Tours page's Past tab (spec
`docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md`, sections
4.5 and 9 Q14) marks tours toured with a client-side guard: re-read the tour,
PATCH `{ status: 'toured' }` only if it is still `scheduled` at the time the
list showed. The spec chose that over a server precondition on purpose (a
precondition touches the tours route contract for every caller). The
adversarial code review of 2026-09-27 (`docs/superpowers/reviews/2026-09-26-staff-notes-past-tours/review-r1-adversarial.md`,
A-2) proved on the in-memory harness what the window admits:

- `canceled -> { status: 'toured' }` and `no_show -> { status: 'toured' }`
  are both 200 and each writes a "Tour took place" milestone;
- a tour rebooked to a future date (a fresh reminder ladder armed) accepts
  `{ status: 'toured' }` and its pending rungs drop to 0 (the fresh ladder is
  swept).

Both reads are eventually consistent (the client's `GET /:tourId` and the
PATCH's own legality read, `app/src/routes/tours.ts`, `toursRepo.get` without
`ConsistentRead`), so the client re-read narrows the window to one round trip
plus replication lag at two layers; it cannot close it and the server cannot
refuse the late write. The single-tour actions on the tour page carry the
same class of window (pre-existing).

**Suggested fix.** Let PATCH `/api/tours/:id` take an optional precondition
(expected `status` and `scheduledAt`) that `toursRepo.patch` turns into a
DynamoDB `ConditionExpression`, answering 409 `tour_changed` when it fails
(the repo already has CAS precedents: `setLadderIdIf`, the roster version).
The Past tab's runner would then send ONE conditional PATCH per id with the
snapshot's values, map 409 to "Changed since the list loaded", and drop the
GET. A product decision first: the spec's Q14 accepted the client guard and
its residual (a tour marked no-show and revived at the same time between the
load and the click passes the guard, which is what the operator meant).
