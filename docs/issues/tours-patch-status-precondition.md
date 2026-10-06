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

**Update (2026-10-04, feat/tour-auto-close).** The server-side window is
closed for STATUS changes. The tour auto-close (spec
`docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md`, section
8) made PATCH read the tour CONSISTENTLY (`app/src/routes/tours.ts:1034`) and
write with a status precondition: `toursRepo.patch(tourId, patch, {
expectedStatus })` adds `status = <the status that read returned>` to its
`ConditionExpression` (`routes/tours.ts:1234`, `app/src/repos/toursRepo.ts:469-474`).
A STATUS change that lands between the PATCH's own read and its write (another
PATCH that changed status, a conversion finalize, the auto-close sweep) now
gets 409 `{ error: 'tour_changed', detail: 'This tour changed while you were
saving - reload and try again.' }` before any side effect
(`routes/tours.ts:1235-1249`) instead of being merged on top. Only status is
conditioned: a same-status write in that window (an exit-gate or reschedule
PATCH, a conversion claim) still merges as before. That same-status window is
pre-existing and still open (code review r1, AD-3): two exit-gate PATCHes on
one toured tour, the second landing between the first's read and its write,
both answer 200 and write two `tour_outcome` activity rows (the once-only
check reads the pre-patch outcome, `routes/tours.ts:1443`). The CLIENT's
stale-list window remains: the precondition
is the status the server read, not the one a list loaded minutes earlier
showed, and it does not compare `scheduledAt`, so on its own the server still
accepts `{ status: 'toured' }` on a tour a colleague canceled, marked no-show
or rebooked after the Past tab loaded (`canceled -> toured` and `no_show ->
toured` stay legal). The bulk runner's re-read (`markToured` in
`dashboard/src/routes/tours/ToursPage.tsx`) still guards that window, narrowed
to one eventually consistent round trip; the suggested fix above (the client
sends the status and time it saw) is what would close it. Status stays open.
