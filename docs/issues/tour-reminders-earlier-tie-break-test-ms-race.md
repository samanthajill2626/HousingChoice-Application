---
id: tour-reminders-earlier-tie-break-test-ms-race
title: The tour-reminders "earlier[]" tie-break test builds its "identical" timestamps from two clock reads and flips when they straddle a millisecond
type: bug
severity: low
status: open
area: app/test
created: 2026-09-26
refs: app/test/tourRemindersApi.test.ts:1168, app/test/tourRemindersApi.test.ts:1195, app/test/tourRemindersApi.test.ts:1214, app/test/helpers/settingsStub.ts:53
---

**Problem.** `GET /api/tours/:tourId/reminders > earlier[] - the read partition
(S7) > orders by (sentAt ?? dueAt) DESC with reminderId as the tie-break`
(`app/test/tourRemindersApi.test.ts:1168`) seeds `rem-e-b` and `rem-e-d` with what
its comment calls a "byte-identical dueAt", so that only the reminderId tie-break
can order the pair. But each dueAt is its own call to `isoHoursFromNow(-2)`
(`:1195`, `:1214`), and that helper reads `Date.now()` on every call
(`app/test/helpers/settingsStub.ts:53-55`). When the two calls land in different
milliseconds - more likely on a loaded machine - `rem-e-d` gets the LATER dueAt,
the DESC sort puts it first, and the assertion fails with
`expected [ 'rem-e-d', 'rem-e-b', ... ] to deeply equal [ 'rem-e-b', 'rem-e-d', ... ]`.

Seen once on `feat/retry-send-window` @56085389 (planner's `npm test`,
2026-09-26 ~14:25 EDT, app workspace 374 of 375 files passed); the same commit's
previous full run passed. That branch does not touch the test, the tour
reminders route or its repository - the fixture race is on `main` as well.

**Suggested fix.** Compute the shared dueAt once
(`const due = isoHoursFromNow(-2);`) and pass the same string to both reminders,
as the comment already intends.
